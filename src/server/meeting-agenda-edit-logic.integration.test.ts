/**
 * DB-backed tests for the per-meeting agenda editor: reads (Task 6) and row
 * mutations (Task 7).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5433/tm_test \
 *     bunx vitest run src/server/meeting-agenda-edit-logic.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	meetings,
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import {
	MAX_TEMPLATE_BEATS,
	MAX_TEMPLATE_LABEL_CHARS,
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
	loadAgendaDraft,
	moveAgendaRow,
	planRoleRemoval,
	removeAgendaRole,
	removeAgendaRow,
	updateAgendaRow,
} = await import("./meeting-agenda-edit-logic");

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

	it("removes a row", async () => {
		await givePrivateTemplate();
		const before = await loadAgendaDraft(club.meetingId);
		const target = before?.rows[0];
		if (!target) throw new Error("no rows");
		await removeAgendaRow({ meetingId: club.meetingId, rowId: target.id });
		const after = await loadAgendaDraft(club.meetingId);
		expect(after?.rows.map((r) => r.id)).not.toContain(target.id);
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
		// updateAgendaRow's OWN forked-path match instead: its `rowFilter` is
		// `eq(sortOrder, found.sortOrder)` when `forked` is true. A mutating
		// statement matching on sortOrder alone, with no templateId in its
		// WHERE, would write this patch onto the copy's row AND the unrelated
		// foreign row AND the shared source's own row all at once — three rows
		// patched for a "rename one row" request.
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

	// The rowId-scoping tests earlier in this file (`seedForeignRow`) prove
	// each row mutator's OWN templateId predicate is load-bearing by sharing a
	// sortOrder with a foreign row on an already-private template, where
	// matching by primary key alone would otherwise be safe. Role mutations
	// have no id to match on at all — `roleKey` is a caller-chosen STRING — so
	// the discriminator here is different: two clubs' PRIVATE templates
	// independently declaring the IDENTICAL key. `role_definitions.clubId`
	// differs between them, but so does `templateId` (a private template's id
	// is unique per meeting), so `templateId` alone already separates the two
	// rows. This test proves the removal statements actually READ that
	// predicate — confirmed by temporarily dropping the `templateId` conjunct
	// from `removeAgendaRole`'s four deletes/updates and re-running this test:
	// it fails (the `role_definitions` delete throws a foreign-key violation
	// from the foreign meeting's own still-live slot, which rolls back the
	// whole transaction, so even the CALLER's own role survives the failed
	// removal) — see the task report for the exact diff and failure output.
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
