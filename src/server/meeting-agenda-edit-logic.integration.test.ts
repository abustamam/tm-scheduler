/**
 * DB-backed tests for the per-meeting agenda editor: reads (Task 6) and row
 * mutations (Task 7).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5433/tm_test \
 *     bunx vitest run src/server/meeting-agenda-edit-logic.integration.test.ts
 */
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	meetings,
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import {
	MAX_ROLE_REPEAT_SLOTS,
	MAX_TEMPLATE_BEATS,
	MAX_TEMPLATE_LABEL_CHARS,
	MAX_TEMPLATE_ROLES,
} from "#/lib/meeting-template-limits";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	addAgendaRole,
	addAgendaRow,
	ensureAgendaDraft,
	loadAgendaDraft,
	moveAgendaRow,
	planRoleRemoval,
	removeAgendaRole,
	removeAgendaRow,
	updateAgendaRow,
} = await import("./meeting-agenda-edit-logic");
// Same DEFERRED-IMPORT-AFTER-THE-MOCK pattern `meeting-templates-logic
// .integration.test.ts` uses (`:50`): `vi.mock("#/db", ...)` above must have
// already run before this module's own `import { db } from "#/db"` resolves,
// or it reaches the real (unset) production db.
const { listRoleDefinitions } = await import("./role-definitions-logic");

const RUN = Math.random().toString(36).slice(2, 8);

// Shared across both describes below (`describe.skipIf(!hasTestDb)` still
// gates whether these ever run) rather than duplicated per suite.
let club: SeededClub;
const madeTemplates: string[] = [];
// `SeededClub` carries `adminUserId` / `memberUserId` / `memberId` (all
// singular) and ONE meeting, ONE role definition and ONE slot — not a
// nine-role club. Assertions written against a full roster can only fail.

beforeEach(async () => {
	club = await seedClub();
});

afterEach(async () => {
	// Club first: `meetings.template_id` is ON DELETE RESTRICT against
	// `meeting_templates`, so the template row can't be deleted while the
	// meeting still points at it. Deleting the club cascades the meeting
	// (clearing that reference) and, since this template is club-scoped,
	// the template row itself. Templates can also be CLUB-LESS, and cleanup
	// cascading from the club does not reach those — the loop below deletes
	// only what this run created and is a no-op for anything the cascade
	// already removed.
	await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	for (const id of madeTemplates.splice(0)) {
		await testDb.delete(meetingTemplates).where(eq(meetingTemplates.id, id));
	}
});

async function givePrivateTemplate() {
	const [t] = await testDb
		.insert(meetingTemplates)
		.values({
			clubId: club.clubId,
			meetingId: club.meetingId,
			key: `draft_${RUN}`,
			name: `Draft ${RUN}`,
		})
		.returning({ id: meetingTemplates.id });
	if (!t) throw new Error("template insert failed");
	madeTemplates.push(t.id);
	await testDb.insert(meetingTemplateRoles).values({
		templateId: t.id,
		key: "chair",
		name: "Chair",
		category: "leadership",
		defaultCount: 1,
		sortOrder: 10,
		isSpeakerRole: false,
	});
	// Insertion order is DELIBERATELY the reverse of sortOrder: a single
	// multi-row INSERT commonly comes back in insertion order even with no
	// ORDER BY, so a batch inserted 0-then-1 cannot tell "sorted by sortOrder"
	// apart from "returned in whatever order Postgres felt like" — the exact
	// gap that let the read-order test below pass with `orderBy` deleted.
	// Swapping the array order (sortOrder values unchanged) makes the two
	// orderings disagree, so only a real ORDER BY produces [OPENING, Welcome].
	await testDb.insert(meetingTemplateBeats).values([
		{
			templateId: t.id,
			sortOrder: 1,
			kind: "role",
			label: "Welcome",
			roleKey: "chair",
			minutes: 5,
		},
		{
			templateId: t.id,
			sortOrder: 0,
			kind: "section",
			label: "OPENING",
			minutes: 0,
		},
	]);
	await testDb
		.update(meetings)
		.set({ templateId: t.id })
		.where(eq(meetings.id, club.meetingId));
	return t.id;
}

/**
 * A second club's private template with one row, for the tenant-scoping
 * tests below. Every mutator resolves its OWN scoping predicate
 * independently (there is no single shared "assert ownership" call), so a
 * missing predicate on any ONE of them is only caught by a test that
 * exercises that specific mutator against a foreign row — hence one seeded
 * fixture reused by four separate tests rather than one.
 */
/**
 * A club-scoped template with `meeting_id` NULL — SHARED, so the meeting's
 * first write forks a private copy of it. `givePrivateTemplate` above gives the
 * meeting its OWN copy, which never forks and so cannot exercise the id
 * translation this fixture exists for.
 */
async function giveSharedTemplate() {
	const [t] = await testDb
		.insert(meetingTemplates)
		.values({
			clubId: club.clubId,
			meetingId: null,
			key: `shared_${RUN}`,
			name: `Shared ${RUN}`,
		})
		.returning({ id: meetingTemplates.id });
	if (!t) throw new Error("template insert failed");
	madeTemplates.push(t.id);
	await testDb.insert(meetingTemplateRoles).values({
		templateId: t.id,
		key: "chair",
		name: "Chair",
		category: "leadership",
		defaultCount: 1,
		sortOrder: 10,
		isSpeakerRole: false,
	});
	await testDb.insert(meetingTemplateBeats).values([
		{
			templateId: t.id,
			sortOrder: 0,
			kind: "section",
			label: "OPENING",
			minutes: 0,
		},
		{
			templateId: t.id,
			sortOrder: 1,
			kind: "event",
			label: "Welcome",
			minutes: 5,
		},
	]);
	await testDb
		.update(meetings)
		.set({ templateId: t.id })
		.where(eq(meetings.id, club.meetingId));
	return t.id;
}

async function seedForeignRow(): Promise<{
	other: SeededClub;
	foreignTemplateId: string;
	foreignId: string;
}> {
	const other = await seedClub();
	const [t] = await testDb
		.insert(meetingTemplates)
		.values({
			clubId: other.clubId,
			meetingId: other.meetingId,
			key: `other_${RUN}`,
			name: "Other",
		})
		.returning({ id: meetingTemplates.id });
	if (!t) throw new Error("template insert failed");
	madeTemplates.push(t.id);
	const [foreign] = await testDb
		.insert(meetingTemplateBeats)
		.values({
			templateId: t.id,
			sortOrder: 0,
			kind: "event",
			label: "theirs",
			minutes: 0,
		})
		.returning({ id: meetingTemplateBeats.id });
	if (!foreign) throw new Error("beat insert failed");
	return { other, foreignTemplateId: t.id, foreignId: foreign.id };
}

/** Finds the slot whose role definition has `roleKey` on `club.meetingId` and
 *  claims it for `memberId`. */
async function claimFirstSlotFor(
	roleKey: string,
	memberId: string,
): Promise<void> {
	const [slot] = await testDb
		.select({ id: roleSlots.id })
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.where(
			and(
				eq(roleSlots.meetingId, club.meetingId),
				eq(roleDefinitions.key, roleKey),
			),
		)
		.limit(1);
	if (!slot) throw new Error(`no slot found for role "${roleKey}"`);
	await testDb
		.update(roleSlots)
		.set({ assignedMemberId: memberId, status: "claimed" })
		.where(eq(roleSlots.id, slot.id));
}

/**
 * A second club's own meeting, private template, materialized role and
 * claimed slot — all sharing the SAME `roleKey` as whatever the caller is
 * about to add via `addAgendaRole` in their own club. This is what makes the
 * `templateId` predicate on `removeAgendaRole`'s deletes the thing that
 * decides: `role_definitions.clubId` differs, but a private template's own id
 * is unique per meeting regardless, so `templateId` alone already separates
 * the two — the fixture proves that scoping is actually in effect rather than
 * merely never colliding by accident (see the removal test's "strip and
 * confirm" note).
 */
async function seedForeignRole(roleKey: string): Promise<{
	other: SeededClub;
	foreignTemplateId: string;
	foreignDefId: string;
	foreignSlotId: string;
	foreignBeatId: string;
}> {
	const other = await seedClub();
	const [t] = await testDb
		.insert(meetingTemplates)
		.values({
			clubId: other.clubId,
			meetingId: other.meetingId,
			key: `other_role_${RUN}`,
			name: "Other role template",
		})
		.returning({ id: meetingTemplates.id });
	if (!t) throw new Error("template insert failed");
	madeTemplates.push(t.id);
	await testDb.insert(meetingTemplateRoles).values({
		templateId: t.id,
		key: roleKey,
		name: "Foreign Zoom Master",
		category: "functionary",
		defaultCount: 1,
		sortOrder: 10,
		isSpeakerRole: false,
	});
	const [beat] = await testDb
		.insert(meetingTemplateBeats)
		.values({
			templateId: t.id,
			sortOrder: 0,
			kind: "role",
			label: "Foreign zoom slot",
			roleKey,
			minutes: 1,
		})
		.returning({ id: meetingTemplateBeats.id });
	if (!beat) throw new Error("beat insert failed");
	await testDb
		.update(meetings)
		.set({ templateId: t.id })
		.where(eq(meetings.id, other.meetingId));

	const [def] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: other.clubId,
			templateId: t.id,
			key: roleKey,
			name: "Foreign Zoom Master",
			category: "functionary",
			defaultCount: 1,
			sortOrder: 10,
			isSpeakerRole: false,
		})
		.returning({ id: roleDefinitions.id });
	if (!def) throw new Error("role definition insert failed");
	const [slot] = await testDb
		.insert(roleSlots)
		.values({
			meetingId: other.meetingId,
			roleDefinitionId: def.id,
			slotIndex: 0,
			assignedMemberId: other.memberId,
			status: "claimed",
		})
		.returning({ id: roleSlots.id });
	if (!slot) throw new Error("slot insert failed");

	return {
		other,
		foreignTemplateId: t.id,
		foreignDefId: def.id,
		foreignSlotId: slot.id,
		foreignBeatId: beat.id,
	};
}

describe.skipIf(!hasTestDb)("loadAgendaDraft", () => {
	it("returns the meeting's own rows in sort order", async () => {
		// `givePrivateTemplate` inserts "Welcome" (sortOrder 1) BEFORE "OPENING"
		// (sortOrder 0) in the same batch, deliberately reversed from sortOrder —
		// a batch inserted in sortOrder order can pass this assertion on
		// insertion order alone even with `orderBy` deleted from `loadAgendaDraft`.
		const id = await givePrivateTemplate();
		const draft = await loadAgendaDraft(club.meetingId);
		expect(draft?.templateId).toBe(id);
		expect(draft?.rows.map((r) => r.label)).toEqual(["OPENING", "Welcome"]);
		expect(draft?.roles.map((r) => r.key)).toEqual(["chair"]);
		expect(draft?.editable).toBe(true);
	});

	it("returns null for a standard meeting", async () => {
		// A meeting with no template reads the code-derived RUN_OF_SHOW and is
		// out of scope for this editor by design.
		expect(await loadAgendaDraft(club.meetingId)).toBeNull();
	});

	it("loads a draft from a shared-template pointer, and forks a private copy on the first write", async () => {
		// A meeting converted before this feature landed points straight at a
		// SHARED template (`meeting_id IS NULL`) rather than a private copy.
		// Returning null here (as Task 6 shipped it) is circular: the route
		// redirects away on null, so the officer never reaches a write, so the
		// upgrade that only fires on write can never fire either — for exactly
		// the meetings that exist in production today. Correction 1 reads the
		// shared row directly instead (it's the meeting's own content, editable
		// decided by the lock as normal) and leaves forking to the first write.
		const [shared] = await testDb
			.insert(meetingTemplates)
			.values({ key: `shared_${RUN}`, name: `Shared ${RUN}` })
			.returning({ id: meetingTemplates.id });
		if (!shared) throw new Error("template insert failed");
		madeTemplates.push(shared.id);
		await testDb.insert(meetingTemplateBeats).values({
			templateId: shared.id,
			sortOrder: 0,
			kind: "event",
			label: "Shared beat",
			minutes: 5,
		});
		await testDb
			.update(meetings)
			.set({ templateId: shared.id })
			.where(eq(meetings.id, club.meetingId));

		const draft = await loadAgendaDraft(club.meetingId);
		expect(draft).not.toBeNull();
		expect(draft?.templateId).toBe(shared.id);
		expect(draft?.rows.map((r) => r.label)).toEqual(["Shared beat"]);
		expect(draft?.editable).toBe(true);

		// First mutation forks a private copy...
		await addAgendaRow({
			meetingId: club.meetingId,
			afterRowId: draft?.rows[0]?.id ?? null,
			kind: "event",
		});
		const after = await loadAgendaDraft(club.meetingId);
		expect(after?.templateId).not.toBe(shared.id);
		if (after?.templateId) madeTemplates.push(after.templateId);

		// ...leaving the shared template's own rows untouched.
		const sharedRows = await testDb
			.select({ id: meetingTemplateBeats.id })
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, shared.id));
		expect(sharedRows).toHaveLength(1);
	});

	it("marks a completed meeting NOT editable rather than hiding it", async () => {
		// The agenda is still worth reading after the night; it just stops being
		// writable, the same lock every other mutator honours.
		await givePrivateTemplate();
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, club.meetingId));
		const draft = await loadAgendaDraft(club.meetingId);
		expect(draft?.editable).toBe(false);
		expect(draft?.rows.length).toBeGreaterThan(0);
	});

	it("marks a cancelled meeting NOT editable — matching what ensureAgendaDraft actually allows", async () => {
		// `editable` used to be `!isMeetingLocked(status)` alone, which is
		// `completed`-only, while `ensureAgendaDraft` separately refuses
		// `cancelled`. The two had drifted: a cancelled meeting rendered a fully
		// interactive editor whose every save threw. Both now share
		// `agendaEditable`, so this and the write-side refusal below cannot
		// disagree again.
		await givePrivateTemplate();
		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, club.meetingId));
		const draft = await loadAgendaDraft(club.meetingId);
		expect(draft?.editable).toBe(false);
		expect(draft?.rows.length).toBeGreaterThan(0);
	});
});

describe.skipIf(!hasTestDb)("agenda row mutations", () => {
	it("adds a row after the one named, renumbering the rest", async () => {
		await givePrivateTemplate();
		const before = await loadAgendaDraft(club.meetingId);
		const first = before?.rows[0];
		if (!first) throw new Error("no rows");

		const created = await addAgendaRow({
			meetingId: club.meetingId,
			afterRowId: first.id,
			kind: "event",
		});
		const after = await loadAgendaDraft(club.meetingId);
		expect(after?.rows.map((r) => r.id)).toEqual([
			first.id,
			created.id,
			before.rows[1]?.id,
		]);
		// sortOrder stays strictly increasing — `buildTemplateRows` groups repeat
		// blocks from ADJACENT rows, so a duplicate or out-of-order value splits a
		// block in two and silently doubles a segment.
		const orders = after?.rows.map((r) => r.sortOrder) ?? [];
		expect(orders).toEqual([...orders].sort((a, b) => a - b));
		expect(new Set(orders).size).toBe(orders.length);
	});

	it("refuses to add past the beat ceiling", async () => {
		// ABSOLUTE: the cap is enforced at the writer as well as the read seam,
		// so an officer holding the button cannot build a template the renderer
		// will then silently truncate.
		const id = await givePrivateTemplate();
		await testDb.insert(meetingTemplateBeats).values(
			Array.from({ length: MAX_TEMPLATE_BEATS }, (_, i) => ({
				templateId: id,
				sortOrder: 100 + i,
				kind: "event" as const,
				label: `filler ${i}`,
				minutes: 0,
			})),
		);
		await expect(
			addAgendaRow({
				meetingId: club.meetingId,
				afterRowId: null,
				kind: "event",
			}),
		).rejects.toThrow(/too long/i);
	});

	it("edits a row's label, minutes and marks", async () => {
		await givePrivateTemplate();
		const draft = await loadAgendaDraft(club.meetingId);
		const row = draft?.rows.find((r) => r.kind === "role");
		if (!row) throw new Error("no role row");

		await updateAgendaRow({
			meetingId: club.meetingId,
			rowId: row.id,
			patch: {
				label: "Opening remarks",
				minutes: 4,
				markGreen: 2,
				markYellow: 3,
				markRed: 4,
			},
		});
		const after = await loadAgendaDraft(club.meetingId);
		const updated = after?.rows.find((r) => r.id === row.id);
		expect(updated?.label).toBe("Opening remarks");
		expect(updated?.minutes).toBe(4);
		expect(updated?.markGreen).toBe(2);
	});

	it("refuses a partial set of timing marks", async () => {
		// `resolveMarks` treats all-three-or-none as the contract and drops a
		// partial set silently; a timer card with a hole in it is worse than no
		// card, so the writer refuses rather than the renderer discarding.
		await givePrivateTemplate();
		const draft = await loadAgendaDraft(club.meetingId);
		const row = draft?.rows.find((r) => r.kind === "role");
		if (!row) throw new Error("no role row");
		await expect(
			updateAgendaRow({
				meetingId: club.meetingId,
				rowId: row.id,
				patch: { markGreen: 2, markYellow: null, markRed: 4 },
			}),
		).rejects.toThrow(/all three/i);
	});

	it("refuses a patch that clears one mark and leaves the row partial", async () => {
		// A patch-only check sees ONE touched key (markGreen) with value null —
		// zero "set" values in the patch itself, which reads as "none" — but
		// against a row already holding (2,3,4) the RESULT is (null,3,4), the
		// exact silent hole this validation exists to refuse. Must be checked
		// against the merged row, not the patch in isolation.
		await givePrivateTemplate();
		const draft = await loadAgendaDraft(club.meetingId);
		const row = draft?.rows.find((r) => r.kind === "role");
		if (!row) throw new Error("no role row");
		await updateAgendaRow({
			meetingId: club.meetingId,
			rowId: row.id,
			patch: { markGreen: 2, markYellow: 3, markRed: 4 },
		});

		await expect(
			updateAgendaRow({
				meetingId: club.meetingId,
				rowId: row.id,
				patch: { markGreen: null },
			}),
		).rejects.toThrow(/all three/i);

		// And the row itself was NOT written with a hole in it.
		const after = await loadAgendaDraft(club.meetingId);
		const updated = after?.rows.find((r) => r.id === row.id);
		expect(updated?.markGreen).toBe(2);
		expect(updated?.markYellow).toBe(3);
		expect(updated?.markRed).toBe(4);
	});

	it("accepts a mark patch that completes an already-partial row", async () => {
		// The opposite direction of the same bug: a patch-only check sees TWO
		// touched keys, both non-null, and refuses it as "partial" — but if the
		// row already holds the third mark, the MERGED result is complete and
		// must be accepted, not refused for a hole that isn't there.
		await givePrivateTemplate();
		const draft = await loadAgendaDraft(club.meetingId);
		const row = draft?.rows.find((r) => r.kind === "role");
		if (!row) throw new Error("no role row");
		// Seed the partial state directly — the writer itself can never produce
		// one, so this is standing in for a row that predates this validation.
		await testDb
			.update(meetingTemplateBeats)
			.set({ markRed: 4 })
			.where(eq(meetingTemplateBeats.id, row.id));

		await updateAgendaRow({
			meetingId: club.meetingId,
			rowId: row.id,
			patch: { markGreen: 2, markYellow: 3 },
		});

		const after = await loadAgendaDraft(club.meetingId);
		const updated = after?.rows.find((r) => r.id === row.id);
		expect(updated?.markGreen).toBe(2);
		expect(updated?.markYellow).toBe(3);
		expect(updated?.markRed).toBe(4);
	});

	it("refuses an empty patch instead of a confusing drizzle 500", async () => {
		// `{}` validates as a well-formed patch shape and would otherwise fork
		// the meeting's template on its way to drizzle's `.set({})`, which
		// throws "No values to set" — a request that changes nothing should be
		// refused up front, not after doing a write-side effect.
		await givePrivateTemplate();
		const draft = await loadAgendaDraft(club.meetingId);
		const row = draft?.rows[0];
		if (!row) throw new Error("no rows");
		await expect(
			updateAgendaRow({ meetingId: club.meetingId, rowId: row.id, patch: {} }),
		).rejects.toThrow();
	});

	it("caps label and detail by CODE POINTS", async () => {
		// Slicing a surrogate pair in half yields a lone surrogate that renders as
		// a replacement glyph and makes encodeURIComponent throw for any consumer
		// building a URL from it (#522). The over-the-cap case alone does not
		// prove counting is by CODE POINT rather than UTF-16 unit — 🎤 is a
		// surrogate pair, so MAX+1 of them is already 2*(MAX+1) UTF-16 units and
		// trips either implementation. The boundary case below is what actually
		// distinguishes them: exactly MAX code points is 2*MAX UTF-16 units, which
		// a length-based cap would wrongly refuse.
		await givePrivateTemplate();
		const draft = await loadAgendaDraft(club.meetingId);
		const row = draft?.rows[0];
		if (!row) throw new Error("no rows");

		await updateAgendaRow({
			meetingId: club.meetingId,
			rowId: row.id,
			patch: { label: "🎤".repeat(MAX_TEMPLATE_LABEL_CHARS) },
		});

		await expect(
			updateAgendaRow({
				meetingId: club.meetingId,
				rowId: row.id,
				patch: { label: "🎤".repeat(MAX_TEMPLATE_LABEL_CHARS + 1) },
			}),
		).rejects.toThrow(/too long/i);
	});

	it("accepts a roleKey the template declares", async () => {
		await givePrivateTemplate();
		const draft = await loadAgendaDraft(club.meetingId);
		const row = draft?.rows.find((r) => r.kind === "section");
		if (!row) throw new Error("no section row");
		// "chair" is declared by `givePrivateTemplate`'s role list.
		await updateAgendaRow({
			meetingId: club.meetingId,
			rowId: row.id,
			patch: { roleKey: "chair" },
		});
		const after = await loadAgendaDraft(club.meetingId);
		expect(after?.rows.find((r) => r.id === row.id)?.roleKey).toBe("chair");
	});

	it("refuses a roleKey the template does not declare", async () => {
		// `agenda-template-rows.ts`'s `toRow`: "A beat naming a role the
		// template does not declare is dropped rather than rendered against an
		// invented name." Without this check the write succeeds silently and the
		// beat vanishes from every rendered surface with no error anywhere.
		await givePrivateTemplate();
		const draft = await loadAgendaDraft(club.meetingId);
		const row = draft?.rows[0];
		if (!row) throw new Error("no rows");
		await expect(
			updateAgendaRow({
				meetingId: club.meetingId,
				rowId: row.id,
				patch: { roleKey: "not-a-declared-role" },
			}),
		).rejects.toThrow(/not a role this template declares/i);
	});

	it("refuses a repeatsRoleKey the template does not declare", async () => {
		await givePrivateTemplate();
		const draft = await loadAgendaDraft(club.meetingId);
		const row = draft?.rows[0];
		if (!row) throw new Error("no rows");
		await expect(
			updateAgendaRow({
				meetingId: club.meetingId,
				rowId: row.id,
				patch: { repeatsRoleKey: "not-a-declared-role" },
			}),
		).rejects.toThrow(/not a role this template declares/i);
	});

	it("caps roleKey by length", async () => {
		await givePrivateTemplate();
		const draft = await loadAgendaDraft(club.meetingId);
		const row = draft?.rows[0];
		if (!row) throw new Error("no rows");
		await expect(
			updateAgendaRow({
				meetingId: club.meetingId,
				rowId: row.id,
				patch: { roleKey: "x".repeat(MAX_TEMPLATE_LABEL_CHARS + 1) },
			}),
		).rejects.toThrow(/too long/i);
	});

	it("caps repeatsRoleKey by length", async () => {
		// Same `assertWithin` call, same code path as roleKey's cap above — only
		// roleKey's cap had a test; repeatsRoleKey's was untested.
		await givePrivateTemplate();
		const draft = await loadAgendaDraft(club.meetingId);
		const row = draft?.rows[0];
		if (!row) throw new Error("no rows");
		await expect(
			updateAgendaRow({
				meetingId: club.meetingId,
				rowId: row.id,
				patch: { repeatsRoleKey: "x".repeat(MAX_TEMPLATE_LABEL_CHARS + 1) },
			}),
		).rejects.toThrow(/too long/i);
	});

	/**
	 * D4's "unauthorable" guarantee, enforced at the writer.
	 *
	 * `repeats_role_key` IS the once/per-holder flag: null means "once", and the
	 * row's OWN key means "one row per holder". A per-holder row that repeats
	 * over a DIFFERENT role than it names is the shape the spec (D4),
	 * `CONTEXT.md` and `TODOS.md` all record as unauthorable — and it has to be
	 * refused HERE rather than only in the editor, because a crafted request
	 * reaches this function directly.
	 *
	 * Validated against the MERGED row, the same way `assertMarks` is, because
	 * the reachable route is two separate patches: tick "one row per person"
	 * (`{repeatsRoleKey: X}` on a row whose `roleKey` is already X), then change
	 * the Role select (`{roleKey: Y}` alone). Neither patch is wrong in
	 * isolation; the row they compose is.
	 *
	 * What the illegal row would print: `buildTemplateRows` forms a repeat block
	 * on X, `blockRow.roleKey === repeatKey` is false so `bound` is empty, and
	 * the row prints once per holder of X, numbered, naming nobody — while the
	 * editor's own `perHolder` computes false and the label reads "One row".
	 */
	it("refuses a repeatsRoleKey naming a role other than the row's own, in ONE patch", async () => {
		await givePrivateTemplate();
		const other = await addAgendaRole({
			meetingId: club.meetingId,
			name: "Zoom Master",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});
		const draft = await loadAgendaDraft(club.meetingId);
		const row = draft?.rows.find((r) => r.kind === "role");
		if (!row) throw new Error("no role row");
		await expect(
			updateAgendaRow({
				meetingId: club.meetingId,
				rowId: row.id,
				patch: { roleKey: "chair", repeatsRoleKey: other.key },
			}),
		).rejects.toThrow(/repeat over the same role/i);
	});

	it("refuses a role change that leaves an existing repeatsRoleKey naming the OLD role", async () => {
		// The two-click route an officer actually takes, and the one a
		// patch-in-isolation check cannot see: each patch is legal alone.
		await givePrivateTemplate();
		const other = await addAgendaRole({
			meetingId: club.meetingId,
			name: "Zoom Master",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});
		const draft = await loadAgendaDraft(club.meetingId);
		const row = draft?.rows.find((r) => r.kind === "role");
		if (!row) throw new Error("no role row");
		// Tick "one row per person holding this role" — legal.
		await updateAgendaRow({
			meetingId: club.meetingId,
			rowId: row.id,
			patch: { repeatsRoleKey: "chair" },
		});
		// Change the Role select — legal in isolation, illegal as a merged row.
		await expect(
			updateAgendaRow({
				meetingId: club.meetingId,
				rowId: row.id,
				patch: { roleKey: other.key },
			}),
		).rejects.toThrow(/repeat over the same role/i);

		// And nothing was written: the row still reads as a legal per-holder row
		// on `chair`, not the half-applied shape.
		const after = await loadAgendaDraft(club.meetingId);
		const same = after?.rows.find((r) => r.id === row.id);
		expect(same?.roleKey).toBe("chair");
		expect(same?.repeatsRoleKey).toBe("chair");
	});

	it("refuses clearing roleKey while repeatsRoleKey stays set", async () => {
		// Setting the Role to "Nobody" used to leave `repeatsRoleKey` set with the
		// per-holder checkbox now HIDDEN, so no UI path could clear it — and the
		// row vanished from print, deck and pptx while still showing in the
		// editor.
		await givePrivateTemplate();
		const draft = await loadAgendaDraft(club.meetingId);
		const row = draft?.rows.find((r) => r.kind === "role");
		if (!row) throw new Error("no role row");
		await updateAgendaRow({
			meetingId: club.meetingId,
			rowId: row.id,
			patch: { repeatsRoleKey: "chair" },
		});
		await expect(
			updateAgendaRow({
				meetingId: club.meetingId,
				rowId: row.id,
				patch: { roleKey: null },
			}),
		).rejects.toThrow(/repeat over the same role/i);
	});

	it("accepts a role change that patches both keys together", async () => {
		// The shape the editor must send, and the proof the rule refuses the
		// illegal MERGE rather than the mere presence of `repeatsRoleKey`.
		await givePrivateTemplate();
		const other = await addAgendaRole({
			meetingId: club.meetingId,
			name: "Zoom Master",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});
		const draft = await loadAgendaDraft(club.meetingId);
		const row = draft?.rows.find((r) => r.kind === "role");
		if (!row) throw new Error("no role row");
		await updateAgendaRow({
			meetingId: club.meetingId,
			rowId: row.id,
			patch: { repeatsRoleKey: "chair" },
		});
		await updateAgendaRow({
			meetingId: club.meetingId,
			rowId: row.id,
			patch: { roleKey: other.key, repeatsRoleKey: other.key },
		});
		const after = await loadAgendaDraft(club.meetingId);
		const same = after?.rows.find((r) => r.id === row.id);
		expect(same?.roleKey).toBe(other.key);
		expect(same?.repeatsRoleKey).toBe(other.key);

		// And clearing BOTH together is legal too — the "Nobody" path.
		await updateAgendaRow({
			meetingId: club.meetingId,
			rowId: row.id,
			patch: { roleKey: null, repeatsRoleKey: null },
		});
		const cleared = await loadAgendaDraft(club.meetingId);
		const clearedRow = cleared?.rows.find((r) => r.id === row.id);
		expect(clearedRow?.roleKey).toBeNull();
		expect(clearedRow?.repeatsRoleKey).toBeNull();
	});

	it("still allows a NON-role row inside a repeat block — the contest's ballot minute", async () => {
		// `contest-template.ts` ships exactly this: "One minute of silence",
		// `kind: "event"`, no `roleKey` of its own, `repeatsRoleKey:
		// "contestant_prepared"`. `buildTemplateRows` handles it deliberately
		// (`bound = []`, repeats as-is), so a rule stated as "the two keys must
		// always match" would make the shipped contest template unwritable. This
		// is the case that keeps `assertRepeatBinding` keyed on `kind`.
		const id = await givePrivateTemplate();
		const [eventRow] = await testDb
			.insert(meetingTemplateBeats)
			.values({
				templateId: id,
				sortOrder: 2,
				kind: "event",
				label: "One minute of silence",
				minutes: 1,
			})
			.returning({ id: meetingTemplateBeats.id });
		if (!eventRow) throw new Error("event beat insert failed");
		await updateAgendaRow({
			meetingId: club.meetingId,
			rowId: eventRow.id,
			patch: { repeatsRoleKey: "chair" },
		});
		const after = await loadAgendaDraft(club.meetingId);
		const stored = after?.rows.find((r) => r.id === eventRow.id);
		expect(stored?.roleKey).toBeNull();
		expect(stored?.repeatsRoleKey).toBe("chair");
	});

	it("moves a row up and down", async () => {
		await givePrivateTemplate();
		const before = await loadAgendaDraft(club.meetingId);
		const ids = before?.rows.map((r) => r.id) ?? [];

		await moveAgendaRow({
			meetingId: club.meetingId,
			rowId: ids[1] ?? "",
			direction: "up",
		});
		const afterUp = await loadAgendaDraft(club.meetingId);
		expect(afterUp?.rows.map((r) => r.id)).toEqual([ids[1], ids[0]]);

		// ...and back down restores the original order — exercises the OTHER
		// branch of `direction`, which the "up" call above never reaches.
		await moveAgendaRow({
			meetingId: club.meetingId,
			rowId: ids[1] ?? "",
			direction: "down",
		});
		const afterDown = await loadAgendaDraft(club.meetingId);
		expect(afterDown?.rows.map((r) => r.id)).toEqual(ids);

		// Past either end is a documented no-op, not an error or a corruption of
		// sortOrder.
		await moveAgendaRow({
			meetingId: club.meetingId,
			rowId: ids[0] ?? "",
			direction: "up",
		});
		const afterNoop = await loadAgendaDraft(club.meetingId);
		expect(afterNoop?.rows.map((r) => r.id)).toEqual(ids);
	});

	// #task-10. `renumberRows` used to issue 2N sequential single-row UPDATEs —
	// up to 400 round trips at MAX_TEMPLATE_BEATS, each holding a row lock on
	// its beat for the whole transaction. Measured against a real local
	// Postgres before the fix: ~170-187ms per `moveAgendaRow` call at 200
	// rows, three runs. The fix (two bulk `CASE id WHEN … THEN …` statements,
	// still the same two-pass negative-floor shape) measured ~11-16ms the
	// same way. ABSOLUTE, not relative to the old number — a regression back
	// to one-statement-per-row would still clear a bound stated as "faster
	// than before". 100ms leaves a wide margin over the measured ~16ms for a
	// slower CI runner while still catching a reversion to the N-statement
	// shape, which cost 10x that at this same size.
	it("renumbers MAX_TEMPLATE_BEATS rows in well under 100ms (bulk CASE, not 2N round trips)", async () => {
		const id = await givePrivateTemplate();
		// givePrivateTemplate already seeds 2 rows (sortOrder 0, 1); fill the
		// rest with plain filler, same shape as the "refuses to add past the
		// beat ceiling" fixture above.
		await testDb.insert(meetingTemplateBeats).values(
			Array.from({ length: MAX_TEMPLATE_BEATS - 2 }, (_, i) => ({
				templateId: id,
				sortOrder: 100 + i,
				kind: "event" as const,
				label: `filler ${i}`,
				minutes: 0,
			})),
		);
		const draft = await loadAgendaDraft(club.meetingId);
		const rows = draft?.rows ?? [];
		expect(rows).toHaveLength(MAX_TEMPLATE_BEATS);
		const mid = rows[Math.floor(rows.length / 2)];
		if (!mid) throw new Error("no rows");

		const t0 = performance.now();
		await moveAgendaRow({
			meetingId: club.meetingId,
			rowId: mid.id,
			direction: "up",
		});
		const ms = performance.now() - t0;
		expect(ms).toBeLessThan(100);

		// And the reorder is still correct, not just fast: the moved row is now
		// one position earlier, everyone else keeps their relative order.
		const after = await loadAgendaDraft(club.meetingId);
		const afterIds = after?.rows.map((r) => r.id) ?? [];
		const beforeIds = rows.map((r) => r.id);
		const expected = [...beforeIds];
		const atIndex = expected.indexOf(mid.id);
		expected.splice(atIndex, 1);
		expected.splice(atIndex - 1, 0, mid.id);
		expect(afterIds).toEqual(expected);
	});

	it("removes a row", async () => {
		await givePrivateTemplate();
		const before = await loadAgendaDraft(club.meetingId);
		const target = before?.rows[0];
		if (!target) throw new Error("no rows");
		await removeAgendaRow({ meetingId: club.meetingId, rowId: target.id });
		const after = await loadAgendaDraft(club.meetingId);
		expect(after?.rows.map((r) => r.id)).not.toContain(target.id);
	});

	it("empties the agenda when every row is removed, one at a time", async () => {
		// "An empty agenda is a legal state" is its own commit on this branch —
		// the write path to empty deserves the same coverage the read path
		// (`loadAgendaDraft` returning `rows: []`) already has. The last removal
		// is the interesting one: it drives `renumberRows` down to an EMPTY
		// `orderedIds`, which is exactly the shape its own
		// `if (orderedIds.length === 0) return;` guard exists for — without it,
		// `bulkSetSortOrder` would build its `CASE` expression from a
		// `sql.join([])`, producing a bare `CASE "id" END` and a Postgres syntax
		// error instead of a clean no-op.
		await givePrivateTemplate();
		const before = await loadAgendaDraft(club.meetingId);
		const rows = before?.rows ?? [];
		expect(rows.length).toBeGreaterThan(0);

		for (const row of rows) {
			await removeAgendaRow({ meetingId: club.meetingId, rowId: row.id });
		}

		const after = await loadAgendaDraft(club.meetingId);
		expect(after?.rows).toEqual([]);
	});

	it("refuses every mutation on a locked meeting", async () => {
		await givePrivateTemplate();
		const draft = await loadAgendaDraft(club.meetingId);
		const row = draft?.rows[0];
		if (!row) throw new Error("no rows");
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, club.meetingId));
		await expect(
			removeAgendaRow({ meetingId: club.meetingId, rowId: row.id }),
		).rejects.toThrow();
		await expect(
			updateAgendaRow({
				meetingId: club.meetingId,
				rowId: row.id,
				patch: { minutes: 1 },
			}),
		).rejects.toThrow();
	});

	it("refuses every mutation on a cancelled meeting", async () => {
		// Same drift `loadAgendaDraft`'s cancelled test above closes on the read
		// side — this is the write side ensureAgendaDraft already enforced.
		await givePrivateTemplate();
		const draft = await loadAgendaDraft(club.meetingId);
		const row = draft?.rows[0];
		if (!row) throw new Error("no rows");
		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, club.meetingId));
		await expect(
			removeAgendaRow({ meetingId: club.meetingId, rowId: row.id }),
		).rejects.toThrow(/cancelled/i);
	});

	// The rowId is caller-supplied. Scoping EVERY mutation to the meeting's own
	// template is the point of this task, not boilerplate — there is no single
	// shared "assert ownership" call, so each mutator's own predicate is tested
	// independently below rather than exercising only one and assuming the rest
	// share its fate.

	it("cannot remove a row belonging to another meeting's template", async () => {
		await givePrivateTemplate();
		const { other, foreignId } = await seedForeignRow();
		// try/finally: an assertion failure below must not skip cleaning up
		// `other` — the module `afterEach` only cleans up `club`, and a leaked
		// club-and-meeting sits in the shared `tm_test` for every run after.
		try {
			await expect(
				removeAgendaRow({ meetingId: club.meetingId, rowId: foreignId }),
			).rejects.toThrow();
			const still = await testDb
				.select({ id: meetingTemplateBeats.id })
				.from(meetingTemplateBeats)
				.where(eq(meetingTemplateBeats.id, foreignId));
			expect(still).toHaveLength(1);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("cannot edit a row belonging to another meeting's template", async () => {
		await givePrivateTemplate();
		const { other, foreignId } = await seedForeignRow();
		try {
			await expect(
				updateAgendaRow({
					meetingId: club.meetingId,
					rowId: foreignId,
					patch: { minutes: 99 },
				}),
			).rejects.toThrow();
			const [still] = await testDb
				.select({ minutes: meetingTemplateBeats.minutes })
				.from(meetingTemplateBeats)
				.where(eq(meetingTemplateBeats.id, foreignId));
			expect(still?.minutes).toBe(0);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("cannot move a row belonging to another meeting's template", async () => {
		await givePrivateTemplate();
		const { other, foreignId } = await seedForeignRow();
		try {
			await expect(
				moveAgendaRow({
					meetingId: club.meetingId,
					rowId: foreignId,
					direction: "down",
				}),
			).rejects.toThrow();
			const [still] = await testDb
				.select({ sortOrder: meetingTemplateBeats.sortOrder })
				.from(meetingTemplateBeats)
				.where(eq(meetingTemplateBeats.id, foreignId));
			expect(still?.sortOrder).toBe(0);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("cannot add a row after one belonging to another meeting's template", async () => {
		await givePrivateTemplate();
		const { other, foreignTemplateId, foreignId } = await seedForeignRow();
		try {
			await expect(
				addAgendaRow({
					meetingId: club.meetingId,
					afterRowId: foreignId,
					kind: "event",
				}),
			).rejects.toThrow();
			// Neither template gained a row: the foreign template because the
			// mutator never wrote to it, and the caller's own because resolving
			// `afterRowId` failed before any insert ran.
			const foreignRows = await testDb
				.select({ id: meetingTemplateBeats.id })
				.from(meetingTemplateBeats)
				.where(eq(meetingTemplateBeats.templateId, foreignTemplateId));
			expect(foreignRows).toHaveLength(1);
			const ownDraft = await loadAgendaDraft(club.meetingId);
			expect(ownDraft?.rows).toHaveLength(2);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	// Findings above short-circuit at the pre-fork ownership check
	// (`findRow`), so they never reach the mutating statement's OWN
	// `templateId` predicate. These two set up the same "foreign row shares
	// this row's sortOrder" condition on the caller's OWN, already-private
	// template. They pass either way now, and that is worth stating rather
	// than leaving implied: on an already-private template the mutating
	// statement matches by `id` (finding #3's fix), which is a primary key and
	// needs no templateId help to avoid the foreign row — so these two do NOT
	// by themselves prove the templateId predicate is load-bearing. They are
	// still kept, as basic regression coverage of "editing my own row never
	// touches someone else's" at the id-matched path. The test AFTER them is
	// the one that isolates the predicate that actually matters: the
	// sortOrder-matched path, reached only on the one-time fork.

	it("does not touch a foreign row sharing the same sortOrder when removing its own", async () => {
		await givePrivateTemplate();
		const { other, foreignId } = await seedForeignRow();
		try {
			const draft = await loadAgendaDraft(club.meetingId);
			const ownFirst = draft?.rows[0];
			if (!ownFirst) throw new Error("no rows");
			expect(ownFirst.sortOrder).toBe(0);

			await removeAgendaRow({ meetingId: club.meetingId, rowId: ownFirst.id });

			const still = await testDb
				.select({ id: meetingTemplateBeats.id })
				.from(meetingTemplateBeats)
				.where(eq(meetingTemplateBeats.id, foreignId));
			expect(still).toHaveLength(1);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("does not touch a foreign row sharing the same sortOrder when editing its own", async () => {
		await givePrivateTemplate();
		const { other, foreignId } = await seedForeignRow();
		try {
			const draft = await loadAgendaDraft(club.meetingId);
			const ownFirst = draft?.rows[0];
			if (!ownFirst) throw new Error("no rows");
			expect(ownFirst.sortOrder).toBe(0);

			await updateAgendaRow({
				meetingId: club.meetingId,
				rowId: ownFirst.id,
				patch: { label: "renamed" },
			});

			const [still] = await testDb
				.select({ label: meetingTemplateBeats.label })
				.from(meetingTemplateBeats)
				.where(eq(meetingTemplateBeats.id, foreignId));
			expect(still?.label).toBe("theirs");
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("does not touch a foreign row sharing the same sortOrder when a first write forks a private copy", async () => {
		// THIS is the test that isolates the templateId predicate as
		// load-bearing. A meeting's first write matches by SORTORDER, not id
		// (finding #3) — the row it read off the pre-fork SHARED template no
		// longer exists by that id in the fresh copy. Seed a foreign row at
		// sortOrder 0 in a totally unrelated club's template, point THIS
		// meeting at a different shared template whose one row is ALSO sortOrder
		// 0, then mutate: the fork's private copy lands its one row at
		// sortOrder 0 too. A mutating statement matching on sortOrder alone,
		// with no templateId in its WHERE, would delete the copy's row AND the
		// unrelated foreign row AND the shared source's own row in one
		// statement — three rows for a "remove one row" request.
		const { other, foreignId } = await seedForeignRow();
		try {
			const [shared] = await testDb
				.insert(meetingTemplates)
				.values({ key: `shared_fork_${RUN}`, name: `Shared fork ${RUN}` })
				.returning({ id: meetingTemplates.id });
			if (!shared) throw new Error("template insert failed");
			madeTemplates.push(shared.id);
			await testDb.insert(meetingTemplateBeats).values({
				templateId: shared.id,
				sortOrder: 0,
				kind: "event",
				label: "Shared beat",
				minutes: 5,
			});
			await testDb
				.update(meetings)
				.set({ templateId: shared.id })
				.where(eq(meetings.id, club.meetingId));

			const draft = await loadAgendaDraft(club.meetingId);
			const row = draft?.rows[0];
			if (!row) throw new Error("no rows");
			expect(row.sortOrder).toBe(0);

			await removeAgendaRow({ meetingId: club.meetingId, rowId: row.id });

			// The shared source's own row survives — the fork COPIES, it does
			// not edit in place.
			const sharedRows = await testDb
				.select({ id: meetingTemplateBeats.id })
				.from(meetingTemplateBeats)
				.where(eq(meetingTemplateBeats.templateId, shared.id));
			expect(sharedRows).toHaveLength(1);

			// The unrelated foreign row, in a different club's template
			// entirely, is untouched.
			const foreignRows = await testDb
				.select({ id: meetingTemplateBeats.id })
				.from(meetingTemplateBeats)
				.where(eq(meetingTemplateBeats.id, foreignId));
			expect(foreignRows).toHaveLength(1);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("does not touch a foreign row sharing the same sortOrder when a first write forks a private copy (update)", async () => {
		// Same shape as the removeAgendaRow version above, isolating
		// updateAgendaRow's OWN translation path instead: when the caller's row
		// id came from another template, `translateRow` re-finds the row by
		// `(templateId, sortOrder)` and the write is scoped to the id it
		// returns. A mutating statement resolved on sortOrder alone, with no
		// templateId in its WHERE, would write this patch onto the copy's row
		// AND the unrelated foreign row AND the shared source's own row all at
		// once — three rows patched for a "rename one row" request.
		const { other, foreignId } = await seedForeignRow();
		try {
			const [shared] = await testDb
				.insert(meetingTemplates)
				.values({
					key: `shared_fork_upd_${RUN}`,
					name: `Shared fork upd ${RUN}`,
				})
				.returning({ id: meetingTemplates.id });
			if (!shared) throw new Error("template insert failed");
			madeTemplates.push(shared.id);
			await testDb.insert(meetingTemplateBeats).values({
				templateId: shared.id,
				sortOrder: 0,
				kind: "event",
				label: "Shared beat",
				minutes: 5,
			});
			await testDb
				.update(meetings)
				.set({ templateId: shared.id })
				.where(eq(meetings.id, club.meetingId));

			const draft = await loadAgendaDraft(club.meetingId);
			const row = draft?.rows[0];
			if (!row) throw new Error("no rows");
			expect(row.sortOrder).toBe(0);

			await updateAgendaRow({
				meetingId: club.meetingId,
				rowId: row.id,
				patch: { label: "renamed" },
			});

			// The shared source's own row is untouched — the fork COPIES, it
			// does not edit in place.
			const [sharedRow] = await testDb
				.select({ label: meetingTemplateBeats.label })
				.from(meetingTemplateBeats)
				.where(eq(meetingTemplateBeats.templateId, shared.id));
			expect(sharedRow?.label).toBe("Shared beat");

			// The unrelated foreign row, in a different club's template
			// entirely, is untouched.
			const [foreignRow] = await testDb
				.select({ label: meetingTemplateBeats.label })
				.from(meetingTemplateBeats)
				.where(eq(meetingTemplateBeats.id, foreignId));
			expect(foreignRow?.label).toBe("theirs");
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});
});

describe.skipIf(!hasTestDb)("agenda role mutations", () => {
	it("adds a role, materializes it, and makes it claimable", async () => {
		await givePrivateTemplate();
		const role = await addAgendaRole({
			meetingId: club.meetingId,
			name: "Zoom Master",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});
		expect(role.key).toMatch(/^[a-z0-9_]+$/);

		// A role with no `role_definitions` row cannot own a slot —
		// role_slots.role_definition_id is NOT NULL and restricting — so an
		// unmaterialized role is a row nobody can ever sign up for.
		const draft = await loadAgendaDraft(club.meetingId);
		expect(draft?.roles.map((r) => r.name)).toContain("Zoom Master");
		const defs = await testDb
			.select({ name: roleDefinitions.name })
			.from(roleDefinitions)
			.where(eq(roleDefinitions.clubId, club.clubId));
		expect(defs.map((d) => d.name)).toContain("Zoom Master");
		const slots = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.where(
				and(
					eq(roleSlots.meetingId, club.meetingId),
					eq(roleDefinitions.key, role.key),
				),
			);
		expect(slots).toHaveLength(1);
	});

	it("derives a unique key when two roles share a name", async () => {
		await givePrivateTemplate();
		const a = await addAgendaRole({
			meetingId: club.meetingId,
			name: "Judge",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});
		const b = await addAgendaRole({
			meetingId: club.meetingId,
			name: "Judge",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});
		expect(a.key).not.toBe(b.key);
	});

	it("refuses to add past the role ceiling", async () => {
		// ABSOLUTE: symmetric with `addAgendaRow`'s beat-ceiling test above —
		// enforced at the writer as well as `loadTemplateRoles`, so an officer
		// holding the button cannot build a role set the renderer would then
		// silently truncate.
		const id = await givePrivateTemplate();
		// `givePrivateTemplate` already declares one role ("chair"); fill the
		// rest of the ceiling with fillers.
		await testDb.insert(meetingTemplateRoles).values(
			Array.from({ length: MAX_TEMPLATE_ROLES - 1 }, (_, i) => ({
				templateId: id,
				key: `filler_role_${i}`,
				name: `Filler ${i}`,
				category: "functionary" as const,
				defaultCount: 1,
				sortOrder: 1000 + i,
				isSpeakerRole: false,
			})),
		);
		await expect(
			addAgendaRole({
				meetingId: club.meetingId,
				name: "One Too Many",
				category: "functionary",
				defaultCount: 1,
				isSpeakerRole: false,
			}),
		).rejects.toThrow(
			`This agenda has too many roles (max ${MAX_TEMPLATE_ROLES}).`,
		);
	});

	it("refuses a defaultCount below zero", async () => {
		await givePrivateTemplate();
		await expect(
			addAgendaRole({
				meetingId: club.meetingId,
				name: "Negative Places",
				category: "functionary",
				defaultCount: -1,
				isSpeakerRole: false,
			}),
		).rejects.toThrow(
			`A role can have between 0 and ${MAX_ROLE_REPEAT_SLOTS} places.`,
		);
	});

	it("refuses a defaultCount past the repeat-slot ceiling", async () => {
		await givePrivateTemplate();
		await expect(
			addAgendaRole({
				meetingId: club.meetingId,
				name: "Too Many Places",
				category: "functionary",
				defaultCount: MAX_ROLE_REPEAT_SLOTS + 1,
				isSpeakerRole: false,
			}),
		).rejects.toThrow(
			`A role can have between 0 and ${MAX_ROLE_REPEAT_SLOTS} places.`,
		);
	});

	it("refuses a role name past the label length cap", async () => {
		// Code points, not UTF-16 units — same distinction
		// `updateAgendaRow`'s label cap test makes for a beat's `label`; this is
		// the same cap enforced on a role's `name` at `addAgendaRole` instead.
		await givePrivateTemplate();
		await expect(
			addAgendaRole({
				meetingId: club.meetingId,
				name: "🎤".repeat(MAX_TEMPLATE_LABEL_CHARS + 1),
				category: "functionary",
				defaultCount: 1,
				isSpeakerRole: false,
			}),
		).rejects.toThrow(
			`That role name is too long (max ${MAX_TEMPLATE_LABEL_CHARS} characters).`,
		);
	});

	it("materializes a pre-existing role under the fork's private copy, and re-points this meeting's own slot to it, without duplicating on a later add (task-8b)", async () => {
		// A meeting still on a shared template, with "chair" already
		// materialized against the SHARED templateId (the legacy shape — see
		// `resolveHeldSlotsForRole`'s docblock). Adding "Zoom Master" forks a
		// private copy.
		//
		// Before task-8b, `ensureAgendaDraft`'s fork materialized NOTHING, so
		// "chair" stayed un-migrated under the shared templateId and this
		// meeting's own "chair" slot stayed pointed at it too — the exact bug
		// that left the "+ Add role" picker empty. `ensureAgendaDraft` now
		// materializes the copied template's WHOLE declared role set and
		// re-points this meeting's own slots to match
		// (task-8b-brief.md), so "chair" now gets its OWN row under the
		// private copy and the meeting's slot follows it there — this test's
		// old expectations (one "chair" row, unmoved, still on `shared.id`)
		// described the bug, not the contract.
		//
		// The second `addAgendaRole` call below is NOT a regression guard
		// against `addAgendaRole` itself calling the whole-set
		// `materializeTemplateRoles` again: if it did, the attempt to
		// re-insert "chair" would hit
		// `role_definitions_club_template_key_unique` and
		// `onConflictDoNothing` would swallow it silently, leaving the SAME
		// count this test asserts either way. That hazard is defanged by the
		// unique index, not by this assertion. What this section actually
		// pins is the steady state: the fork leaves exactly two "chair" rows
		// (the untouched original plus the one it materialized), and a
		// second, unrelated `addAgendaRole` call does not disturb that count.
		const [shared] = await testDb
			.insert(meetingTemplates)
			.values({
				key: `shared_add_role_${RUN}`,
				name: `Shared add role ${RUN}`,
			})
			.returning({ id: meetingTemplates.id });
		if (!shared) throw new Error("template insert failed");
		madeTemplates.push(shared.id);
		await testDb.insert(meetingTemplateRoles).values({
			templateId: shared.id,
			key: "chair",
			name: "Chair",
			category: "leadership",
			defaultCount: 1,
			sortOrder: 0,
			isSpeakerRole: false,
		});
		const [chairDef] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: club.clubId,
				templateId: shared.id,
				key: "chair",
				name: "Chair",
				category: "leadership",
				defaultCount: 1,
				sortOrder: 0,
				isSpeakerRole: false,
			})
			.returning({ id: roleDefinitions.id });
		if (!chairDef) throw new Error("role definition insert failed");
		const [chairSlot] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: club.meetingId,
				roleDefinitionId: chairDef.id,
				slotIndex: 0,
				status: "open",
			})
			.returning({ id: roleSlots.id });
		if (!chairSlot) throw new Error("role slot insert failed");
		await testDb
			.update(meetings)
			.set({ templateId: shared.id })
			.where(eq(meetings.id, club.meetingId));

		await addAgendaRole({
			meetingId: club.meetingId,
			name: "Zoom Master",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});

		const [afterFirstAdd] = await testDb
			.select({ templateId: meetings.templateId })
			.from(meetings)
			.where(eq(meetings.id, club.meetingId));
		const privateTemplateId = afterFirstAdd?.templateId;
		if (!privateTemplateId) throw new Error("meeting has no template");
		expect(privateTemplateId).not.toBe(shared.id);

		// "chair" now has TWO rows: the untouched original under the shared
		// template (a sibling meeting may still need it), and a fresh one the
		// fork materialized under the meeting's own new private template.
		const chairDefs = await testDb
			.select({
				id: roleDefinitions.id,
				templateId: roleDefinitions.templateId,
			})
			.from(roleDefinitions)
			.where(
				and(
					eq(roleDefinitions.clubId, club.clubId),
					eq(roleDefinitions.key, "chair"),
				),
			);
		expect(chairDefs).toHaveLength(2);
		const original = chairDefs.find((d) => d.id === chairDef.id);
		expect(original?.templateId).toBe(shared.id);
		const forked = chairDefs.find((d) => d.id !== chairDef.id);
		if (!forked) throw new Error("no forked chair definition");
		expect(forked.templateId).toBe(privateTemplateId);

		// The meeting's own pre-existing "chair" slot followed to the new
		// definition — same slot id, new role_definition_id.
		const [chairSlotAfter] = await testDb
			.select({ roleDefinitionId: roleSlots.roleDefinitionId })
			.from(roleSlots)
			.where(eq(roleSlots.id, chairSlot.id));
		expect(chairSlotAfter?.roleDefinitionId).toBe(forked.id);

		// A second, unrelated `addAgendaRole` call — now against the
		// already-private template, so `ensureAgendaDraft` takes the early
		// "own" return and never touches "chair" at all — leaves the count
		// exactly where the fork put it. (Per the comment above this test's
		// fixture, this cannot distinguish that from a hypothetical
		// regression that re-ran the whole-set materialize instead: the
		// unique index would silently no-op the re-insert either way.)
		await addAgendaRole({
			meetingId: club.meetingId,
			name: "Ballot Counter",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});
		const chairDefsAfterSecondAdd = await testDb
			.select({ id: roleDefinitions.id })
			.from(roleDefinitions)
			.where(
				and(
					eq(roleDefinitions.clubId, club.clubId),
					eq(roleDefinitions.key, "chair"),
				),
			);
		expect(chairDefsAfterSecondAdd).toHaveLength(2);
	});

	it("makes an added role's key immediately usable by a beat's roleKey", async () => {
		// Correction 3: adding a role must make its key immediately usable by
		// beats — `assertDeclaredRoleKeys` checks `meeting_template_roles`, which
		// `addAgendaRole` writes to before returning.
		await givePrivateTemplate();
		const role = await addAgendaRole({
			meetingId: club.meetingId,
			name: "Zoom Master",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});
		const draft = await loadAgendaDraft(club.meetingId);
		const row = draft?.rows.find((r) => r.kind === "section");
		if (!row) throw new Error("no section row");
		await updateAgendaRow({
			meetingId: club.meetingId,
			rowId: row.id,
			patch: { roleKey: role.key },
		});
		const after = await loadAgendaDraft(club.meetingId);
		expect(after?.rows.find((r) => r.id === row.id)?.roleKey).toBe(role.key);
	});

	it("names the people a role removal would release, BEFORE removing", async () => {
		// The dialog leads with names because a released holder cannot be told:
		// notifications.slot_id is NOT NULL and ON DELETE CASCADE to role_slots,
		// so a row enqueued against a slot the same transaction deletes is
		// destroyed before the poller sees it.
		await givePrivateTemplate();
		const role = await addAgendaRole({
			meetingId: club.meetingId,
			name: "Zoom Master",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});
		await claimFirstSlotFor(role.key, club.memberId);

		const plan = await planRoleRemoval({
			meetingId: club.meetingId,
			roleKey: role.key,
		});
		expect(plan).toHaveLength(1);
		expect(plan[0]?.name).toBeTruthy();
		// And nothing was destroyed by ASKING.
		const still = await loadAgendaDraft(club.meetingId);
		expect(still?.roles.map((r) => r.key)).toContain(role.key);
		const stillSlots = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.where(
				and(
					eq(roleSlots.meetingId, club.meetingId),
					eq(roleDefinitions.key, role.key),
				),
			);
		expect(stillSlots).toHaveLength(1);
	});

	it("removes the role, its slots, and the rows bound to it by roleKey AND repeatsRoleKey", async () => {
		const id = await givePrivateTemplate();
		const role = await addAgendaRole({
			meetingId: club.meetingId,
			name: "Zoom Master",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});
		await claimFirstSlotFor(role.key, club.memberId);

		const draft = await loadAgendaDraft(club.meetingId);
		const anyRow = draft?.rows.find((r) => r.kind === "role");
		if (!anyRow) throw new Error("no role row");
		await updateAgendaRow({
			meetingId: club.meetingId,
			rowId: anyRow.id,
			patch: { roleKey: role.key },
		});

		// Correction 2: a row bound via `repeatsRoleKey` alone (no `roleKey`) is
		// the shape of the seeded contest's ballot minute — a non-role row inside
		// a repeat block. `updateAgendaRow` only edits EXISTING rows, so this one
		// is seeded directly.
		const [repeatBoundRow] = await testDb
			.insert(meetingTemplateBeats)
			.values({
				templateId: id,
				sortOrder: 2,
				kind: "event",
				label: "Ballot collected",
				repeatsRoleKey: role.key,
				minutes: 1,
			})
			.returning({ id: meetingTemplateBeats.id });
		if (!repeatBoundRow) throw new Error("repeat-bound beat insert failed");

		const released = await removeAgendaRole({
			meetingId: club.meetingId,
			roleKey: role.key,
			actorMemberId: null,
		});
		expect(released).toHaveLength(1);

		const after = await loadAgendaDraft(club.meetingId);
		expect(after?.roles.map((r) => r.key)).not.toContain(role.key);
		// A row pointing at a role the template no longer declares is DROPPED by
		// buildTemplateRows, so leaving it behind would be an invisible row that
		// silently reappears if the key is ever reused.
		expect(after?.rows.map((r) => r.id)).not.toContain(anyRow.id);
		expect(after?.rows.map((r) => r.id)).not.toContain(repeatBoundRow.id);

		// The role_definitions row and its slot are gone too, not just the
		// template-side declaration.
		const defs = await testDb
			.select({ id: roleDefinitions.id })
			.from(roleDefinitions)
			.where(
				and(
					eq(roleDefinitions.clubId, club.clubId),
					eq(roleDefinitions.key, role.key),
				),
			);
		expect(defs).toHaveLength(0);

		// The now-undeclared key is immediately refused again, same as any other
		// key the template has never declared.
		const anotherRow = after?.rows[0];
		if (!anotherRow) throw new Error("no rows left");
		await expect(
			updateAgendaRow({
				meetingId: club.meetingId,
				rowId: anotherRow.id,
				patch: { roleKey: role.key },
			}),
		).rejects.toThrow(/not a role this template declares/i);
	});

	it("deletes the role_definitions row of a role holding NO slot, so its name stays reusable", async () => {
		// A role can legitimately hold zero slots: `addAgendaRole` accepts
		// `defaultCount: 0`, and `agenda-editor.tsx`'s Places field coerces an
		// EMPTY input to 0, so this happens by accident rather than only on
		// purpose. `resolveHeldSlotsForRole` resolves the doomed definitions
		// THROUGH this meeting's own slots, so with no slot there is nothing to
		// resolve — which is exactly why the definition delete must not be
		// conditional on having resolved one.
		await givePrivateTemplate();
		const role = await addAgendaRole({
			meetingId: club.meetingId,
			name: "Zoom Master",
			category: "functionary",
			defaultCount: 0,
			isSpeakerRole: false,
		});
		const slotsBefore = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.where(
				and(
					eq(roleSlots.meetingId, club.meetingId),
					eq(roleDefinitions.key, role.key),
				),
			);
		expect(slotsBefore).toHaveLength(0);

		const released = await removeAgendaRole({
			meetingId: club.meetingId,
			roleKey: role.key,
			actorMemberId: null,
		});
		expect(released).toHaveLength(0);

		// [[SYMPTOM 1]] The definition outlives its own declaration and its beats.
		const orphans = await testDb
			.select({ id: roleDefinitions.id })
			.from(roleDefinitions)
			.where(
				and(
					eq(roleDefinitions.clubId, club.clubId),
					eq(roleDefinitions.key, role.key),
				),
			);
		expect(orphans).toHaveLength(0);

		// [[SYMPTOM 2]] It stays `enabled` and template-scoped, so the meeting
		// page's "+ Add role" picker keeps offering a role the agenda no longer
		// declares. That picker reads `role_definitions`, never
		// `meeting_template_roles`, so the declaration delete alone is invisible
		// to it.
		const draft = await loadAgendaDraft(club.meetingId);
		if (!draft) throw new Error("no draft");
		const offered = await listRoleDefinitions(club.clubId, {
			onlyEnabled: true,
			templateId: draft.templateId,
		});
		expect(offered.map((r) => r.name)).not.toContain("Zoom Master");

		// [[SYMPTOM 3]] and the worst one: `deriveRoleKey` uniquifies against
		// `meeting_template_roles` ONLY, so re-adding the same name derives the
		// SAME key and the plain insert violates
		// `role_definitions_club_template_key_unique` — permanently, since
		// nothing in the product can clear the orphan. Asserting the KEY rather
		// than merely "it resolved" is what proves the re-add reused the freed
		// name instead of quietly becoming `zoom_master_2`.
		const again = await addAgendaRole({
			meetingId: club.meetingId,
			name: "Zoom Master",
			category: "functionary",
			defaultCount: 0,
			isSpeakerRole: false,
		});
		expect(again.key).toBe(role.key);
	});

	it("deletes the role_definitions row when the meeting's last slot for the role was removed first", async () => {
		// The second route to the same zero-slot state, and the one an officer
		// reaches without ever touching the Places field: `applyRemoveRoleSlot`
		// (the meeting page's per-slot remove) has no last-slot guard, so every
		// slot of a role can be taken away before the role itself is removed.
		// The delete below is the exact statement that server fn issues; calling
		// it directly would drag its own lock and speaker-pairing gates into a
		// test about `removeAgendaRole`.
		await givePrivateTemplate();
		const role = await addAgendaRole({
			meetingId: club.meetingId,
			name: "Ballot Counter",
			category: "functionary",
			defaultCount: 2,
			isSpeakerRole: false,
		});
		const mine = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.where(
				and(
					eq(roleSlots.meetingId, club.meetingId),
					eq(roleDefinitions.key, role.key),
				),
			);
		expect(mine).toHaveLength(2);
		for (const slot of mine) {
			await testDb.delete(roleSlots).where(eq(roleSlots.id, slot.id));
		}

		await removeAgendaRole({
			meetingId: club.meetingId,
			roleKey: role.key,
			actorMemberId: null,
		});

		const orphans = await testDb
			.select({ id: roleDefinitions.id })
			.from(roleDefinitions)
			.where(
				and(
					eq(roleDefinitions.clubId, club.clubId),
					eq(roleDefinitions.key, role.key),
				),
			);
		expect(orphans).toHaveLength(0);
		const again = await addAgendaRole({
			meetingId: club.meetingId,
			name: "Ballot Counter",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});
		expect(again.key).toBe(role.key);
	});

	it("leaves sortOrder at 0..N-1 with no gaps after removing a role's beats", async () => {
		// `renumberRows` states that every writer in this module keeps sortOrder
		// gapless, and its negative-floor first pass is only safe because of it.
		// The role removal deleted beats without renumbering, so a template that
		// had been through one read 0,2,3 — harmless in isolation, and exactly the
		// kind of quietly-false invariant that breaks the next writer to trust it.
		const id = await givePrivateTemplate();
		const role = await addAgendaRole({
			meetingId: club.meetingId,
			name: "Zoom Master",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});
		// Two more rows, so the deleted one sits in the MIDDLE and its removal
		// leaves a hole rather than trimming the tail.
		await testDb.insert(meetingTemplateBeats).values([
			{
				templateId: id,
				sortOrder: 2,
				kind: "role",
				label: "Zoom check",
				roleKey: role.key,
				minutes: 2,
			},
			{
				templateId: id,
				sortOrder: 3,
				kind: "event",
				label: "Close",
				minutes: 1,
			},
		]);

		await removeAgendaRole({
			meetingId: club.meetingId,
			roleKey: role.key,
			actorMemberId: null,
		});

		const after = await loadAgendaDraft(club.meetingId);
		expect(after?.rows.map((r) => r.sortOrder)).toEqual(
			after?.rows.map((_, i) => i),
		);
		expect(after?.rows.map((r) => r.label)).toEqual([
			"OPENING",
			"Welcome",
			"Close",
		]);
	});

	it("refuses to remove an undeclared role WITHOUT forking a shared template", async () => {
		// Mirrors why `addAgendaRow`/`updateAgendaRow` resolve a caller-supplied
		// row BEFORE `ensureAgendaDraft` runs (`findRow`'s docblock): a fork is a
		// real write, and a bad key must not trigger one for what is really a
		// no-op removal.
		const [shared] = await testDb
			.insert(meetingTemplates)
			.values({ key: `shared_role_${RUN}`, name: `Shared role ${RUN}` })
			.returning({ id: meetingTemplates.id });
		if (!shared) throw new Error("template insert failed");
		madeTemplates.push(shared.id);
		await testDb.insert(meetingTemplateRoles).values({
			templateId: shared.id,
			key: "timer",
			name: "Timer",
			category: "functionary",
			defaultCount: 1,
			sortOrder: 0,
			isSpeakerRole: false,
		});
		await testDb
			.update(meetings)
			.set({ templateId: shared.id })
			.where(eq(meetings.id, club.meetingId));

		await expect(
			removeAgendaRole({
				meetingId: club.meetingId,
				roleKey: "not-a-declared-role",
				actorMemberId: null,
			}),
		).rejects.toThrow(/not a role this template declares/i);

		// Still pointing at the SHARED template — no fork happened.
		const [after] = await testDb
			.select({ templateId: meetings.templateId })
			.from(meetings)
			.where(eq(meetings.id, club.meetingId));
		expect(after?.templateId).toBe(shared.id);
	});

	it("logs the removal to activity_log with the released count", async () => {
		await givePrivateTemplate();
		const role = await addAgendaRole({
			meetingId: club.meetingId,
			name: "Zoom Master",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});
		await claimFirstSlotFor(role.key, club.memberId);

		await removeAgendaRole({
			meetingId: club.meetingId,
			roleKey: role.key,
			actorMemberId: club.adminMemberId,
		});

		const rows = await testDb
			.select({ action: activityLog.action, detail: activityLog.detail })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, club.clubId),
					eq(activityLog.action, "meeting_agenda_role_removed"),
				),
			);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.detail).toMatchObject({ roleKey: role.key, released: 1 });
	});

	// This is the shape `resolveHeldSlotsForRole`'s docblock calls out as the
	// COMMON case, not the edge case: a meeting created before per-meeting
	// private templates existed points straight at a SHARED template, and its
	// role_definitions were materialized against THAT SAME shared templateId —
	// never a private copy, because nothing forks one until the first edit.
	// `removeAgendaRole`'s first version resolved which `role_definitions` to
	// touch by matching `templateId` against `ensureAgendaDraft`'s POST-fork
	// pointer — which is a brand-new id nothing has materialized against yet
	// — so the actually-held slot was silently left claimed while the officer
	// was told it had been released.
	//
	// role_definitions is keyed per (club, template), not per meeting, so a
	// SECOND meeting of the SAME club sharing the same not-yet-forked
	// template is a realistic, not a contrived, fixture — every one of a
	// club's meetings that hasn't been individually customized shares one
	// materialized role set. It is also what makes the ownership-gated
	// `role_definitions` delete load-bearing: without it, removing the role
	// from meeting 1 would try to delete a definition meeting 2's own live
	// slot still references.
	it("releases and deletes the actually-held slot when the meeting is still on a shared template (fork-on-write)", async () => {
		const [shared] = await testDb
			.insert(meetingTemplates)
			.values({
				key: `shared_role_fork_${RUN}`,
				name: `Shared role fork ${RUN}`,
			})
			.returning({ id: meetingTemplates.id });
		if (!shared) throw new Error("template insert failed");
		madeTemplates.push(shared.id);
		await testDb.insert(meetingTemplateRoles).values({
			templateId: shared.id,
			key: "zoom_master",
			name: "Zoom Master",
			category: "functionary",
			defaultCount: 1,
			sortOrder: 0,
			isSpeakerRole: false,
		});
		await testDb.insert(meetingTemplateBeats).values({
			templateId: shared.id,
			sortOrder: 0,
			kind: "role",
			label: "Zoom slot",
			roleKey: "zoom_master",
			minutes: 1,
		});
		// Materialized directly against the SHARED templateId — the shape
		// `materializeTemplateRoles`'s two call sites never produce today, but
		// which legacy (pre-per-meeting-template) meetings still have, per
		// `loadAgendaDraft`'s "correction 1" docblock.
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: club.clubId,
				templateId: shared.id,
				key: "zoom_master",
				name: "Zoom Master",
				category: "functionary",
				defaultCount: 1,
				sortOrder: 0,
				isSpeakerRole: false,
			})
			.returning({ id: roleDefinitions.id });
		if (!def) throw new Error("role definition insert failed");

		// Meeting 1 (club.meetingId): points at the shared template, CLAIMED
		// slot against the shared definition.
		await testDb
			.update(meetings)
			.set({ templateId: shared.id })
			.where(eq(meetings.id, club.meetingId));
		const [slot1] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: club.meetingId,
				roleDefinitionId: def.id,
				slotIndex: 0,
				assignedMemberId: club.memberId,
				status: "claimed",
			})
			.returning({ id: roleSlots.id });
		if (!slot1) throw new Error("slot insert failed");

		// Meeting 2: same club, ALSO still on the shared template, with its OWN
		// open slot against the SAME shared definition. Cascade-cleaned by the
		// module's `cleanup(club.clubId, ...)` (meetings.clubId is ON DELETE
		// CASCADE) — no separate teardown needed.
		const [meeting2] = await testDb
			.insert(meetings)
			.values({
				clubId: club.clubId,
				scheduledAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
				templateId: shared.id,
			})
			.returning({ id: meetings.id });
		if (!meeting2) throw new Error("meeting insert failed");
		const [slot2] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: meeting2.id,
				roleDefinitionId: def.id,
				slotIndex: 0,
				status: "open",
			})
			.returning({ id: roleSlots.id });
		if (!slot2) throw new Error("slot insert failed");

		const released = await removeAgendaRole({
			meetingId: club.meetingId,
			roleKey: "zoom_master",
			actorMemberId: null,
		});

		// The actually-held slot is named AND removed — not silently left
		// claimed while being reported as released.
		expect(released).toHaveLength(1);
		expect(released[0]?.memberId).toBe(club.memberId);
		const slot1After = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.where(eq(roleSlots.id, slot1.id));
		expect(slot1After).toHaveLength(0);

		// The shared definition is NOT owned by meeting 1's newly forked
		// private template, so it survives — meeting 2's still-live slot
		// depends on it.
		const defAfter = await testDb
			.select({ id: roleDefinitions.id })
			.from(roleDefinitions)
			.where(eq(roleDefinitions.id, def.id));
		expect(defAfter).toHaveLength(1);

		// Meeting 2's own slot is completely untouched.
		const slot2After = await testDb
			.select({ status: roleSlots.status })
			.from(roleSlots)
			.where(eq(roleSlots.id, slot2.id));
		expect(slot2After).toHaveLength(1);
		expect(slot2After[0]?.status).toBe("open");

		// Meeting 1's own (newly forked, private) agenda no longer declares the
		// role...
		const after1 = await loadAgendaDraft(club.meetingId);
		expect(after1?.roles.map((r) => r.key)).not.toContain("zoom_master");
		// ...but meeting 2, still pointed at the untouched shared template,
		// still does.
		const after2 = await loadAgendaDraft(meeting2.id);
		expect(after2?.roles.map((r) => r.key)).toContain("zoom_master");
	});

	// Role mutations have no id to match on — `roleKey` is a caller-chosen
	// STRING — so two clubs' PRIVATE templates independently declaring the
	// IDENTICAL key is the fixture that forces scoping to matter.
	//
	// The `role_definitions`/`role_slots` half is protected a different way
	// than the row mutators' rowId-scoping: `resolveHeldSlotsForRole` resolves
	// which definitions to touch via `roleSlots.meetingId = <this meeting>` —
	// an exact join, not a templateId/clubId match — so the foreign meeting's
	// slot and definition can never be selected in the first place, by
	// construction, regardless of any other predicate. That half of this test
	// is a regression guard, not a "strip and confirm" discriminator.
	//
	// The `meeting_template_beats`/`meeting_template_roles` half IS a live
	// discriminator: both deletes are scoped ONLY by
	// `eq(..., templateId)` (the meeting's own resolved private template —
	// there is no `clubId` column on either table to fall back on). Confirmed
	// by temporarily dropping the `templateId` conjunct from both of
	// `removeAgendaRole`'s deletes and re-running this test: it fails — the
	// foreign beat (same `roleKey`, different template) gets deleted too.
	// See the task report for the exact diff and failure output.
	it("does not touch a foreign meeting's identically-keyed role, slot or beat", async () => {
		await givePrivateTemplate();
		const role = await addAgendaRole({
			meetingId: club.meetingId,
			name: "Zoom Master",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});
		const {
			other,
			foreignTemplateId,
			foreignDefId,
			foreignSlotId,
			foreignBeatId,
		} = await seedForeignRole(role.key);
		try {
			await claimFirstSlotFor(role.key, club.memberId);

			await removeAgendaRole({
				meetingId: club.meetingId,
				roleKey: role.key,
				actorMemberId: null,
			});

			// Own role gone.
			const ownAfter = await loadAgendaDraft(club.meetingId);
			expect(ownAfter?.roles.map((r) => r.key)).not.toContain(role.key);

			// Foreign role_definitions row survives.
			const foreignDef = await testDb
				.select({ id: roleDefinitions.id })
				.from(roleDefinitions)
				.where(eq(roleDefinitions.id, foreignDefId));
			expect(foreignDef).toHaveLength(1);

			// Foreign slot survives, and is STILL claimed — a removal scoped to
			// the wrong template would have released or deleted it.
			const foreignSlot = await testDb
				.select({
					status: roleSlots.status,
					assignedMemberId: roleSlots.assignedMemberId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, foreignSlotId));
			expect(foreignSlot).toHaveLength(1);
			expect(foreignSlot[0]?.status).toBe("claimed");
			expect(foreignSlot[0]?.assignedMemberId).toBe(other.memberId);

			// Foreign beat (bound by roleKey) survives.
			const foreignBeat = await testDb
				.select({ id: meetingTemplateBeats.id })
				.from(meetingTemplateBeats)
				.where(eq(meetingTemplateBeats.id, foreignBeatId));
			expect(foreignBeat).toHaveLength(1);

			// Foreign meeting_template_roles declaration survives.
			const foreignRoleRow = await testDb
				.select({ key: meetingTemplateRoles.key })
				.from(meetingTemplateRoles)
				.where(eq(meetingTemplateRoles.templateId, foreignTemplateId));
			expect(foreignRoleRow.map((r) => r.key)).toContain(role.key);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});
});

// ---------------------------------------------------------------------------
// Task 8b: `ensureAgendaDraft`'s fork left `role_definitions` (and therefore
// `role_slots`) behind on the OLD shared template, so a meeting converted
// before per-meeting private templates existed got its `meetings.template_id`
// flipped to a private copy with NO materialized roles at all — emptying the
// "+ Add role" picker (`meetings.ts:358-363`, `listRoleDefinitions`) the
// moment an officer made its very first edit. See
// `.superpowers/sdd/2026-08-21-configurable-agendas/task-8b-brief.md`.
// ---------------------------------------------------------------------------
describe.skipIf(!hasTestDb)(
	"ensureAgendaDraft materializes and re-points role_definitions on fork (task-8b)",
	() => {
		/**
		 * A shared (club-less) template declaring "zoom_master", materialized
		 * DIRECTLY against the shared templateId — the shape
		 * `materializeTemplateRoles`'s two call sites never produce today but
		 * which every meeting converted before per-meeting private templates
		 * existed is actually in (same fixture shape as the `removeAgendaRole`
		 * fork tests above). Optionally also declares "timer" and materializes
		 * it with a NULL `key` — data shaped like `matchesRole`'s docblock calls
		 * "data predating #368".
		 */
		async function seedSharedTemplateWithRoles(opts?: {
			nullKeySecondRole?: boolean;
		}): Promise<{
			sharedTemplateId: string;
			zoomDefId: string;
			timerDefId?: string;
		}> {
			const suffix = Math.random().toString(36).slice(2, 8);
			const [shared] = await testDb
				.insert(meetingTemplates)
				.values({
					key: `shared_8b_${RUN}_${suffix}`,
					name: `Shared 8b ${RUN}`,
				})
				.returning({ id: meetingTemplates.id });
			if (!shared) throw new Error("template insert failed");
			madeTemplates.push(shared.id);

			await testDb.insert(meetingTemplateRoles).values({
				templateId: shared.id,
				key: "zoom_master",
				name: "Zoom Master",
				category: "functionary",
				defaultCount: 1,
				sortOrder: 0,
				isSpeakerRole: false,
			});
			const [zoomDef] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: club.clubId,
					templateId: shared.id,
					key: "zoom_master",
					name: "Zoom Master",
					category: "functionary",
					defaultCount: 1,
					sortOrder: 0,
					isSpeakerRole: false,
				})
				.returning({ id: roleDefinitions.id });
			if (!zoomDef) throw new Error("role definition insert failed");

			let timerDefId: string | undefined;
			if (opts?.nullKeySecondRole) {
				// The TEMPLATE declares "timer" with a key — `meeting_template_roles
				// .key` is NOT NULL, so a freshly materialized row always has one.
				// This meeting's EXISTING materialized definition does not: it was
				// seeded directly, standing in for a row that predates the `key`
				// column doing any binding at all.
				await testDb.insert(meetingTemplateRoles).values({
					templateId: shared.id,
					key: "timer",
					name: "Timer",
					category: "functionary",
					defaultCount: 1,
					sortOrder: 10,
					isSpeakerRole: false,
				});
				const [timerDef] = await testDb
					.insert(roleDefinitions)
					.values({
						clubId: club.clubId,
						templateId: shared.id,
						key: null,
						name: "Timer",
						category: "functionary",
						defaultCount: 1,
						sortOrder: 10,
						isSpeakerRole: false,
					})
					.returning({ id: roleDefinitions.id });
				if (!timerDef) throw new Error("role definition insert failed");
				timerDefId = timerDef.id;
			}

			return {
				sharedTemplateId: shared.id,
				zoomDefId: zoomDef.id,
				timerDefId,
			};
		}

		/** Puts `club.meetingId` on the shared template with one open "zoom_master"
		 *  slot and a beat an officer can edit to trigger the fork. Returns the
		 *  beat id `updateAgendaRow` forks against. */
		async function putMeetingOnSharedTemplate(
			sharedTemplateId: string,
			zoomDefId: string,
		): Promise<string> {
			const [beat] = await testDb
				.insert(meetingTemplateBeats)
				.values({
					templateId: sharedTemplateId,
					sortOrder: 0,
					kind: "role",
					label: "Zoom slot",
					roleKey: "zoom_master",
					minutes: 1,
				})
				.returning({ id: meetingTemplateBeats.id });
			if (!beat) throw new Error("beat insert failed");
			await testDb
				.update(meetings)
				.set({ templateId: sharedTemplateId })
				.where(eq(meetings.id, club.meetingId));
			await testDb.insert(roleSlots).values({
				meetingId: club.meetingId,
				roleDefinitionId: zoomDefId,
				slotIndex: 0,
				status: "open",
			});
			return beat.id;
		}

		it("[[SYMPTOM]] leaves the '+ Add role' picker empty until fixed — a fork must materialize the copied template's roles", async () => {
			const { sharedTemplateId, zoomDefId } =
				await seedSharedTemplateWithRoles();
			const beatId = await putMeetingOnSharedTemplate(
				sharedTemplateId,
				zoomDefId,
			);

			// The officer's write — editing one row's minutes, the brief's own
			// example — which `ensureAgendaDraft` upgrades into a fork on this
			// meeting's first edit.
			await updateAgendaRow({
				meetingId: club.meetingId,
				rowId: beatId,
				patch: { minutes: 5 },
			});

			const [after] = await testDb
				.select({ templateId: meetings.templateId })
				.from(meetings)
				.where(eq(meetings.id, club.meetingId));
			const newTemplateId = after?.templateId;
			if (!newTemplateId) throw new Error("meeting has no template");
			expect(newTemplateId).not.toBe(sharedTemplateId); // confirms a fork happened

			// This IS the symptom: before the fix, the private copy has no
			// materialized role_definitions at all, so this comes back empty.
			const picker = await listRoleDefinitions(club.clubId, {
				onlyEnabled: true,
				templateId: newTemplateId,
			});
			expect(picker.length).toBeGreaterThan(0);
			expect(picker.map((r) => r.name)).toContain("Zoom Master");
		});

		it("re-points the meeting's own slot to the new definition, keeping its assignee, evaluatesSlotId pairing and speech", async () => {
			const { sharedTemplateId } = await seedSharedTemplateWithRoles();
			await testDb.insert(meetingTemplateRoles).values([
				{
					templateId: sharedTemplateId,
					key: "speaker",
					name: "Speaker",
					category: "speaker",
					defaultCount: 1,
					sortOrder: 20,
					isSpeakerRole: true,
				},
				{
					templateId: sharedTemplateId,
					key: "evaluator",
					name: "Evaluator",
					category: "evaluator",
					defaultCount: 1,
					sortOrder: 30,
					isSpeakerRole: false,
				},
			]);
			const [speakerDef] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: club.clubId,
					templateId: sharedTemplateId,
					key: "speaker",
					name: "Speaker",
					category: "speaker",
					defaultCount: 1,
					sortOrder: 20,
					isSpeakerRole: true,
				})
				.returning({ id: roleDefinitions.id });
			const [evalDef] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: club.clubId,
					templateId: sharedTemplateId,
					key: "evaluator",
					name: "Evaluator",
					category: "evaluator",
					defaultCount: 1,
					sortOrder: 30,
					isSpeakerRole: false,
				})
				.returning({ id: roleDefinitions.id });
			if (!speakerDef || !evalDef) throw new Error("def insert failed");

			const [beat] = await testDb
				.insert(meetingTemplateBeats)
				.values({
					templateId: sharedTemplateId,
					sortOrder: 0,
					kind: "role",
					label: "Speaker slot",
					roleKey: "speaker",
					minutes: 5,
				})
				.returning({ id: meetingTemplateBeats.id });
			if (!beat) throw new Error("beat insert failed");
			await testDb
				.update(meetings)
				.set({ templateId: sharedTemplateId })
				.where(eq(meetings.id, club.meetingId));

			const [speech] = await testDb
				.insert(speeches)
				.values({ personId: club.personId, title: "My Icebreaker" })
				.returning({ id: speeches.id });
			if (!speech) throw new Error("speech insert failed");

			const [speakerSlot] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: club.meetingId,
					roleDefinitionId: speakerDef.id,
					slotIndex: 0,
					assignedMemberId: club.memberId,
					status: "claimed",
					speechId: speech.id,
				})
				.returning({ id: roleSlots.id });
			if (!speakerSlot) throw new Error("slot insert failed");

			const [evalSlot] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: club.meetingId,
					roleDefinitionId: evalDef.id,
					slotIndex: 0,
					assignedMemberId: club.adminMemberId,
					status: "claimed",
					evaluatesSlotId: speakerSlot.id,
				})
				.returning({ id: roleSlots.id });
			if (!evalSlot) throw new Error("slot insert failed");

			await updateAgendaRow({
				meetingId: club.meetingId,
				rowId: beat.id,
				patch: { minutes: 7 },
			});

			const [after] = await testDb
				.select({ templateId: meetings.templateId })
				.from(meetings)
				.where(eq(meetings.id, club.meetingId));
			const newTemplateId = after?.templateId;
			if (!newTemplateId) throw new Error("meeting has no template");

			const [speakerAfter] = await testDb
				.select({
					roleDefinitionId: roleSlots.roleDefinitionId,
					assignedMemberId: roleSlots.assignedMemberId,
					speechId: roleSlots.speechId,
					status: roleSlots.status,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, speakerSlot.id));
			if (!speakerAfter) throw new Error("speaker slot vanished");
			expect(speakerAfter.assignedMemberId).toBe(club.memberId);
			expect(speakerAfter.speechId).toBe(speech.id);
			expect(speakerAfter.status).toBe("claimed");
			expect(speakerAfter.roleDefinitionId).not.toBe(speakerDef.id);
			const [speakerDefAfter] = await testDb
				.select({ templateId: roleDefinitions.templateId })
				.from(roleDefinitions)
				.where(eq(roleDefinitions.id, speakerAfter.roleDefinitionId));
			expect(speakerDefAfter?.templateId).toBe(newTemplateId);

			const [evalAfter] = await testDb
				.select({
					roleDefinitionId: roleSlots.roleDefinitionId,
					assignedMemberId: roleSlots.assignedMemberId,
					evaluatesSlotId: roleSlots.evaluatesSlotId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, evalSlot.id));
			if (!evalAfter) throw new Error("evaluator slot vanished");
			expect(evalAfter.assignedMemberId).toBe(club.adminMemberId);
			// The slot's OWN id never changes — only role_definition_id does — so
			// a pairing by slot id survives the fork untouched.
			expect(evalAfter.evaluatesSlotId).toBe(speakerSlot.id);
			const [evalDefAfter] = await testDb
				.select({ templateId: roleDefinitions.templateId })
				.from(roleDefinitions)
				.where(eq(roleDefinitions.id, evalAfter.roleDefinitionId));
			expect(evalDefAfter?.templateId).toBe(newTemplateId);
		});

		it("leaves a sibling meeting on the same shared template untouched", async () => {
			const { sharedTemplateId, zoomDefId } =
				await seedSharedTemplateWithRoles();
			const beatId = await putMeetingOnSharedTemplate(
				sharedTemplateId,
				zoomDefId,
			);

			const [meeting2] = await testDb
				.insert(meetings)
				.values({
					clubId: club.clubId,
					scheduledAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
					templateId: sharedTemplateId,
				})
				.returning({ id: meetings.id });
			if (!meeting2) throw new Error("meeting insert failed");
			const [slot2] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: meeting2.id,
					roleDefinitionId: zoomDefId,
					slotIndex: 0,
					status: "open",
				})
				.returning({ id: roleSlots.id });
			if (!slot2) throw new Error("slot insert failed");

			await updateAgendaRow({
				meetingId: club.meetingId,
				rowId: beatId,
				patch: { minutes: 9 },
			});

			// The sibling's own slot is completely untouched — still the OLD def.
			const [slot2After] = await testDb
				.select({ roleDefinitionId: roleSlots.roleDefinitionId })
				.from(roleSlots)
				.where(eq(roleSlots.id, slot2.id));
			expect(slot2After?.roleDefinitionId).toBe(zoomDefId);

			// The old shared definition was left alone, not moved to the fork's
			// new private template.
			const [zoomDefAfter] = await testDb
				.select({ templateId: roleDefinitions.templateId })
				.from(roleDefinitions)
				.where(eq(roleDefinitions.id, zoomDefId));
			expect(zoomDefAfter?.templateId).toBe(sharedTemplateId);

			// The sibling's own agenda (still reading the untouched shared
			// template) still declares the role.
			const sibling = await loadAgendaDraft(meeting2.id);
			expect(sibling?.roles.map((r) => r.key)).toContain("zoom_master");
		});

		it("a second write does not fork again or duplicate definitions", async () => {
			const { sharedTemplateId, zoomDefId } =
				await seedSharedTemplateWithRoles();
			const beatId = await putMeetingOnSharedTemplate(
				sharedTemplateId,
				zoomDefId,
			);

			await updateAgendaRow({
				meetingId: club.meetingId,
				rowId: beatId,
				patch: { minutes: 5 },
			});
			const [afterFirst] = await testDb
				.select({ templateId: meetings.templateId })
				.from(meetings)
				.where(eq(meetings.id, club.meetingId));
			const privateId = afterFirst?.templateId;
			if (!privateId) throw new Error("meeting has no template");
			expect(privateId).not.toBe(sharedTemplateId);

			// Second edit: the template is now private, so `findRow` matches by
			// the row's own id (see `findRow`'s docblock) — fetch it fresh.
			const draft = await loadAgendaDraft(club.meetingId);
			const rowId = draft?.rows[0]?.id;
			if (!rowId) throw new Error("no row to edit");
			await updateAgendaRow({
				meetingId: club.meetingId,
				rowId,
				patch: { minutes: 6 },
			});

			const [afterSecond] = await testDb
				.select({ templateId: meetings.templateId })
				.from(meetings)
				.where(eq(meetings.id, club.meetingId));
			expect(afterSecond?.templateId).toBe(privateId); // no second fork

			const defsUnderPrivate = await testDb
				.select({ id: roleDefinitions.id })
				.from(roleDefinitions)
				.where(
					and(
						eq(roleDefinitions.clubId, club.clubId),
						eq(roleDefinitions.templateId, privateId),
					),
				);
			expect(defsUnderPrivate).toHaveLength(1); // not duplicated
		});

		it("matches a NULL-key old definition to the new one by name, so the slot is re-pointed rather than orphaned", async () => {
			const { sharedTemplateId, timerDefId } =
				await seedSharedTemplateWithRoles({ nullKeySecondRole: true });
			if (!timerDefId) throw new Error("timer definition missing");

			const [beat] = await testDb
				.insert(meetingTemplateBeats)
				.values({
					templateId: sharedTemplateId,
					sortOrder: 0,
					kind: "role",
					label: "Timer slot",
					roleKey: "timer",
					minutes: 1,
				})
				.returning({ id: meetingTemplateBeats.id });
			if (!beat) throw new Error("beat insert failed");
			await testDb
				.update(meetings)
				.set({ templateId: sharedTemplateId })
				.where(eq(meetings.id, club.meetingId));
			const [timerSlot] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: club.meetingId,
					roleDefinitionId: timerDefId,
					slotIndex: 0,
					assignedMemberId: club.memberId,
					status: "claimed",
				})
				.returning({ id: roleSlots.id });
			if (!timerSlot) throw new Error("slot insert failed");

			await updateAgendaRow({
				meetingId: club.meetingId,
				rowId: beat.id,
				patch: { minutes: 2 },
			});

			const [after] = await testDb
				.select({ templateId: meetings.templateId })
				.from(meetings)
				.where(eq(meetings.id, club.meetingId));
			const newTemplateId = after?.templateId;
			if (!newTemplateId) throw new Error("meeting has no template");

			const [timerSlotAfter] = await testDb
				.select({
					roleDefinitionId: roleSlots.roleDefinitionId,
					assignedMemberId: roleSlots.assignedMemberId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, timerSlot.id));
			if (!timerSlotAfter) throw new Error("timer slot vanished");
			// Not silently orphaned: the assignee survives...
			expect(timerSlotAfter.assignedMemberId).toBe(club.memberId);
			// ...and the slot was actually re-pointed, not left on the old def.
			expect(timerSlotAfter.roleDefinitionId).not.toBe(timerDefId);

			const [newDef] = await testDb
				.select({
					templateId: roleDefinitions.templateId,
					key: roleDefinitions.key,
					name: roleDefinitions.name,
				})
				.from(roleDefinitions)
				.where(eq(roleDefinitions.id, timerSlotAfter.roleDefinitionId));
			// Now belongs to the meeting's OWN (new, private) template...
			expect(newDef?.templateId).toBe(newTemplateId);
			expect(newDef?.name).toBe("Timer");
			// ...and matched by name landed it on the freshly materialized row,
			// which (unlike the old one) DOES carry a key — `materializeTemplateRoles`
			// always copies `meeting_template_roles.key`, which is NOT NULL.
			expect(newDef?.key).toBe("timer");

			// The OLD null-key definition was left alone, not moved or deleted.
			const [oldDefAfter] = await testDb
				.select({ templateId: roleDefinitions.templateId })
				.from(roleDefinitions)
				.where(eq(roleDefinitions.id, timerDefId));
			expect(oldDefAfter?.templateId).toBe(sharedTemplateId);
		});

		it("skips an ambiguous NULL-key name match rather than picking a definition nondeterministically", async () => {
			const { sharedTemplateId } = await seedSharedTemplateWithRoles();
			// Two DIFFERENT keyed roles sharing the SAME display name "Chair" —
			// no unique index stops that, and `addAgendaRole`'s own "derives a
			// unique key when two roles share a name" test proves it's a real
			// shape, not a contrived one.
			await testDb.insert(meetingTemplateRoles).values([
				{
					templateId: sharedTemplateId,
					key: "chair_a",
					name: "Chair",
					category: "leadership",
					defaultCount: 1,
					sortOrder: 20,
					isSpeakerRole: false,
				},
				{
					templateId: sharedTemplateId,
					key: "chair_b",
					name: "Chair",
					category: "leadership",
					defaultCount: 1,
					sortOrder: 30,
					isSpeakerRole: false,
				},
			]);
			await testDb.insert(roleDefinitions).values([
				{
					clubId: club.clubId,
					templateId: sharedTemplateId,
					key: "chair_a",
					name: "Chair",
					category: "leadership",
					defaultCount: 1,
					sortOrder: 20,
					isSpeakerRole: false,
				},
				{
					clubId: club.clubId,
					templateId: sharedTemplateId,
					key: "chair_b",
					name: "Chair",
					category: "leadership",
					defaultCount: 1,
					sortOrder: 30,
					isSpeakerRole: false,
				},
			]);

			// The OLD definition this meeting's slot actually references: NULL
			// key, the same ambiguous "Chair" name as the two new ones above.
			const [ambiguousDef] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: club.clubId,
					templateId: sharedTemplateId,
					key: null,
					name: "Chair",
					category: "leadership",
					defaultCount: 1,
					sortOrder: 10,
					isSpeakerRole: false,
				})
				.returning({ id: roleDefinitions.id });
			if (!ambiguousDef) throw new Error("role definition insert failed");

			const [beat] = await testDb
				.insert(meetingTemplateBeats)
				.values({
					templateId: sharedTemplateId,
					sortOrder: 0,
					kind: "event",
					label: "Opening remarks",
					minutes: 1,
				})
				.returning({ id: meetingTemplateBeats.id });
			if (!beat) throw new Error("beat insert failed");
			await testDb
				.update(meetings)
				.set({ templateId: sharedTemplateId })
				.where(eq(meetings.id, club.meetingId));
			const [ambiguousSlot] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: club.meetingId,
					roleDefinitionId: ambiguousDef.id,
					slotIndex: 0,
					assignedMemberId: club.memberId,
					status: "claimed",
				})
				.returning({ id: roleSlots.id });
			if (!ambiguousSlot) throw new Error("slot insert failed");

			await updateAgendaRow({
				meetingId: club.meetingId,
				rowId: beat.id,
				patch: { minutes: 3 },
			});

			// NOT migrated — an ambiguous name match is skipped, never guessed
			// at nondeterministically.
			const [ambiguousSlotAfter] = await testDb
				.select({
					roleDefinitionId: roleSlots.roleDefinitionId,
					assignedMemberId: roleSlots.assignedMemberId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, ambiguousSlot.id));
			if (!ambiguousSlotAfter) throw new Error("ambiguous slot vanished");
			expect(ambiguousSlotAfter.roleDefinitionId).toBe(ambiguousDef.id);
			// Not lost either — still assigned, just left where it was rather
			// than silently landing on "chair_a" or "chair_b".
			expect(ambiguousSlotAfter.assignedMemberId).toBe(club.memberId);
		});
	},
);

/**
 * Ship review C2. `ensureAgendaDraft` looked for a private copy, found none,
 * and called `copyTemplateForMeeting` with no lock on the `meetings` row and
 * no conflict handling. Two writes landing together on an UNFORKED meeting
 * therefore both took the fork path, and
 * `meeting_templates_meeting_unique` rejected the second INSERT.
 *
 * Not a crafted request: the editor's text inputs are not disabled while a
 * save is in flight (only move/remove use `pending`), so blurring Label and
 * immediately changing Minutes fires two concurrent POSTs. Reproduced as one
 * officer seeing `Failed query: insert into "meeting_templates" ("id",
 * "club_id", "meeting_id", …)` in a toast — `runAction` toasts
 * `err.message` verbatim — while the surviving draft had lost the other edit
 * entirely.
 */
describe.skipIf(!hasTestDb)(
	"concurrent first write on a shared template",
	() => {
		/** A GLOBAL template with two rows, pointed at by `club.meetingId` — the
		 *  pre-private-copy shape every unedited converted meeting is in. */
		async function giveSharedTemplate(): Promise<{
			templateId: string;
			rowIds: string[];
		}> {
			const [shared] = await testDb
				.insert(meetingTemplates)
				.values({
					key: `race_${RUN}_${crypto.randomUUID().slice(0, 8)}`,
					name: "Raced",
				})
				.returning({ id: meetingTemplates.id });
			if (!shared) throw new Error("template insert failed");
			madeTemplates.push(shared.id);
			const rows = await testDb
				.insert(meetingTemplateBeats)
				.values([
					{
						templateId: shared.id,
						sortOrder: 0,
						kind: "event" as const,
						label: "First",
						minutes: 1,
					},
					{
						templateId: shared.id,
						sortOrder: 1,
						kind: "event" as const,
						label: "Second",
						minutes: 2,
					},
				])
				.returning({
					id: meetingTemplateBeats.id,
					sortOrder: meetingTemplateBeats.sortOrder,
				});
			await testDb
				.update(meetings)
				.set({ templateId: shared.id })
				.where(eq(meetings.id, club.meetingId));
			return {
				templateId: shared.id,
				rowIds: rows.sort((a, b) => a.sortOrder - b.sortOrder).map((r) => r.id),
			};
		}

		it("lands BOTH edits, and leaks no SQL to the officer", async () => {
			const { templateId: sharedId, rowIds } = await giveSharedTemplate();
			const [firstRow, secondRow] = rowIds;
			if (!firstRow || !secondRow) throw new Error("fixture produced no rows");

			const results = await Promise.allSettled([
				updateAgendaRow({
					meetingId: club.meetingId,
					rowId: firstRow,
					patch: { label: "Renamed by A" },
				}),
				updateAgendaRow({
					meetingId: club.meetingId,
					rowId: secondRow,
					patch: { minutes: 42 },
				}),
			]);

			// Asserted on the REASON, not just the status: a bare `toBe("fulfilled")`
			// says nothing about what the officer would have read, and the SQL dump
			// is half of what makes this a CRITICAL rather than a retryable failure.
			for (const r of results) {
				if (r.status === "rejected") {
					throw new Error(
						`concurrent write rejected: ${(r.reason as Error)?.message}`,
					);
				}
			}

			const draft = await loadAgendaDraft(club.meetingId);
			if (!draft) throw new Error("draft vanished");
			if (draft.templateId !== sharedId) madeTemplates.push(draft.templateId);
			// Exactly ONE private copy exists, and the meeting points at it.
			const copies = await testDb
				.select({ id: meetingTemplates.id })
				.from(meetingTemplates)
				.where(eq(meetingTemplates.meetingId, club.meetingId));
			expect(copies).toHaveLength(1);
			expect(draft.templateId).toBe(copies[0]?.id);

			// And NEITHER edit was lost — the half a lock alone does not fix, since
			// the loser's row ids belong to the template it read before the winner
			// forked.
			expect(draft.rows.map((r) => r.label)).toEqual([
				"Renamed by A",
				"Second",
			]);
			expect(draft.rows.map((r) => r.minutes)).toEqual([1, 42]);

			// The shared template is untouched: the race must not have written
			// through to the row every other club reads.
			const sharedRows = await testDb
				.select({
					label: meetingTemplateBeats.label,
					minutes: meetingTemplateBeats.minutes,
				})
				.from(meetingTemplateBeats)
				.where(eq(meetingTemplateBeats.templateId, sharedId));
			expect(sharedRows.map((r) => r.label).sort()).toEqual([
				"First",
				"Second",
			]);
			expect(sharedRows.map((r) => r.minutes).sort()).toEqual([1, 2]);
		});
	},
);

/**
 * The residual arm of the same fix, reproduced deterministically rather than
 * by racing.
 *
 * `ensureAgendaDraft` takes a `conn`, and a caller passing the bare `db`
 * rather than a transaction holds the `FOR UPDATE` row lock only for the
 * length of that one statement — so two such calls really can both reach the
 * INSERT. The state the loser then finds itself in is exactly what this test
 * SEEDS: a private copy already exists for the meeting while
 * `meetings.template_id` still names the shared template it read a moment
 * ago. Seeded rather than raced because a test that only fails on one
 * interleaving is a test that mostly cannot fail — a `Promise.allSettled`
 * version of this passed with the catch deleted, five runs out of five.
 *
 * Without the catch this rejects with the driver's own `Failed query: insert
 * into "meeting_templates" ("id", "club_id", "meeting_id", …)`, which
 * `runAction` toasts at the officer verbatim.
 */
describe.skipIf(!hasTestDb)("ensureAgendaDraft under a lost fork race", () => {
	it("adopts the existing copy instead of surfacing a unique violation", async () => {
		const [shared] = await testDb
			.insert(meetingTemplates)
			.values({
				key: `residual_${RUN}_${crypto.randomUUID().slice(0, 8)}`,
				name: "Residual",
			})
			.returning({ id: meetingTemplates.id });
		if (!shared) throw new Error("template insert failed");
		madeTemplates.push(shared.id);
		await testDb.insert(meetingTemplateBeats).values({
			templateId: shared.id,
			sortOrder: 0,
			kind: "event",
			label: "Only row",
			minutes: 1,
		});
		await testDb
			.update(meetings)
			.set({ templateId: shared.id })
			.where(eq(meetings.id, club.meetingId));

		// The winner's copy, committed while this caller still believes the
		// meeting is on the shared template.
		const [winner] = await testDb
			.insert(meetingTemplates)
			.values({
				clubId: club.clubId,
				meetingId: club.meetingId,
				key: `residual_${RUN}_${crypto.randomUUID().slice(0, 8)}`,
				name: "Winner",
			})
			.returning({ id: meetingTemplates.id });
		if (!winner) throw new Error("winner insert failed");
		madeTemplates.push(winner.id);

		const handle = await ensureAgendaDraft(testDb, club.meetingId);
		expect(handle.templateId).toBe(winner.id);
		expect(handle.forked).toBe(false);
		// And the rolled-back insert left no SECOND copy behind.
		const copies = await testDb
			.select({ id: meetingTemplates.id })
			.from(meetingTemplates)
			.where(eq(meetingTemplates.meetingId, club.meetingId));
		expect(copies).toHaveLength(1);
	});
});

/**
 * The hole the fix that added `addressableTemplateIds`' source arm opened.
 *
 * Resolving a caller's row id against the SHARED template a private copy was
 * forked from, then re-locating it in the copy by `(templateId, sortOrder)`,
 * is exact ONLY while the copy is still verbatim. `renumberRows` reassigns a
 * dense 0..N-1 on every add, move and remove, so one inserted or deleted row
 * shifts every later `sortOrder` by one — and a caller still holding the
 * shared template's ids (a stale tab, a second editor) then translates onto a
 * DIFFERENT beat and has it patched, deleted or reordered, with a success
 * response either way.
 *
 * Before that arm shipped, the same request threw "That agenda row is not part
 * of this meeting." — a safe, visible rejection. These tests pin that it does
 * again. The shipped concurrency test above cannot see any of this: both of
 * its concurrent calls are `updateAgendaRow`, which never renumbers, so its
 * one interleaving is exactly the case where the translation IS exact.
 */
describe.skipIf(!hasTestDb)("translation onto a diverged private copy", () => {
	/** A GLOBAL template with four distinguishable rows, pointed at by
	 *  `club.meetingId` — an unedited converted meeting, whose row ids are what
	 *  a page loaded before any edit is holding. */
	async function giveSharedFourRows(): Promise<{
		sharedId: string;
		first: string;
		second: string;
	}> {
		const [shared] = await testDb
			.insert(meetingTemplates)
			.values({
				key: `diverge_${RUN}_${crypto.randomUUID().slice(0, 8)}`,
				name: "Diverged",
			})
			.returning({ id: meetingTemplates.id });
		if (!shared) throw new Error("template insert failed");
		madeTemplates.push(shared.id);
		const rows = await testDb
			.insert(meetingTemplateBeats)
			.values(
				["First", "Second", "Third", "Fourth"].map((label, i) => ({
					templateId: shared.id,
					sortOrder: i,
					kind: "event" as const,
					label,
					minutes: i,
				})),
			)
			.returning({
				id: meetingTemplateBeats.id,
				sortOrder: meetingTemplateBeats.sortOrder,
			});
		await testDb
			.update(meetings)
			.set({ templateId: shared.id })
			.where(eq(meetings.id, club.meetingId));
		const ordered = rows.sort((a, b) => a.sortOrder - b.sortOrder);
		const [first, second] = ordered;
		if (!first || !second) throw new Error("fixture produced no rows");
		return { sharedId: shared.id, first: first.id, second: second.id };
	}

	/**
	 * Fork the private copy AND renumber it, which is the state no existing
	 * test reaches: removing the row at sortOrder 0 shifts every later row down
	 * by one, so the shared template's sortOrder 1 ("Second") now names "Third"
	 * over here. Asserted rather than assumed — if the fixture ever stops
	 * diverging, the tests below would pass for the wrong reason.
	 */
	async function forkAndShift(firstRowId: string): Promise<void> {
		await removeAgendaRow({ meetingId: club.meetingId, rowId: firstRowId });
		const draft = await loadAgendaDraft(club.meetingId);
		if (!draft) throw new Error("draft vanished");
		madeTemplates.push(draft.templateId);
		expect(draft.rows.map((r) => r.label)).toEqual([
			"Second",
			"Third",
			"Fourth",
		]);
		expect(draft.rows.map((r) => r.sortOrder)).toEqual([0, 1, 2]);
	}

	/** The copy's labels, read back through the same seam the officer sees. */
	async function currentLabels(): Promise<string[]> {
		const draft = await loadAgendaDraft(club.meetingId);
		if (!draft) throw new Error("draft vanished");
		return draft.rows.map((r) => r.label);
	}

	/**
	 * The message the call rejected with, or `"resolved"`.
	 *
	 * Deliberately not `rejects.toThrow`: that assertion short-circuits, so
	 * without the guard every one of these tests fails on "did not reject" and
	 * says nothing about what it DID. Captured instead, so the agenda's own
	 * state can be asserted first and the failure names the beat that was
	 * silently rewritten.
	 */
	async function outcomeOf(call: Promise<unknown>): Promise<string> {
		return call.then(
			() => "resolved",
			(err: Error) => err.message,
		);
	}

	const REFUSED = "That agenda row is not part of this meeting.";
	const UNCHANGED = ["Second", "Third", "Fourth"];

	it("refuses an UPDATE that would land on a neighbouring beat", async () => {
		const { first, second } = await giveSharedFourRows();
		await forkAndShift(first);

		const outcome = await outcomeOf(
			updateAgendaRow({
				meetingId: club.meetingId,
				rowId: second,
				patch: { label: "Hijacked" },
			}),
		);

		// "Third" — the beat sitting at the translated sortOrder — is untouched.
		expect(await currentLabels()).toEqual(UNCHANGED);
		expect(outcome).toBe(REFUSED);
	});

	it("refuses a REMOVE that would delete a neighbouring beat", async () => {
		const { first, second } = await giveSharedFourRows();
		await forkAndShift(first);

		const outcome = await outcomeOf(
			removeAgendaRow({ meetingId: club.meetingId, rowId: second }),
		);

		// The neighbour still exists — this is the destructive half.
		expect(await currentLabels()).toEqual(UNCHANGED);
		expect(outcome).toBe(REFUSED);
	});

	it("refuses a MOVE that would reorder a neighbouring beat", async () => {
		const { first, second } = await giveSharedFourRows();
		await forkAndShift(first);

		const outcome = await outcomeOf(
			moveAgendaRow({
				meetingId: club.meetingId,
				rowId: second,
				direction: "down",
			}),
		);

		expect(await currentLabels()).toEqual(UNCHANGED);
		expect(outcome).toBe(REFUSED);
	});

	it("refuses an ADD that would insert after a neighbouring beat", async () => {
		const { first, second } = await giveSharedFourRows();
		await forkAndShift(first);

		const outcome = await outcomeOf(
			addAgendaRow({
				meetingId: club.meetingId,
				afterRowId: second,
				kind: "event",
			}),
		);

		expect(await currentLabels()).toEqual(UNCHANGED);
		expect(outcome).toBe(REFUSED);
	});

	/**
	 * The same defect one layer in. `assertMarks` and `assertRepeatBinding` run
	 * against the row `findRow` FOUND — on the shared template — and the write
	 * then lands on the copy, so a copy that has moved on is validated against
	 * a row that has not. The identity check alone does not close this: kind
	 * and label both still match, and only re-running the pair against the
	 * translated row refuses it.
	 */
	it("validates a patch against the row it will LAND on, not the one it found", async () => {
		const [shared] = await testDb
			.insert(meetingTemplates)
			.values({
				key: `marks_${RUN}_${crypto.randomUUID().slice(0, 8)}`,
				name: "Marks",
			})
			.returning({ id: meetingTemplates.id });
		if (!shared) throw new Error("template insert failed");
		madeTemplates.push(shared.id);
		const [sharedRow] = await testDb
			.insert(meetingTemplateBeats)
			.values({
				templateId: shared.id,
				sortOrder: 0,
				kind: "event",
				label: "Table Topics",
				minutes: 15,
			})
			.returning({ id: meetingTemplateBeats.id });
		if (!sharedRow) throw new Error("beat insert failed");
		await testDb
			.update(meetings)
			.set({ templateId: shared.id })
			.where(eq(meetings.id, club.meetingId));

		// Forks, and gives the COPY all three marks. The shared source, which
		// this caller's row id still names, has none.
		await updateAgendaRow({
			meetingId: club.meetingId,
			rowId: sharedRow.id,
			patch: { markGreen: 2, markYellow: 3, markRed: 4 },
		});
		const draft = await loadAgendaDraft(club.meetingId);
		if (!draft) throw new Error("draft vanished");
		madeTemplates.push(draft.templateId);

		// Merged against the SOURCE, this clears the only mark it has — "none",
		// which is legal. Merged against the COPY it leaves (null, 3, 4), the
		// silent hole `assertMarks` exists to refuse.
		const outcome = await outcomeOf(
			updateAgendaRow({
				meetingId: club.meetingId,
				rowId: sharedRow.id,
				patch: { markGreen: null },
			}),
		);

		// State first, for the reason `outcomeOf` exists: this is the line that
		// shows the hole.
		const after = await loadAgendaDraft(club.meetingId);
		expect([
			after?.rows[0]?.markGreen,
			after?.rows[0]?.markYellow,
			after?.rows[0]?.markRed,
		]).toEqual([2, 3, 4]);
		expect(outcome).toBe("Timing marks need all three values, or none.");
	});
});

/**
 * The deadlock the `FOR UPDATE` lock introduced, reproduced rather than
 * asserted about.
 *
 * `ensureAgendaDraft` takes `meetings FOR UPDATE` FIRST and re-points this
 * meeting's `role_slots` late; `applyTemplateConversion` writes `role_slots`
 * first and updates `meetings` LAST. Opposite orders over the same two
 * resources is a lock cycle, Postgres breaks it with SQLSTATE 40P01, and that
 * is not a unique violation — so before the catch, `runAction` toasted the
 * driver's own `deadlock detected` at an officer.
 *
 * Which pair cycles is worth being exact about, because the obvious one does
 * NOT. `meeting_templates.meeting_id` is a foreign key, so inserting a private
 * copy takes `FOR KEY SHARE` on the referenced `meetings` row — which the
 * edit's `FOR UPDATE` conflicts with. That serializes the two INSERT-vs-lock
 * orderings completely: whichever side reaches `meetings` first, the other
 * simply waits. `role_slots` is the resource with no such interlock, and the
 * conversion arm that reaches it with no `meetings` lock held at all is the
 * one that removes a template (`templateId === null`), which inserts nothing
 * and therefore takes nothing until its final update.
 *
 * The conversion side is played by hand — hold this meeting's slots, then ask
 * for its `meetings` row — because `applyTemplateConversion` opens its own
 * transaction and offers nowhere to pause between those two writes. Hand-played
 * so the cycle is BUILT rather than raced for; a version that just fires both
 * concurrently deadlocks on some interleavings and passes vacuously on the
 * rest. The ordering below decides only the VICTIM, since each waiter arms its
 * own `deadlock_timeout` (1s here) when it begins waiting and whichever fires
 * first runs the detector and aborts itself. Making the agenda edit wait first
 * makes it the side that reports.
 */
describe.skipIf(!hasTestDb)("ensureAgendaDraft against a conversion", () => {
	/** Block until a backend is actually WAITING to write `role_slots` — polled
	 *  rather than slept for, so the cycle is confirmed built instead of
	 *  assumed. Matched on the statement text as well as the wait, since a
	 *  parallel test FILE sharing `tm_test` can be waiting on something else. */
	async function waitForBlockedSlotWrite(): Promise<void> {
		for (let i = 0; i < 150; i++) {
			const waiting = await testDb.execute(
				sql`select count(*)::int as n from pg_stat_activity
				    where datname = current_database()
				      and wait_event_type = 'Lock'
				      and query ilike 'update "role_slots"%'`,
			);
			if (Number(waiting.rows[0]?.n ?? 0) > 0) return;
			await new Promise((r) => setTimeout(r, 20));
		}
		throw new Error("the agenda edit never blocked on role_slots");
	}

	it("reports a deadlock as a sentence, not the driver's message", async () => {
		const [shared] = await testDb
			.insert(meetingTemplates)
			.values({
				key: `deadlock_${RUN}_${crypto.randomUUID().slice(0, 8)}`,
				name: "Deadlocked",
			})
			.returning({ id: meetingTemplates.id });
		if (!shared) throw new Error("template insert failed");
		madeTemplates.push(shared.id);
		// A DECLARED role, materialized directly against the shared template and
		// claimed by a slot on this meeting — the pre-private-copy shape. It is
		// what makes `ensureAgendaDraft`'s re-point step reach `role_slots` at
		// all; without a matched definition the fork writes no slot and there is
		// no second resource to cycle over.
		await testDb.insert(meetingTemplateRoles).values({
			templateId: shared.id,
			key: "zoom_master",
			name: "Zoom Master",
			category: "functionary",
			defaultCount: 1,
			sortOrder: 0,
			isSpeakerRole: false,
		});
		const [zoomDef] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: club.clubId,
				templateId: shared.id,
				key: "zoom_master",
				name: "Zoom Master",
				category: "functionary",
				defaultCount: 1,
				sortOrder: 0,
				isSpeakerRole: false,
			})
			.returning({ id: roleDefinitions.id });
		if (!zoomDef) throw new Error("role definition insert failed");
		await testDb.insert(meetingTemplateBeats).values({
			templateId: shared.id,
			sortOrder: 0,
			kind: "role",
			label: "Zoom slot",
			roleKey: "zoom_master",
			minutes: 1,
		});
		await testDb
			.update(meetings)
			.set({ templateId: shared.id })
			.where(eq(meetings.id, club.meetingId));
		await testDb.insert(roleSlots).values({
			meetingId: club.meetingId,
			roleDefinitionId: zoomDef.id,
			slotIndex: 0,
			status: "open",
		});

		let slotsLocked!: () => void;
		const conversionHasSlots = new Promise<void>((r) => {
			slotsLocked = r;
		});
		let releaseConversion!: () => void;
		const conversionGate = new Promise<void>((r) => {
			releaseConversion = r;
		});
		// Thrown to roll the hand-played conversion back: whichever way the
		// deadlock falls, this test must leave the meeting as it found it.
		const ROLLBACK = new Error("rollback the hand-played conversion");

		const conversion = testDb.transaction(async (tx) => {
			// The conversion's re-point/release writes, in lock terms: this
			// meeting's slots, held while it still holds nothing on `meetings`.
			await tx
				.select({ id: roleSlots.id })
				.from(roleSlots)
				.where(eq(roleSlots.meetingId, club.meetingId))
				.for("update");
			slotsLocked();
			await conversionGate;
			// Its final statement — and the second half of the cycle, since the
			// edit is holding this row `FOR UPDATE`.
			await tx
				.update(meetings)
				.set({ templateId: null })
				.where(eq(meetings.id, club.meetingId));
			throw ROLLBACK;
		});

		// Started only once the conversion holds the slots, so the edit takes
		// `meetings` cleanly and blocks on the re-point.
		await conversionHasSlots;
		const edit = testDb.transaction((tx) =>
			ensureAgendaDraft(tx, club.meetingId),
		);
		await waitForBlockedSlotWrite();
		// Cushion, so the edit's `deadlock_timeout` is armed comfortably before
		// the conversion's and the victim is not decided by the poll interval.
		// It also absorbs a false positive from the poll: a parallel test file
		// blocked on its own `role_slots` write would release the conversion
		// early, and 250ms is far longer than the handful of statements the
		// edit needs to reach its own wait.
		await new Promise((r) => setTimeout(r, 250));
		releaseConversion();
		const [conversionResult, editResult] = await Promise.allSettled([
			conversion,
			edit,
		]);

		expect(editResult.status).toBe("rejected");
		const reason =
			editResult.status === "rejected"
				? (editResult.reason as Error)
				: new Error("the agenda edit was not the deadlock victim");
		expect(reason.message).toBe(
			"Someone else was changing this meeting. Please try again.",
		);
		// The whole point: none of the driver's own vocabulary reaches a toast.
		expect(reason.message).not.toMatch(/deadlock|Failed query|40P01/i);

		// The hand-played conversion rolled back either way — by its own throw
		// if it survived, by Postgres if it was the victim instead.
		expect(
			conversionResult.status === "rejected"
				? (conversionResult.reason as Error).message
				: "fulfilled",
		).not.toBe("fulfilled");
		const copies = await testDb
			.select({ id: meetingTemplates.id })
			.from(meetingTemplates)
			.where(eq(meetingTemplates.meetingId, club.meetingId));
		expect(copies).toEqual([]);
	});
});

describe.skipIf(!hasTestDb)(
	"the draft carries what the CLIENT clock needs",
	() => {
		it("round-trips the flex flag on a row", async () => {
			await givePrivateTemplate();
			const before = await loadAgendaDraft(club.meetingId);
			const row = before?.rows[0];
			expect(row).toBeDefined();
			expect(row?.flex).toBe(false);

			await updateAgendaRow({
				meetingId: club.meetingId,
				rowId: row?.id ?? "",
				patch: { flex: true },
			});

			const after = await loadAgendaDraft(club.meetingId);
			// Resolved by POSITION, not by id: the write may fork a private copy and
			// mint fresh row ids.
			expect(after?.rows[0]?.flex).toBe(true);
		});

		/**
		 * `flex` is required for CORRECTNESS, not only for the editor's pin control,
		 * and this is the test that says so.
		 *
		 * `buildTemplateRows` reads `row.flex` to mark the row `applyFlex` resizes.
		 * Drop the field from this payload and the client's `applyFlex` finds an
		 * empty `flexIndices` on every meeting forever — a permanent no-op whose
		 * only symptom is the editor's clock quietly disagreeing with the printed
		 * agenda. It fails in the direction that looks fine, so nothing else here
		 * can see it.
		 */
		it("exposes flex on EVERY row, so the client's applyFlex is not a no-op", async () => {
			await givePrivateTemplate();
			const draft = await loadAgendaDraft(club.meetingId);
			expect(draft?.rows.length).toBeGreaterThan(0);
			for (const r of draft?.rows ?? []) {
				expect(typeof r.flex).toBe("boolean");
			}
		});

		it("carries the meeting's start, timezone, length and run-of-show variant", async () => {
			await givePrivateTemplate();
			const draft = await loadAgendaDraft(club.meetingId);
			expect(draft).not.toBeNull();
			// An ISO string, not a Date: this crosses a server-fn boundary, and
			// `buildTimeline` already accepts `Date | string`.
			expect(typeof draft?.scheduledAt).toBe("string");
			expect(() =>
				new Date(draft?.scheduledAt ?? "").toISOString(),
			).not.toThrow();
			expect(typeof draft?.timeZone).toBe("string");
			expect(draft?.timeZone.length).toBeGreaterThan(0);
			expect(typeof draft?.lengthMinutes).toBe("number");
			expect(draft?.lengthMinutes).toBeGreaterThan(0);
			expect(typeof draft?.geIntroducesFunctionaries).toBe("boolean");
		});

		it("carries THIS meeting's slots, which the repeat block fans across", async () => {
			await givePrivateTemplate();
			const draft = await loadAgendaDraft(club.meetingId);
			expect(Array.isArray(draft?.slots)).toBe(true);
			// Not merely present — the seeded club has one slot, and a payload
			// carrying some OTHER meeting's slots would fan a repeat block across the
			// wrong count and put every clock below it out.
			expect(draft?.slots.length).toBeGreaterThan(0);
			for (const s of draft?.slots ?? []) {
				expect(typeof s.slotIndex).toBe("number");
				expect(typeof s.roleName).toBe("string");
			}
		});

		/**
		 * The property D4's "no invalidate after a pure edit" rests on.
		 *
		 * The FIRST write forks a private copy of a shared template and mints fresh
		 * row ids. The editor no longer reloads the route after a pure edit, so the
		 * client goes on holding the PRE-fork ids — and every later edit addresses
		 * rows by those. `findRow` resolves against both templates and translates by
		 * `(templateId, sortOrder)`, a mapping its own docblock says is exact only
		 * while the copy is verbatim; it stays verbatim because the only thing that
		 * renumbers is a structural edit, which still invalidates.
		 *
		 * That reasoning is three hops long and was guarded by a comment. This is
		 * the test.
		 */
		it("accepts a PRE-fork row id on a second pure edit", async () => {
			await giveSharedTemplate();
			const before = await loadAgendaDraft(club.meetingId);
			const firstId = before?.rows[0]?.id ?? "";
			const secondId = before?.rows[1]?.id ?? "";
			expect(firstId).not.toBe("");
			expect(secondId).not.toBe("");

			// Edit one: forks. Every row id on the meeting's template changes.
			await updateAgendaRow({
				meetingId: club.meetingId,
				rowId: firstId,
				patch: { minutes: 3 },
			});
			const forked = await loadAgendaDraft(club.meetingId);
			expect(forked?.rows[0]?.id).not.toBe(firstId);

			// Edit two, addressed by the id the client still holds from before the
			// fork. This is what the client actually does.
			await expect(
				updateAgendaRow({
					meetingId: club.meetingId,
					rowId: secondId,
					patch: { minutes: 4 },
				}),
			).resolves.toBeUndefined();

			const after = await loadAgendaDraft(club.meetingId);
			expect(after?.rows[0]?.minutes).toBe(3);
			expect(after?.rows[1]?.minutes).toBe(4);
		});
	},
);
