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
import {
	clubs,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
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
		// `seedClub` sets email but NOT phone, so an assertion that phone came back
		// null would pass whether the contact gate ran or not — the exact
		// "test that cannot fail" trap CLAUDE.md lists. Set one here so the
		// withheld cases below are bracketed by a positive case that proves a
		// non-null phone really does flow through the authorized path.
		await testDb
			.update(members)
			.set({ phone: "+12025550101" })
			.where(eq(members.clubId, seed.clubId));
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
			// SIGNED IN as the Toastmaster: the only way the contact roster is
			// granted at all.
			sessionUserId: seed.adminUserId,
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
		// whole outreach affordance. Asserted NON-NULL, not merely present:
		// `toHaveProperty("phone")` passes for a null value, which is what let the
		// withheld cases below pass vacuously before the fixture set a phone.
		const withPhone = roster.filter((r) => r.phone !== null);
		expect(withPhone.length).toBeGreaterThan(0);
		expect(roster.some((r) => r.email !== null)).toBe(true);
	});

	it("gives a member who is NOT the Toastmaster nothing", async () => {
		await assignTmod(seed.clubId, seed.meetingId, seed.adminMemberId);

		const { plan, roster } = await loadTmodPanelData({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			sessionUserId: seed.memberUserId,
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
			sessionUserId: seed.adminUserId,
		});
		const onOther = await loadTmodPanelData({
			meetingId: other.id,
			memberId: seed.adminMemberId,
			sessionUserId: seed.adminUserId,
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
			sessionUserId: seed.adminUserId,
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
			sessionUserId: seed.adminUserId,
		});

		expect(plan).toEqual([]);
		expect(roster).toEqual([]);
	});

	it("withholds CONTACT from an anonymous claim while still giving the ladder", async () => {
		// The finding this file exists to prevent regressing. The claimed member id
		// is PUBLIC — `loadMeetingDetail` ships it as `assigneeId` and the roster
		// picker hands any visitor any id — so a session-less caller echoing it back
		// must never receive PII. `getPublicMeetingByKey` states the rule:
		// "The soft honor-system gate on /club/:clubId must never carry PII."
		await assignTmod(seed.clubId, seed.meetingId, seed.adminMemberId);

		const { plan, roster } = await loadTmodPanelData({
			meetingId: seed.meetingId,
			memberId: seed.adminMemberId,
			sessionUserId: null,
		});

		// Ladder still granted — the honour-system half.
		expect(plan.length).toBeGreaterThan(0);
		// NAMES still granted: they are already public, and `buildPlanPanel` builds
		// its rows from the roster, so returning [] here would withhold the whole
		// panel rather than just the PII.
		expect(roster.length).toBeGreaterThan(0);
		// CONTACT withheld on every row. Asserting null is meaningful only because
		// the signed-in case above proves non-null contact IS reachable through the
		// same call — the pair brackets the gate instead of passing because the
		// fixture has no contact at all.
		for (const r of roster) {
			expect(r.phone).toBeNull();
			expect(r.email).toBeNull();
		}
	});

	it("withholds CONTACT from a signed-in club member who is not the Toastmaster", async () => {
		// The #560 shape: two gates answering oppositely for one person. The WRITE
		// path routes a claim through `resolveWriteActor`, which gives a caller's own
		// membership precedence, so a signed-in non-TMOD cannot write as the TMOD.
		// Comparing the raw claim here would have let them READ as one.
		await assignTmod(seed.clubId, seed.meetingId, seed.adminMemberId);

		const { roster } = await loadTmodPanelData({
			meetingId: seed.meetingId,
			// Claims the TMOD's id...
			memberId: seed.adminMemberId,
			// ...but the session belongs to a different member.
			sessionUserId: seed.memberUserId,
		});

		expect(roster.length).toBeGreaterThan(0);
		for (const r of roster) {
			expect(r.phone).toBeNull();
			expect(r.email).toBeNull();
		}
	});

	it("revokes the grant when the Toastmaster leaves the roster", async () => {
		// Deactivation frees only UPCOMING slots — `members-logic.ts` preserves past
		// ones as history — so a departed member keeps the slot row on every meeting
		// they ever ran. Comparing ids alone made each one a permanent key to the
		// club's CURRENT contact list.
		await assignTmod(seed.clubId, seed.meetingId, seed.adminMemberId);
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, seed.adminMemberId));

		const { plan, roster } = await loadTmodPanelData({
			meetingId: seed.meetingId,
			memberId: seed.adminMemberId,
			sessionUserId: seed.adminUserId,
		});

		expect(plan).toEqual([]);
		expect(roster).toEqual([]);
	});

	it("expires the grant once the meeting is locked", async () => {
		// The panel's `phase === "upcoming"` bound is CLIENT-side and this fn is
		// addressable directly, so without a server-side check the Toastmaster of
		// every meeting the club ever held keeps a live grant.
		await assignTmod(seed.clubId, seed.meetingId, seed.adminMemberId);
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, seed.meetingId));

		const { plan, roster } = await loadTmodPanelData({
			meetingId: seed.meetingId,
			memberId: seed.adminMemberId,
			sessionUserId: seed.adminUserId,
		});

		expect(plan).toEqual([]);
		expect(roster).toEqual([]);
	});

	it("gives nothing for a meeting that does not exist", async () => {
		const { plan, roster } = await loadTmodPanelData({
			meetingId: "00000000-0000-0000-0000-000000000000",
			memberId: seed.adminMemberId,
			sessionUserId: seed.adminUserId,
		});

		expect(plan).toEqual([]);
		expect(roster).toEqual([]);
	});
});
