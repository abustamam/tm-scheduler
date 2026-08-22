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
import { and, asc, eq } from "drizzle-orm";
import { db as database } from "#/db";
import {
	meetings,
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
} from "#/db/schema";
import { isMeetingLocked } from "#/lib/meeting-lifecycle";
import {
	MAX_TEMPLATE_BEATS,
	MAX_TEMPLATE_DETAIL_CHARS,
	MAX_TEMPLATE_LABEL_CHARS,
} from "#/lib/meeting-template-limits";
import { assertMeetingNotLocked } from "./meeting-authz-logic";
import { copyTemplateForMeeting, type DbOrTx } from "./meeting-templates-logic";

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
		editable: !isMeetingLocked(meeting.status),
		rows,
		roles,
	};
}

// ---------------------------------------------------------------------------
// Writes — every mutator below is scoped to the CALLING meeting's own private
// template. The row id is caller-supplied, so without that scoping an officer
// of one club could edit another club's agenda by naming its row id.
// ---------------------------------------------------------------------------

/**
 * The meeting's own private template id, or a thrown error.
 *
 * Upgrades on first write: a meeting converted before this feature points at a
 * SHARED template, and editing that would rewrite the agenda for every club
 * using it. Rather than refuse, the first edit copies it — the officer's
 * intent is to change THIS meeting, and the copy is exactly what makes that
 * true. (This is also what `loadAgendaDraft`'s docblock refers to as the
 * upgrade happening on WRITE rather than on read.)
 */
export async function ensureAgendaDraft(
	conn: DbOrTx,
	meetingId: string,
): Promise<string> {
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
	assertMeetingNotLocked(meeting.status);
	if (meeting.status === "cancelled") {
		throw new Error("A cancelled meeting's agenda cannot be edited.");
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
	if (own) return own.id;

	const copyId = await copyTemplateForMeeting(conn, {
		sourceTemplateId: meeting.templateId,
		clubId: meeting.clubId,
		meetingId,
	});
	await conn
		.update(meetings)
		.set({ templateId: copyId })
		.where(eq(meetings.id, meetingId));
	return copyId;
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

/** All three marks or none. `resolveMarks` (agenda-template-rows.ts) treats
 *  that as the contract and drops a partial set silently; a timer card with a
 *  hole in it is worse than no card, so the writer refuses rather than the
 *  renderer discarding. Only checks keys actually present in the patch, so a
 *  patch that touches unrelated fields (e.g. just `label`) is unaffected. */
function assertMarks(patch: {
	markGreen?: number | null;
	markYellow?: number | null;
	markRed?: number | null;
}): void {
	const keys = ["markGreen", "markYellow", "markRed"] as const;
	const touched = keys.filter((k) => k in patch);
	if (touched.length === 0) return;
	const values = keys.map((k) => patch[k] ?? null);
	const set = values.filter((v) => v != null).length;
	if (set !== 0 && set !== 3) {
		throw new Error("Timing marks need all three values, or none.");
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

/**
 * A caller-supplied row's `sortOrder`, resolved against the meeting's CURRENT
 * `meetings.template_id` pointer — BEFORE `ensureAgendaDraft` runs. Null when
 * the row does not belong to this meeting (wrong template, or a meeting with
 * no template at all).
 *
 * This has to run before the fork, not after, for two reasons at once. First,
 * tenancy: rejecting here means a foreign row never triggers a fork write at
 * all — a bad-actor request touches nothing. Second, and the reason this
 * exists rather than a plain id lookup: `loadAgendaDraft` now returns a
 * SHARED template's own content for a meeting that has not been edited yet
 * (correction 1), so the row ids an officer is acting on may be the shared
 * template's — and `ensureAgendaDraft` is about to replace that pointer with
 * a private copy carrying entirely new row ids. `copyTemplateForMeeting`
 * preserves `sort_order` verbatim, and the `(template_id, sort_order)` unique
 * index guarantees at most one row per value, so capturing the PRE-fork
 * sortOrder and re-finding it in the POST-fork template (see the mutators
 * below) is what makes a meeting's very first edit land on the row the
 * officer actually clicked, instead of erroring or silently misfiring.
 */
async function findRowSortOrder(
	conn: DbOrTx,
	meetingId: string,
	rowId: string,
): Promise<number | null> {
	const [meeting] = await conn
		.select({ templateId: meetings.templateId })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!meeting?.templateId) return null;
	const [row] = await conn
		.select({ sortOrder: meetingTemplateBeats.sortOrder })
		.from(meetingTemplateBeats)
		.where(
			and(
				eq(meetingTemplateBeats.id, rowId),
				eq(meetingTemplateBeats.templateId, meeting.templateId),
			),
		)
		.limit(1);
	return row?.sortOrder ?? null;
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
		// Resolved against the PRE-fork pointer — see `findRowSortOrder`.
		const afterSortOrder =
			input.afterRowId === null
				? null
				: await findRowSortOrder(tx, input.meetingId, input.afterRowId);
		if (input.afterRowId !== null && afterSortOrder === null) {
			throw new Error("That agenda row is not part of this meeting.");
		}

		const templateId = await ensureAgendaDraft(tx, input.meetingId);
		const rows = await loadRowIds(tx, templateId);
		if (rows.length >= MAX_TEMPLATE_BEATS) {
			throw new Error(
				`This agenda is too long (max ${MAX_TEMPLATE_BEATS} rows).`,
			);
		}

		const at =
			afterSortOrder === null
				? rows.length
				: rows.findIndex((r) => r.sortOrder === afterSortOrder) + 1;
		if (afterSortOrder !== null && at === 0) {
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

/** Edit a row's content. Validated up front (cheap, no db round trip) and
 *  again scoped to the caller's own template inside the transaction. */
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
	if (patch.label != null) {
		assertWithin(patch.label, MAX_TEMPLATE_LABEL_CHARS, "label");
	}
	if (patch.detail != null) {
		assertWithin(patch.detail, MAX_TEMPLATE_DETAIL_CHARS, "note");
	}
	if (patch.minutes != null && (patch.minutes < 0 || patch.minutes > 600)) {
		throw new Error("Minutes must be between 0 and 600.");
	}
	assertMarks(patch);

	await database.transaction(async (tx) => {
		// Resolved against the PRE-fork pointer — see `findRowSortOrder`.
		const targetSortOrder = await findRowSortOrder(
			tx,
			input.meetingId,
			input.rowId,
		);
		if (targetSortOrder === null) {
			throw new Error("That agenda row is not part of this meeting.");
		}
		const templateId = await ensureAgendaDraft(tx, input.meetingId);
		// Matched by (templateId, sortOrder) rather than id, so a row read off a
		// SHARED template (pre-fork) still lands on its copy — see
		// `findRowSortOrder`. Scoped to THIS meeting's template either way: the
		// row id is caller-supplied, and without the template predicate an
		// officer of one club could edit another's agenda by id.
		const updated = await tx
			.update(meetingTemplateBeats)
			.set(patch)
			.where(
				and(
					eq(meetingTemplateBeats.templateId, templateId),
					eq(meetingTemplateBeats.sortOrder, targetSortOrder),
				),
			)
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
		const targetSortOrder = await findRowSortOrder(
			tx,
			input.meetingId,
			input.rowId,
		);
		if (targetSortOrder === null) {
			throw new Error("That agenda row is not part of this meeting.");
		}
		const templateId = await ensureAgendaDraft(tx, input.meetingId);
		const deleted = await tx
			.delete(meetingTemplateBeats)
			.where(
				and(
					eq(meetingTemplateBeats.templateId, templateId),
					eq(meetingTemplateBeats.sortOrder, targetSortOrder),
				),
			)
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
		const targetSortOrder = await findRowSortOrder(
			tx,
			input.meetingId,
			input.rowId,
		);
		if (targetSortOrder === null) {
			throw new Error("That agenda row is not part of this meeting.");
		}
		const templateId = await ensureAgendaDraft(tx, input.meetingId);
		const rows = await loadRowIds(tx, templateId);
		const at = rows.findIndex((r) => r.sortOrder === targetSortOrder);
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
