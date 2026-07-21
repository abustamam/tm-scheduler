/**
 * DB-backed integration tests for the setup-checklist completion data (#265):
 * every field is derived from real rows, never a stored flag.
 *
 * Runs against a real Postgres identified by TEST_DATABASE_URL; skipped when
 * unset (never touches dev/prod).
 *
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/onboarding-checklist-logic.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubMeetingRecurrence,
	clubs,
	meetings,
	members,
	officerTerms,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";
import { getOnboardingChecklistStatus } from "./onboarding-checklist-logic";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

async function addActiveMember(clubId: string, name: string): Promise<string> {
	const personId = await seedPerson({ name });
	const [row] = await testDb
		.insert(members)
		.values({ clubId, personId, name, clubRole: "member", status: "active" })
		.returning({ id: members.id });
	if (!row) throw new Error("member insert failed");
	return row.id;
}

describe.skipIf(!hasTestDb)(
	"getOnboardingChecklistStatus (integration)",
	() => {
		let seeded: SeededClub;

		beforeEach(async () => {
			// seedClub creates: 2 active members (admin + member), 1 scheduled future
			// meeting, no recurrence rule, no officer term, no meetingSchedule.
			seeded = await seedClub();
		});

		afterEach(async () => {
			await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
		});

		it("reads a fresh club as new, with every item incomplete but the meeting seedClub creates", async () => {
			const status = await getOnboardingChecklistStatus(seeded.clubId);
			expect(status.clubSlug).toMatch(/^test-club-/);
			expect(status.clubDetailsComplete).toBe(false); // no meetingSchedule set
			expect(status.memberCount).toBe(2);
			expect(status.hasEnoughMembers).toBe(false); // < 5
			expect(status.hasRecurrence).toBe(false);
			expect(status.hasMeeting).toBe(true); // seedClub's one meeting
			expect(status.hasOfficerTerm).toBe(false);
			// isNewClub is an OR: even though hasMeeting is true, the thin roster
			// alone is enough to keep the club "new".
			expect(status.isNewClub).toBe(true);
		});

		it("clubDetailsComplete requires name + club number + meeting schedule", async () => {
			await testDb
				.update(clubs)
				.set({ meetingSchedule: "2nd & 4th Thursday, 6:45–7:45 PM" })
				.where(eq(clubs.id, seeded.clubId));
			// seedClub's club has no clubNumber — still incomplete.
			let status = await getOnboardingChecklistStatus(seeded.clubId);
			expect(status.clubDetailsComplete).toBe(false);

			await testDb
				.update(clubs)
				.set({ clubNumber: `TC-${seeded.clubId.slice(0, 8)}` })
				.where(eq(clubs.id, seeded.clubId));
			status = await getOnboardingChecklistStatus(seeded.clubId);
			expect(status.clubDetailsComplete).toBe(true);
		});

		it("hasRecurrence flips true once a standing rule exists", async () => {
			await testDb.insert(clubMeetingRecurrence).values({
				clubId: seeded.clubId,
				mode: "interval",
				weekday: 2,
				intervalWeeks: 1,
				anchorDate: "2026-01-06",
				timeOfDay: "18:30",
				keepAhead: 4,
				enabled: true,
			});
			const status = await getOnboardingChecklistStatus(seeded.clubId);
			expect(status.hasRecurrence).toBe(true);
		});

		it("hasOfficerTerm is true only for an OPEN term, not a closed one", async () => {
			await testDb.insert(officerTerms).values({
				membershipId: seeded.adminMemberId,
				position: "president",
				termStart: new Date(),
				termEnd: new Date(), // already closed
			});
			let status = await getOnboardingChecklistStatus(seeded.clubId);
			expect(status.hasOfficerTerm).toBe(false);

			await testDb.insert(officerTerms).values({
				membershipId: seeded.adminMemberId,
				position: "vp_education",
				termStart: new Date(),
				termEnd: null, // open
			});
			status = await getOnboardingChecklistStatus(seeded.clubId);
			expect(status.hasOfficerTerm).toBe(true);
		});

		it("hasEnoughMembers and isNewClub flip once the roster reaches the threshold", async () => {
			// seedClub gives 2 active members; add 3 more to reach 5.
			for (let i = 0; i < 3; i++) {
				await addActiveMember(seeded.clubId, `Member ${i}`);
			}
			const status = await getOnboardingChecklistStatus(seeded.clubId);
			expect(status.memberCount).toBe(5);
			expect(status.hasEnoughMembers).toBe(true);
			// hasMeeting is already true (seedClub) and now hasEnoughMembers is too
			// — the club has graduated.
			expect(status.isNewClub).toBe(false);
		});

		it("inactive members don't count toward the roster threshold", async () => {
			const personId = await seedPerson({ name: "Inactive One" });
			await testDb.insert(members).values({
				clubId: seeded.clubId,
				personId,
				name: "Inactive One",
				clubRole: "member",
				status: "inactive",
			});
			const status = await getOnboardingChecklistStatus(seeded.clubId);
			expect(status.memberCount).toBe(2); // unchanged
		});

		it("isNewClub is true for a club with zero meetings even if the roster is large", async () => {
			// Remove seedClub's one meeting so this club has none.
			await testDb.delete(meetings).where(eq(meetings.clubId, seeded.clubId));
			for (let i = 0; i < 3; i++) {
				await addActiveMember(seeded.clubId, `Member ${i}`);
			}
			const status = await getOnboardingChecklistStatus(seeded.clubId);
			expect(status.memberCount).toBe(5);
			expect(status.hasEnoughMembers).toBe(true);
			expect(status.hasMeeting).toBe(false);
			expect(status.isNewClub).toBe(true); // OR: no meetings keeps it "new"
		});

		it("throws for a club that doesn't exist", async () => {
			await expect(
				getOnboardingChecklistStatus("00000000-0000-0000-0000-000000000000"),
			).rejects.toThrow(/club not found/i);
		});
	},
);
