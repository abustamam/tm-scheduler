/**
 * The Toastmaster's gated read for the planned-attendance panel (#576).
 *
 * This is the ONLY reachable gate on that grant. `resolveActor` — the write
 * side — is private to `attendance-plan.ts`, a `createServerFn` module, so it
 * cannot be invoked from vitest at all; its arms are pinned by
 * `attendance-plan-authz.guard.test.ts` instead. Everything a test CAN execute
 * about the TMOD grant is here.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/tmod-panel-data.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, meetings, roleDefinitions, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { setPlanStatus } = await import("#/server/attendance-plan-logic");
const { loadTmodPanelData } = await import("#/server/meetings-logic");

/** Give `meetingId` a Toastmaster slot held by `memberId`.
 *
 *  Inserts the role definition with `key: "toastmaster_of_the_day"` rather than
 *  relying on the display name, because that is what `findTmodSlot` matches on
 *  first — a test that seeded only the name would still pass while proving the
 *  weaker of the two rules. */
async function assignTmod(
	clubId: string,
	meetingId: string,
	memberId: string,
): Promise<void> {
	const [def] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId,
			name: "Toastmaster of the Day",
			key: "toastmaster_of_the_day",
			category: "leadership",
			sortOrder: 1,
		})
		.returning({ id: roleDefinitions.id });
	if (!def) throw new Error("failed to insert TMOD role definition");
	await testDb.insert(roleSlots).values({
		meetingId,
		roleDefinitionId: def.id,
		status: "confirmed",
		assignedMemberId: memberId,
	});
}

describe.skipIf(!hasTestDb)("loadTmodPanelData", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
		await setPlanStatus(testDb, {
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			status: "reached_out",
			actorMemberId: seed.adminMemberId,
		});
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("gives the meeting's Toastmaster the whole ladder and a roster with contact", async () => {
		await assignTmod(seed.clubId, seed.meetingId, seed.adminMemberId);

		const { plan, roster } = await loadTmodPanelData({
			meetingId: seed.meetingId,
			memberId: seed.adminMemberId,
		});

		// Anti-vacuity: every other case in this file asserts EMPTY, so without a
		// populated positive case a `return empty` at the top of the function
		// would satisfy the whole suite.
		expect(plan.length).toBeGreaterThan(0);
		expect(roster.length).toBeGreaterThan(0);
		// The officer-only rung is exactly what the TMOD is here for: without it
		// they re-chase someone another officer already asked.
		expect(plan).toContainEqual({
			memberId: seed.memberId,
			status: "reached_out",
		});
		// Contact is the point — no phone/email means no drafts, which is the
		// whole outreach affordance. `RosterContact` carries both fields, so
		// assert the SHAPE arrived rather than that this fixture populated them.
		expect(roster[0]).toHaveProperty("email");
		expect(roster[0]).toHaveProperty("phone");
	});

	it("gives a member who is NOT the Toastmaster nothing", async () => {
		await assignTmod(seed.clubId, seed.meetingId, seed.adminMemberId);

		const { plan, roster } = await loadTmodPanelData({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
		});

		expect(plan).toEqual([]);
		expect(roster).toEqual([]);
	});

	it("scopes the grant to ONE meeting — the TMOD of A gets nothing for B", async () => {
		// The fail-open case. A grant derived from "is this person a TMOD
		// anywhere" rather than "on THIS meeting" passes every other test in this
		// file, because every other test uses a single meeting.
		const [other] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		if (!other) throw new Error("failed to insert second meeting");
		// TMOD of the SEEDED meeting only.
		await assignTmod(seed.clubId, seed.meetingId, seed.adminMemberId);

		const onOwn = await loadTmodPanelData({
			meetingId: seed.meetingId,
			memberId: seed.adminMemberId,
		});
		const onOther = await loadTmodPanelData({
			meetingId: other.id,
			memberId: seed.adminMemberId,
		});

		expect(onOwn.plan.length).toBeGreaterThan(0);
		expect(onOther.plan).toEqual([]);
		expect(onOther.roster).toEqual([]);
	});

	it("grants nothing when the Toastmaster slot is unassigned", async () => {
		// `null === null` is the shape of the bug: an unassigned slot must not
		// mean "everyone qualifies". The seeded meeting has an OPEN slot and no
		// TMOD role at all, so this covers the absent case too.
		const { plan, roster } = await loadTmodPanelData({
			meetingId: seed.meetingId,
			memberId: seed.adminMemberId,
		});

		expect(plan).toEqual([]);
		expect(roster).toEqual([]);
	});

	it("gives the Toastmaster of an ARCHIVED club nothing", async () => {
		await assignTmod(seed.clubId, seed.meetingId, seed.adminMemberId);
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));

		const { plan, roster } = await loadTmodPanelData({
			meetingId: seed.meetingId,
			memberId: seed.adminMemberId,
		});

		expect(plan).toEqual([]);
		expect(roster).toEqual([]);
	});

	it("gives nothing for a meeting that does not exist", async () => {
		const { plan, roster } = await loadTmodPanelData({
			meetingId: "00000000-0000-0000-0000-000000000000",
			memberId: seed.adminMemberId,
		});

		expect(plan).toEqual([]);
		expect(roster).toEqual([]);
	});
});
