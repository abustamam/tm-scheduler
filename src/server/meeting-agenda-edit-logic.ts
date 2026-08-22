/**
 * Per-meeting agenda editing (configurable agendas, Phase 2).
 *
 * A templated meeting owns a PRIVATE `meeting_templates` row (`meeting_id` non
 * null, created by `copyTemplateForMeeting`), so editing an agenda is editing
 * that copy and reaches no other meeting.
 *
 * A `*-logic.ts` module for the two reasons this repo documents: a top-level
 * db-touching export in a server-fn module drags `#/db` → `pg` → `Buffer` into
 * the client bundle, and a query living only inside a `createServerFn` handler
 * is unreachable from vitest — which for a module of gates is the whole ball
 * game.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { db as database } from "#/db";
import {
	guests,
	meetings,
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
	members,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { generateSlotRows } from "#/lib/agenda";
import {
	isMeetingLocked,
	MEETING_LOCKED_MESSAGE,
} from "#/lib/meeting-lifecycle";
import {
	MAX_ROLE_REPEAT_SLOTS,
	MAX_TEMPLATE_BEATS,
	MAX_TEMPLATE_DETAIL_CHARS,
	MAX_TEMPLATE_LABEL_CHARS,
	MAX_TEMPLATE_ROLES,
} from "#/lib/meeting-template-limits";
import { logActivity } from "./activity";
import {
	copyTemplateForMeeting,
	type DbOrTx,
	materializeTemplateRoles,
	type ReleasedHolder,
} from "./meeting-templates-logic";

export type { ReleasedHolder };

export type AgendaDraftRow = {
	id: string;
	sortOrder: number;
	kind: "section" | "role" | "event";
	label: string;
	detail: string | null;
	minutes: number;
	roleKey: string | null;
	repeatsRoleKey: string | null;
	markGreen: number | null;
	markYellow: number | null;
	markRed: number | null;
};

export type AgendaDraftRole = {
	key: string;
	name: string;
	category: "leadership" | "speaker" | "evaluator" | "functionary";
	defaultCount: number;
	isSpeakerRole: boolean;
};

export type AgendaDraft = {
	templateId: string;
	templateName: string;
	/** False once the meeting is locked. The rows still load — an agenda is
	 *  worth reading after the night, it just stops being writable. */
	editable: boolean;
	rows: AgendaDraftRow[];
	roles: AgendaDraftRole[];
};

/**
 * Whether a meeting's agenda may currently be edited: not locked (completed)
 * and not cancelled. Shared by `loadAgendaDraft` (what `editable` reports) and
 * `ensureAgendaDraft` (what a write actually allows) so the two cannot drift.
 * They did, briefly: `editable` was `!isMeetingLocked` alone, so a cancelled
 * meeting rendered a fully interactive editor whose every save threw.
 */
function agendaEditable(status: string): boolean {
	return !isMeetingLocked(status) && status !== "cancelled";
}

/**
 * This meeting's editable agenda, or null when it has none.
 *
 * Null means STANDARD: a meeting with `template_id IS NULL` renders the
 * code-derived `RUN_OF_SHOW`, which this editor deliberately does not touch.
 *
 * `meeting.templateId` is read here WITHOUT requiring it to be the meeting's
 * own private copy (`meeting_templates.meeting_id = meetingId`). A meeting
 * converted before this feature landed points straight at a SHARED template
 * instead — Task 6 returned null for that case on the theory that
 * `ensureAgendaDraft` would upgrade it on first write, but that is circular:
 * the route redirects away on null, so the officer never reaches a write, and
 * the upgrade that only fires on write never fires either — for every such
 * meeting, which in production is all of them. Reading it directly is safe
 * either way: `meeting.templateId` is not caller-supplied, it is the meeting's
 * OWN pointer, and the content is exactly what the meeting page already
 * renders. `ensureAgendaDraft` still forks a private copy, just on the first
 * WRITE rather than the first read.
 */
export async function loadAgendaDraft(
	meetingId: string,
): Promise<AgendaDraft | null> {
	const [meeting] = await database
		.select({ templateId: meetings.templateId, status: meetings.status })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!meeting?.templateId) return null;

	const [tpl] = await database
		.select({ id: meetingTemplates.id, name: meetingTemplates.name })
		.from(meetingTemplates)
		.where(eq(meetingTemplates.id, meeting.templateId))
		.limit(1);
	// Only reachable if the pointer is corrupt: `meetings.template_id` is ON
	// DELETE RESTRICT against `meeting_templates`, so the row a live pointer
	// names cannot have been deleted.
	if (!tpl) return null;

	const [rows, roles] = await Promise.all([
		database
			.select({
				id: meetingTemplateBeats.id,
				sortOrder: meetingTemplateBeats.sortOrder,
				kind: meetingTemplateBeats.kind,
				label: meetingTemplateBeats.label,
				detail: meetingTemplateBeats.detail,
				minutes: meetingTemplateBeats.minutes,
				roleKey: meetingTemplateBeats.roleKey,
				repeatsRoleKey: meetingTemplateBeats.repeatsRoleKey,
				markGreen: meetingTemplateBeats.markGreen,
				markYellow: meetingTemplateBeats.markYellow,
				markRed: meetingTemplateBeats.markRed,
			})
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, tpl.id))
			.orderBy(asc(meetingTemplateBeats.sortOrder)),
		database
			.select({
				key: meetingTemplateRoles.key,
				name: meetingTemplateRoles.name,
				category: meetingTemplateRoles.category,
				defaultCount: meetingTemplateRoles.defaultCount,
				isSpeakerRole: meetingTemplateRoles.isSpeakerRole,
			})
			.from(meetingTemplateRoles)
			.where(eq(meetingTemplateRoles.templateId, tpl.id))
			.orderBy(asc(meetingTemplateRoles.sortOrder)),
	]);

	return {
		templateId: tpl.id,
		templateName: tpl.name,
		editable: agendaEditable(meeting.status),
		rows,
		roles,
	};
}

// ---------------------------------------------------------------------------
// Writes — every mutator below is scoped to the CALLING meeting's own private
// template. The row id is caller-supplied, so without that scoping an officer
// of one club could edit another club's agenda by naming its row id.
// ---------------------------------------------------------------------------

/** What `ensureAgendaDraft` resolved: the meeting's own private template id,
 *  and whether this call is the one that just forked it. */
export type AgendaDraftHandle = {
	templateId: string;
	/** True only on the call that performed the copy. Callers use this to
	 *  decide how to re-locate a caller-supplied row: unchanged (match by id)
	 *  when the template was already private, or translated by sortOrder
	 *  (see `findRow`) when this call just replaced it with a fresh copy
	 *  carrying entirely new row ids. */
	forked: boolean;
};

/**
 * The meeting's own private template id, or a thrown error. Reports whether
 * it just forked one (see `AgendaDraftHandle`) — Task 8 also calls this, so
 * its signature is `Promise<AgendaDraftHandle>`, not the bare `Promise<string>`
 * the brief specified; a bare string had no way to tell a caller which
 * matching strategy is safe (see the mutators below and finding #3 in the
 * task-7 fix-round report).
 *
 * Upgrades on first write: a meeting converted before this feature points at a
 * SHARED template, and editing that would rewrite the agenda for every club
 * using it. Rather than refuse, the first edit copies it — the officer's
 * intent is to change THIS meeting, and the copy is exactly what makes that
 * true. (This is also what `loadAgendaDraft`'s docblock refers to as the
 * upgrade happening on WRITE rather than on read.)
 *
 * MUST be called inside a transaction. It may call `copyTemplateForMeeting`,
 * which is itself multi-statement and NOT self-transactional (its own
 * docblock says so explicitly) — calling this outside a transaction risks a
 * mid-copy failure leaving a template row with partial roles and beats while
 * `meetings.template_id` already points at it. Every caller in this module
 * runs it inside `database.transaction`; a new caller should too.
 */
export async function ensureAgendaDraft(
	conn: DbOrTx,
	meetingId: string,
): Promise<AgendaDraftHandle> {
	const [meeting] = await conn
		.select({
			templateId: meetings.templateId,
			clubId: meetings.clubId,
			status: meetings.status,
		})
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!meeting) throw new Error("Meeting not found.");
	if (!meeting.templateId) {
		throw new Error(
			"Only a meeting with a meeting type can have its agenda edited.",
		);
	}
	// Same predicate `loadAgendaDraft` reports as `editable` — see
	// `agendaEditable`'s docblock for why these two must share one definition.
	if (!agendaEditable(meeting.status)) {
		throw new Error(
			isMeetingLocked(meeting.status)
				? MEETING_LOCKED_MESSAGE
				: "A cancelled meeting's agenda cannot be edited.",
		);
	}

	const [own] = await conn
		.select({ id: meetingTemplates.id })
		.from(meetingTemplates)
		.where(
			and(
				eq(meetingTemplates.id, meeting.templateId),
				eq(meetingTemplates.meetingId, meetingId),
			),
		)
		.limit(1);
	if (own) return { templateId: own.id, forked: false };

	const copyId = await copyTemplateForMeeting(conn, {
		sourceTemplateId: meeting.templateId,
		clubId: meeting.clubId,
		meetingId,
	});
	await conn
		.update(meetings)
		.set({ templateId: copyId })
		.where(eq(meetings.id, meetingId));
	return { templateId: copyId, forked: true };
}

/** Cap by CODE POINTS, not UTF-16 units — see `capChars` in
 *  `agenda-template-rows.ts`. Slicing a surrogate pair in half yields a lone
 *  surrogate that renders as a replacement glyph and makes
 *  `encodeURIComponent` throw for any consumer building a URL from it (#522).
 *  Enforced here too, at the writer, so an officer cannot build a template the
 *  renderer's own cap would then silently truncate. */
function assertWithin(value: string, max: number, what: string): void {
	if ([...value].length > max) {
		throw new Error(`That ${what} is too long (max ${max} characters).`);
	}
}

type MarkFields = {
	markGreen: number | null;
	markYellow: number | null;
	markRed: number | null;
};

/**
 * All three marks or none, checked against the MERGED result — the row as it
 * will read AFTER this patch applies — not the patch in isolation.
 * `resolveMarks` (agenda-template-rows.ts) treats all-three-or-none as the
 * contract and drops a partial set silently; a timer card with a hole in it
 * is worse than no card, so the writer refuses rather than the renderer
 * discarding.
 *
 * Checking the patch alone is wrong in BOTH directions. `{markGreen: null}`
 * against a row already holding (2,3,4) touches one key with value null —
 * zero "set" values in the patch alone, which a patch-only check waves
 * through as "none" — but the row ends up (null,3,4), the exact silent hole
 * this function exists to refuse. Symmetrically, `{markGreen:2,
 * markYellow:3}` against a row already holding `markRed:4` touches two keys
 * both non-null — a patch-only check refuses it as "partial" — but the
 * MERGED result is complete and should be accepted.
 */
function assertMarks(current: MarkFields, patch: Partial<MarkFields>): void {
	const keys = ["markGreen", "markYellow", "markRed"] as const;
	const merged = keys.map((k) =>
		k in patch ? (patch[k] ?? null) : current[k],
	);
	const set = merged.filter((v) => v != null).length;
	if (set !== 0 && set !== 3) {
		throw new Error("Timing marks need all three values, or none.");
	}
}

/**
 * `roleKey` / `repeatsRoleKey` must name a role this template actually
 * declares, or be left null. `agenda-template-rows.ts`'s `toRow` documents
 * the read-side consequence of skipping this check: "A beat naming a role the
 * template does not declare is dropped rather than rendered against an
 * invented name... Phase 2's editor needs a validation error." Without this,
 * setting a role beat's `roleKey` to an undeclared value doesn't error at
 * all — it makes the beat silently vanish from the printed agenda, the
 * projected deck and the `.pptx`.
 *
 * Checked against the template's declared keys inside the SAME transaction,
 * after `ensureAgendaDraft` resolves the FINAL templateId — a fork copies
 * `meeting_template_roles` too, so the declared set is fresh for whichever
 * template (shared source or new private copy) the row is about to belong to.
 */
async function assertDeclaredRoleKeys(
	conn: DbOrTx,
	templateId: string,
	patch: { roleKey?: string | null; repeatsRoleKey?: string | null },
): Promise<void> {
	const named = [patch.roleKey, patch.repeatsRoleKey].filter(
		(k): k is string => k != null,
	);
	if (named.length === 0) return;
	const declared = await conn
		.select({ key: meetingTemplateRoles.key })
		.from(meetingTemplateRoles)
		.where(eq(meetingTemplateRoles.templateId, templateId));
	const declaredKeys = new Set(declared.map((d) => d.key));
	for (const key of named) {
		if (!declaredKeys.has(key)) {
			throw new Error(`"${key}" is not a role this template declares.`);
		}
	}
}

/**
 * Reassign 0..N-1 to `orderedIds`, the full row set of one template, in the
 * given order.
 *
 * `meeting_template_beats_order_unique` is a plain, immediately-checked unique
 * index on `(template_id, sort_order)` — not deferrable — so writing the
 * target positions directly collides on almost every reorder: moving row 2
 * into slot 0 tries to give it the same value a still-untouched row already
 * holds, mid-transaction, before this function gets a chance to move that row
 * out of the way. Two passes fix it: first relocate every row to a distinct
 * NEGATIVE value (impossible to collide with the never-negative 0..N-1 target
 * range, and pairwise distinct from each other by construction), then assign
 * the real final position — by then nothing else occupies 0..N-1. Every writer
 * in this module keeps `sortOrder` at 0..N-1 with no gaps, so the negative
 * range can never already be in use.
 */
async function renumberRows(
	conn: DbOrTx,
	templateId: string,
	orderedIds: string[],
): Promise<void> {
	if (orderedIds.length === 0) return;
	const floor = -orderedIds.length - 1;
	for (const [i, id] of orderedIds.entries()) {
		await conn
			.update(meetingTemplateBeats)
			.set({ sortOrder: floor - i })
			.where(
				and(
					eq(meetingTemplateBeats.id, id),
					// `templateId` here is REDUNDANT, not load-bearing: the match is by
					// `id`, a primary key, so this conjunct cannot change which row is
					// selected and no test can distinguish its presence from its
					// absence — that would be the exact assertion-that-cannot-fail
					// review flagged elsewhere in this module. Kept as stated intent /
					// defense-in-depth for a caller that isn't this module's own three
					// mutators, all of which source `orderedIds` from `loadRowIds(tx,
					// templateId)` or a row just inserted with that same `templateId`.
					// TRIGGER: if this ever changes to match by `sortOrder` instead of
					// `id` (the way the mutators' OWN final statements do on the
					// forked path — see `findRow`'s docblock), this conjunct becomes
					// load-bearing exactly the way theirs is, and needs the same
					// foreign-row-at-the-same-sortOrder test they have.
					eq(meetingTemplateBeats.templateId, templateId),
				),
			);
	}
	for (const [i, id] of orderedIds.entries()) {
		await conn
			.update(meetingTemplateBeats)
			.set({ sortOrder: i })
			.where(
				and(
					eq(meetingTemplateBeats.id, id),
					eq(meetingTemplateBeats.templateId, templateId),
				),
			);
	}
}

/** This template's row ids, in `sortOrder`. */
async function loadRowIds(
	conn: DbOrTx,
	templateId: string,
): Promise<{ id: string; sortOrder: number }[]> {
	return conn
		.select({
			id: meetingTemplateBeats.id,
			sortOrder: meetingTemplateBeats.sortOrder,
		})
		.from(meetingTemplateBeats)
		.where(eq(meetingTemplateBeats.templateId, templateId))
		.orderBy(asc(meetingTemplateBeats.sortOrder));
}

/** A caller-supplied row's current state, as resolved by `findRow`. */
type RowLookup = { sortOrder: number } & MarkFields;

/**
 * A caller-supplied row's current state, resolved against the meeting's
 * CURRENT `meetings.template_id` pointer — BEFORE `ensureAgendaDraft` runs.
 * Null when the row does not belong to this meeting (wrong template, or a
 * meeting with no template at all).
 *
 * This has to run before the fork, not after, for two reasons at once. First,
 * tenancy: rejecting here means a foreign row never triggers a fork write at
 * all — a bad-actor request touches nothing. Second, and the reason this
 * resolves `sortOrder` rather than trusting the id outright: `loadAgendaDraft`
 * now returns a SHARED template's own content for a meeting that has not been
 * edited yet (correction 1), so the row ids an officer is acting on may be
 * the shared template's — and `ensureAgendaDraft` is about to replace that
 * pointer with a private copy carrying entirely new row ids.
 * `copyTemplateForMeeting` preserves `sort_order` verbatim, and the
 * `(template_id, sort_order)` unique index guarantees at most one row per
 * value, so capturing the PRE-fork sortOrder and re-finding it in the
 * POST-fork template (see `ensureAgendaDraft`'s `forked` flag and the
 * mutators below) is what makes a meeting's very first edit land on the row
 * the officer actually clicked, instead of erroring or silently misfiring.
 *
 * The mutators use the `sortOrder` translation ONLY on that one-time forked
 * path, and match by `id` otherwise. Matching by sortOrder unconditionally
 * would reopen a different bug: `findRow` and a mutator's own final statement
 * are separate round trips under READ COMMITTED, so a concurrent renumber
 * that commits in between could leave the target sortOrder pointing at a
 * DIFFERENT row by the time the final statement runs — no error, no unique
 * violation, just a wrong-row write. `id` is immutable and never reassigned
 * by a renumber, so matching by id has no such window; sortOrder-matching is
 * safe only for a row this SAME transaction just created a moment earlier,
 * which no concurrent transaction can have touched (it isn't committed yet).
 *
 * Also returns the row's CURRENT marks, so a mark patch can be validated
 * against the row as it will read AFTER the patch — see `assertMarks`.
 */
async function findRow(
	conn: DbOrTx,
	meetingId: string,
	rowId: string,
): Promise<RowLookup | null> {
	const [meeting] = await conn
		.select({ templateId: meetings.templateId })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!meeting?.templateId) return null;
	const [row] = await conn
		.select({
			sortOrder: meetingTemplateBeats.sortOrder,
			markGreen: meetingTemplateBeats.markGreen,
			markYellow: meetingTemplateBeats.markYellow,
			markRed: meetingTemplateBeats.markRed,
		})
		.from(meetingTemplateBeats)
		.where(
			and(
				eq(meetingTemplateBeats.id, rowId),
				eq(meetingTemplateBeats.templateId, meeting.templateId),
			),
		)
		.limit(1);
	return row ?? null;
}

/**
 * Add a row to the meeting's agenda, immediately after `afterRowId` (or at
 * the end, when null), and return it.
 *
 * Refuses past `MAX_TEMPLATE_BEATS`: that cap is enforced at
 * `loadTemplateBeats`, the one seam every renderer reads a template through,
 * but enforcing it there ALONE means an officer could build a template the
 * renderer then silently truncates. Enforced here too, at the writer.
 */
export async function addAgendaRow(input: {
	meetingId: string;
	afterRowId: string | null;
	kind: "section" | "role" | "event";
}): Promise<AgendaDraftRow> {
	return database.transaction(async (tx) => {
		// Resolved against the PRE-fork pointer — see `findRow`.
		const afterRow =
			input.afterRowId === null
				? null
				: await findRow(tx, input.meetingId, input.afterRowId);
		if (input.afterRowId !== null && afterRow === null) {
			throw new Error("That agenda row is not part of this meeting.");
		}

		const { templateId, forked } = await ensureAgendaDraft(tx, input.meetingId);
		const rows = await loadRowIds(tx, templateId);
		if (rows.length >= MAX_TEMPLATE_BEATS) {
			throw new Error(
				`This agenda is too long (max ${MAX_TEMPLATE_BEATS} rows).`,
			);
		}

		// By id when the template was already private (exact, and immune to a
		// concurrent renumber — see `findRow`'s docblock); by sortOrder only on
		// the one-time translation across a fork this same call just performed.
		const at =
			afterRow === null
				? rows.length
				: rows.findIndex((r) =>
						forked
							? r.sortOrder === afterRow.sortOrder
							: r.id === input.afterRowId,
					) + 1;
		if (afterRow !== null && at === 0) {
			// Resolved above against the pre-fork pointer, so a miss here would
			// mean the fork failed to preserve a row's sortOrder — corruption,
			// not a normal "not found".
			throw new Error("Failed to place the new agenda row.");
		}

		// A temp sortOrder strictly above every existing row's, so the INSERT
		// itself can never collide with the unique index — `renumberRows` below
		// then moves everything (this new row included) to its real position.
		const maxSort = rows.reduce((m, r) => Math.max(m, r.sortOrder), -1);
		const [created] = await tx
			.insert(meetingTemplateBeats)
			.values({
				templateId,
				sortOrder: maxSort + 1,
				kind: input.kind,
				label: input.kind === "section" ? "NEW SECTION" : "New item",
				minutes: 0,
			})
			.returning({ id: meetingTemplateBeats.id });
		if (!created) throw new Error("Failed to add the agenda row.");

		const reorderedIds = rows.map((r) => r.id);
		reorderedIds.splice(at, 0, created.id);
		await renumberRows(tx, templateId, reorderedIds);

		const [row] = await tx
			.select()
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.id, created.id))
			.limit(1);
		if (!row) throw new Error("Failed to add the agenda row.");
		return {
			id: row.id,
			sortOrder: row.sortOrder,
			kind: row.kind,
			label: row.label,
			detail: row.detail,
			minutes: row.minutes,
			roleKey: row.roleKey,
			repeatsRoleKey: row.repeatsRoleKey,
			markGreen: row.markGreen,
			markYellow: row.markYellow,
			markRed: row.markRed,
		};
	});
}

/** Edit a row's content. Cheap, DB-free validation up front; state-dependent
 *  validation (marks, declared role keys) and the write itself happen inside
 *  the transaction, scoped to the caller's own template. */
export async function updateAgendaRow(input: {
	meetingId: string;
	rowId: string;
	patch: Partial<
		Pick<
			AgendaDraftRow,
			| "label"
			| "detail"
			| "minutes"
			| "roleKey"
			| "repeatsRoleKey"
			| "markGreen"
			| "markYellow"
			| "markRed"
		>
	>;
}): Promise<void> {
	const { patch } = input;
	if (Object.keys(patch).length === 0) {
		throw new Error("Nothing to update.");
	}
	if (patch.label != null) {
		assertWithin(patch.label, MAX_TEMPLATE_LABEL_CHARS, "label");
	}
	if (patch.detail != null) {
		assertWithin(patch.detail, MAX_TEMPLATE_DETAIL_CHARS, "note");
	}
	if (patch.roleKey != null) {
		assertWithin(patch.roleKey, MAX_TEMPLATE_LABEL_CHARS, "role reference");
	}
	if (patch.repeatsRoleKey != null) {
		assertWithin(
			patch.repeatsRoleKey,
			MAX_TEMPLATE_LABEL_CHARS,
			"repeat-role reference",
		);
	}
	if (patch.minutes != null && (patch.minutes < 0 || patch.minutes > 600)) {
		throw new Error("Minutes must be between 0 and 600.");
	}

	await database.transaction(async (tx) => {
		// Resolved against the PRE-fork pointer — see `findRow`.
		const found = await findRow(tx, input.meetingId, input.rowId);
		if (!found) {
			throw new Error("That agenda row is not part of this meeting.");
		}
		// Validated against the row as it will read AFTER this patch, not the
		// patch in isolation — see `assertMarks`.
		assertMarks(found, patch);

		const { templateId, forked } = await ensureAgendaDraft(tx, input.meetingId);
		// Against the FINAL templateId: a fork copies meeting_template_roles too,
		// so this is the fresh declared set for whichever template the row is
		// about to belong to.
		await assertDeclaredRoleKeys(tx, templateId, patch);

		// By id when the template was already private (exact, and immune to a
		// concurrent renumber — see `findRow`'s docblock); by sortOrder only on
		// the one-time translation across a fork this same call just performed.
		const rowFilter = forked
			? eq(meetingTemplateBeats.sortOrder, found.sortOrder)
			: eq(meetingTemplateBeats.id, input.rowId);
		// Scoped to THIS meeting's template either way: the row id is
		// caller-supplied, and without the template predicate an officer of one
		// club could edit another's agenda by id.
		const updated = await tx
			.update(meetingTemplateBeats)
			.set(patch)
			.where(and(eq(meetingTemplateBeats.templateId, templateId), rowFilter))
			.returning({ id: meetingTemplateBeats.id });
		if (updated.length === 0) {
			throw new Error("That agenda row is not part of this meeting.");
		}
	});
}

/** Remove a row and close the gap in `sortOrder`. */
export async function removeAgendaRow(input: {
	meetingId: string;
	rowId: string;
}): Promise<void> {
	await database.transaction(async (tx) => {
		const found = await findRow(tx, input.meetingId, input.rowId);
		if (!found) {
			throw new Error("That agenda row is not part of this meeting.");
		}
		const { templateId, forked } = await ensureAgendaDraft(tx, input.meetingId);
		const rowFilter = forked
			? eq(meetingTemplateBeats.sortOrder, found.sortOrder)
			: eq(meetingTemplateBeats.id, input.rowId);
		const deleted = await tx
			.delete(meetingTemplateBeats)
			.where(and(eq(meetingTemplateBeats.templateId, templateId), rowFilter))
			.returning({ id: meetingTemplateBeats.id });
		if (deleted.length === 0) {
			throw new Error("That agenda row is not part of this meeting.");
		}
		const rest = await loadRowIds(tx, templateId);
		await renumberRows(
			tx,
			templateId,
			rest.map((r) => r.id),
		);
	});
}

/** Swap a row with its immediate neighbour. A no-op past either end. */
export async function moveAgendaRow(input: {
	meetingId: string;
	rowId: string;
	direction: "up" | "down";
}): Promise<void> {
	await database.transaction(async (tx) => {
		const found = await findRow(tx, input.meetingId, input.rowId);
		if (!found) {
			throw new Error("That agenda row is not part of this meeting.");
		}
		const { templateId, forked } = await ensureAgendaDraft(tx, input.meetingId);
		const rows = await loadRowIds(tx, templateId);
		const at = rows.findIndex((r) =>
			forked ? r.sortOrder === found.sortOrder : r.id === input.rowId,
		);
		if (at === -1) {
			// Same corruption guard as `addAgendaRow`'s post-resolution check.
			throw new Error("That agenda row is not part of this meeting.");
		}
		const to = input.direction === "up" ? at - 1 : at + 1;
		if (to < 0 || to >= rows.length) return;

		const reorderedIds = rows.map((r) => r.id);
		const [moved] = reorderedIds.splice(at, 1);
		if (!moved) return;
		reorderedIds.splice(to, 0, moved);
		await renumberRows(tx, templateId, reorderedIds);
	});
}

// ---------------------------------------------------------------------------
// Roles — adding and removing the roles a meeting's own template declares.
// Beats bind to a role by KEY (`roleKey` / `repeatsRoleKey`), and a key is
// stable across a fork (`copyTemplateForMeeting` preserves it verbatim) —
// unlike a row id, it needs no pre-fork/post-fork translation, so these
// mutators resolve straight off `ensureAgendaDraft`'s `templateId` with no
// `forked` branching at all.
// ---------------------------------------------------------------------------

/** `Zoom Master` → `zoom_master`, uniquified against the template's own keys.
 *  Keys are the stable, rename-proof identity every surface binds on (#368), so
 *  they are derived once at creation and never follow a later rename. */
function deriveRoleKey(name: string, taken: Set<string>): string {
	const base =
		[...name.toLowerCase()]
			.map((c) => (/[a-z0-9]/.test(c) ? c : "_"))
			.join("")
			.replace(/_+/g, "_")
			.replace(/^_|_$/g, "") || "role";
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base}_${n}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/**
 * Add a role to the meeting's own template and materialize it immediately.
 * A role with no `role_definitions` row can never own a slot
 * (`role_slots.role_definition_id` is NOT NULL and restricting), so an
 * unmaterialized role would be a row nobody could ever sign up for.
 */
export async function addAgendaRole(input: {
	meetingId: string;
	name: string;
	category: "leadership" | "speaker" | "evaluator" | "functionary";
	defaultCount: number;
	isSpeakerRole: boolean;
}): Promise<AgendaDraftRole> {
	assertWithin(input.name, MAX_TEMPLATE_LABEL_CHARS, "role name");
	if (input.defaultCount < 0 || input.defaultCount > MAX_ROLE_REPEAT_SLOTS) {
		throw new Error(
			`A role can have between 0 and ${MAX_ROLE_REPEAT_SLOTS} places.`,
		);
	}

	return database.transaction(async (tx) => {
		const { templateId } = await ensureAgendaDraft(tx, input.meetingId);
		const [meeting] = await tx
			.select({ clubId: meetings.clubId })
			.from(meetings)
			.where(eq(meetings.id, input.meetingId))
			.limit(1);
		if (!meeting) throw new Error("Meeting not found.");

		const existing = await tx
			.select({
				key: meetingTemplateRoles.key,
				sortOrder: meetingTemplateRoles.sortOrder,
			})
			.from(meetingTemplateRoles)
			.where(eq(meetingTemplateRoles.templateId, templateId));
		if (existing.length >= MAX_TEMPLATE_ROLES) {
			throw new Error(
				`This agenda has too many roles (max ${MAX_TEMPLATE_ROLES}).`,
			);
		}
		const key = deriveRoleKey(input.name, new Set(existing.map((r) => r.key)));
		const sortOrder =
			existing.reduce((max, r) => Math.max(max, r.sortOrder), 0) + 10;

		await tx.insert(meetingTemplateRoles).values({
			templateId,
			key,
			name: input.name,
			category: input.category,
			defaultCount: input.defaultCount,
			sortOrder,
			isSpeakerRole: input.isSpeakerRole,
		});
		// Materialize so the role is claimable — see the docblock above.
		await materializeTemplateRoles(tx, meeting.clubId, templateId);

		const defs = await tx
			.select({
				id: roleDefinitions.id,
				defaultCount: roleDefinitions.defaultCount,
				enabled: roleDefinitions.enabled,
			})
			.from(roleDefinitions)
			.where(
				and(
					eq(roleDefinitions.clubId, meeting.clubId),
					eq(roleDefinitions.templateId, templateId),
					eq(roleDefinitions.key, key),
				),
			);
		const rows = generateSlotRows(defs, input.meetingId);
		if (rows.length > 0) await tx.insert(roleSlots).values(rows);

		return {
			key,
			name: input.name,
			category: input.category,
			defaultCount: input.defaultCount,
			isSpeakerRole: input.isSpeakerRole,
		};
	});
}

/**
 * Who a role removal would release, WITHOUT removing anything. PURE READ —
 * the same rule `planTemplateConversion` follows: showing an officer what a
 * change would do must not itself change anything. The dialog leads with
 * names because a released holder cannot be told afterwards: `notifications
 * .slot_id` is NOT NULL and ON DELETE CASCADE to `role_slots`, so a row
 * enqueued against a slot the same transaction deletes is destroyed before
 * the poller could ever see it.
 *
 * Scoped by `roleSlots.meetingId` first, then joined to `roleDefinitions` by
 * exact id — once a slot is pinned to this one meeting, which role it names
 * cannot resolve to a different club's row; there is no id here for a caller
 * to spoof; `roleKey` only narrows WHICH of this meeting's own roles to read.
 */
export async function planRoleRemoval(input: {
	meetingId: string;
	roleKey: string;
}): Promise<ReleasedHolder[]> {
	const [meeting] = await database
		.select({ clubId: meetings.clubId, templateId: meetings.templateId })
		.from(meetings)
		.where(eq(meetings.id, input.meetingId))
		.limit(1);
	if (!meeting?.templateId) return [];

	const rows = await database
		.select({
			memberId: roleSlots.assignedMemberId,
			guestId: roleSlots.assignedGuestId,
			memberName: members.name,
			guestName: guests.name,
			roleName: roleDefinitions.name,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.leftJoin(members, eq(members.id, roleSlots.assignedMemberId))
		.leftJoin(guests, eq(guests.id, roleSlots.assignedGuestId))
		.where(
			and(
				eq(roleSlots.meetingId, input.meetingId),
				eq(roleDefinitions.templateId, meeting.templateId),
				eq(roleDefinitions.key, input.roleKey),
			),
		);

	return rows
		.filter((r) => r.memberId != null || r.guestId != null)
		.map((r) => ({
			memberId: r.memberId,
			guestId: r.guestId,
			name: r.memberName ?? r.guestName ?? "Someone",
			roleName: r.roleName,
		}));
}

/**
 * Remove a role from the meeting's own template: its `role_definitions` row,
 * its slots (released before they disappear, same as
 * `applyTemplateConversion`), and every beat bound to it — by `roleKey` (the
 * beat IS the role's own row) AND by `repeatsRoleKey` (a beat inside that
 * role's repeat block that names it without owning it — e.g. the contest's
 * ballot minute). `buildTemplateRows` drops a beat naming an undeclared role
 * rather than rendering it, so leaving either binding behind is an invisible
 * row that would silently reappear if the key were ever reused.
 *
 * Scoped by the CALLING meeting's own resolved `templateId` throughout — a
 * private template's id is unique per meeting (`copyTemplateForMeeting`
 * always mints a fresh row on fork), so a foreign meeting's identically-keyed
 * role can never match it. `clubId` is included on the `role_definitions`
 * predicate for the same reason `roleDefScope` always pairs the two:
 * consistency with the one seam every other role-definition query in this
 * codebase scopes through — not because a same-`templateId` collision across
 * clubs is reachable today (materialization only ever targets a private
 * per-meeting template; see `materializeTemplateRoles`'s two call sites).
 *
 * Rejects an undeclared `roleKey` BEFORE `ensureAgendaDraft` runs, against the
 * meeting's current (possibly still-shared) template — the same reason
 * `addAgendaRow`/`updateAgendaRow` resolve a caller-supplied row before
 * forking (`findRow`'s docblock): a fork is a real write (it repoints
 * `meetings.template_id`), and a bad key should not trigger one for a
 * no-op removal. `roleKey` is stable across a fork, so this pre-fork read is
 * exact, not an approximation later reconciled.
 */
export async function removeAgendaRole(input: {
	meetingId: string;
	roleKey: string;
	actorMemberId: string | null;
}): Promise<ReleasedHolder[]> {
	const [meeting] = await database
		.select({ templateId: meetings.templateId })
		.from(meetings)
		.where(eq(meetings.id, input.meetingId))
		.limit(1);
	if (!meeting?.templateId) {
		throw new Error(
			"Only a meeting with a meeting type can have its agenda edited.",
		);
	}
	const [declared] = await database
		.select({ key: meetingTemplateRoles.key })
		.from(meetingTemplateRoles)
		.where(
			and(
				eq(meetingTemplateRoles.templateId, meeting.templateId),
				eq(meetingTemplateRoles.key, input.roleKey),
			),
		)
		.limit(1);
	if (!declared) {
		throw new Error(`"${input.roleKey}" is not a role this template declares.`);
	}

	const released = await planRoleRemoval({
		meetingId: input.meetingId,
		roleKey: input.roleKey,
	});

	await database.transaction(async (tx) => {
		const { templateId } = await ensureAgendaDraft(tx, input.meetingId);
		const [meeting] = await tx
			.select({ clubId: meetings.clubId })
			.from(meetings)
			.where(eq(meetings.id, input.meetingId))
			.limit(1);
		if (!meeting) throw new Error("Meeting not found.");

		const defs = await tx
			.select({ id: roleDefinitions.id })
			.from(roleDefinitions)
			.where(
				and(
					eq(roleDefinitions.clubId, meeting.clubId),
					eq(roleDefinitions.templateId, templateId),
					eq(roleDefinitions.key, input.roleKey),
				),
			);
		const defIds = defs.map((d) => d.id);
		if (defIds.length > 0) {
			// Release, then delete — "a slot is released before it disappears"
			// stays true at every intermediate state. The speech is Person-owned
			// (ADR-0009), so it survives regardless.
			await tx
				.update(roleSlots)
				.set({
					assignedMemberId: null,
					assignedGuestId: null,
					speechId: null,
					status: "open",
					claimedAt: null,
				})
				.where(
					and(
						eq(roleSlots.meetingId, input.meetingId),
						inArray(roleSlots.roleDefinitionId, defIds),
					),
				);
			await tx
				.delete(roleSlots)
				.where(
					and(
						eq(roleSlots.meetingId, input.meetingId),
						inArray(roleSlots.roleDefinitionId, defIds),
					),
				);
			await tx
				.delete(roleDefinitions)
				.where(inArray(roleDefinitions.id, defIds));
		}

		// Both binding shapes named in the docblock above: the role's own row
		// (`roleKey`), and any row inside its repeat block that names it only via
		// `repeatsRoleKey` (correction 2 — the brief handled `roleKey` alone).
		await tx
			.delete(meetingTemplateBeats)
			.where(
				and(
					eq(meetingTemplateBeats.templateId, templateId),
					eq(meetingTemplateBeats.roleKey, input.roleKey),
				),
			);
		await tx
			.delete(meetingTemplateBeats)
			.where(
				and(
					eq(meetingTemplateBeats.templateId, templateId),
					eq(meetingTemplateBeats.repeatsRoleKey, input.roleKey),
				),
			);
		await tx
			.delete(meetingTemplateRoles)
			.where(
				and(
					eq(meetingTemplateRoles.templateId, templateId),
					eq(meetingTemplateRoles.key, input.roleKey),
				),
			);

		await logActivity(tx, {
			clubId: meeting.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_agenda_role_removed",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: { roleKey: input.roleKey, released: released.length },
		});
	});

	return released;
}
