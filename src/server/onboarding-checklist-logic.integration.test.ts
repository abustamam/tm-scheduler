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
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubMeetingRecurrence,
	clubs,
	meetings,
	members,
	officerTerms,
	people,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";
import { prepareMemberInvite } from "./account-invite-logic";
import { getOnboardingChecklistStatus } from "./onboarding-checklist-logic";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

/** An active roster member with an email on file, so `prepareMemberInvite` can
 *  actually stamp it. Its Person is UNLINKED and UNINVITED — the state an
 *  imported roster arrives in. */
async function addActiveMember(
	clubId: string,
	name: string,
	status: "active" | "inactive" = "active",
): Promise<string> {
	const personId = await seedPerson({
		name,
		email: `checklist-${randomUUID()}@test.example`,
	});
	const [row] = await testDb
		.insert(members)
		.values({ clubId, personId, name, clubRole: "member", status })
		.returning({ id: members.id });
	if (!row) throw new Error("member insert failed");
	return row.id;
}

/**
 * Send this member the account invite, through the SAME function the
 * `inviteAllMembers` server fn calls per member — that fn itself needs the Start
 * runtime (`getRequest`, `auth.api`) and cannot be invoked from vitest, and the
 * only part of it the checklist can see is the `people.invited_at` stamp this
 * writes.
 */
async function inviteMember(clubId: string, memberId: string): Promise<void> {
	const prep = await prepareMemberInvite({ clubId, memberId });
	if (prep.outcome !== "ready") {
		throw new Error(`invite did not go out: ${prep.outcome}`);
	}
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
			// seedClub's two members are both linked to a sign-in account, and a
			// linked Person supersedes an invite (`inviteStateOf`) — so both of
			// them count as invited, and 2 of 2 clears min(5, 2).
			expect(status.invitedMemberCount).toBe(2);
			expect(status.hasInvitedMembers).toBe(true);
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

		// Was "hasEnoughMembers and isNewClub flip once the roster reaches the
		// threshold". Reaching the threshold no longer graduates a club on its own
		// (#716): an imported-but-never-invited roster is a club nobody can sign
		// in to, and claiming a role is the loop the app exists for. So the roster
		// row still flips here — that half is unchanged — and graduation waits.
		it("hasEnoughMembers flips at the threshold, but isNewClub waits for invites", async () => {
			// seedClub gives 2 active members; add 3 more to reach 5.
			const added: string[] = [];
			for (let i = 0; i < 3; i++) {
				added.push(await addActiveMember(seeded.clubId, `Member ${i}`));
			}
			let status = await getOnboardingChecklistStatus(seeded.clubId);
			expect(status.memberCount).toBe(5);
			expect(status.hasEnoughMembers).toBe(true);
			// hasMeeting is already true (seedClub) and hasEnoughMembers is now too
			// — but only seedClub's 2 linked members count as invited, and the bar
			// is min(5, 5) = 5. The club has NOT graduated.
			expect(status.invitedMemberCount).toBe(2);
			expect(status.hasInvitedMembers).toBe(false);
			expect(status.isNewClub).toBe(true);

			for (const memberId of added) {
				await inviteMember(seeded.clubId, memberId);
			}
			status = await getOnboardingChecklistStatus(seeded.clubId);
			expect(status.invitedMemberCount).toBe(5);
			expect(status.hasInvitedMembers).toBe(true);
			expect(status.isNewClub).toBe(false);
		});

		/**
		 * AC 9's actual shape, and the state EVERY real club is in on day one: a
		 * full roster imported from the TI export, a meeting on the calendar, and
		 * not one invite sent. Every other un-graduated case in this file sits at
		 * `invitedMemberCount: 2`, because seedClub's own members arrive already
		 * linked — so none of them exercises the clause at zero, which is the
		 * number the new `|| !hasInvitedMembers` exists for.
		 */
		it("a full roster with ZERO invites has not graduated", async () => {
			// Un-link seedClub's two members so nobody in this club is invited or
			// joined. Scoped to this club's own people — never an unscoped update.
			const seededPeople = await testDb
				.select({ personId: members.personId })
				.from(members)
				.where(eq(members.clubId, seeded.clubId));
			await testDb
				.update(people)
				.set({ userId: null, invitedAt: null })
				.where(
					inArray(
						people.id,
						seededPeople.map((r) => r.personId),
					),
				);

			for (let i = 0; i < 3; i++) {
				await addActiveMember(seeded.clubId, `Uninvited ${i}`);
			}

			let status = await getOnboardingChecklistStatus(seeded.clubId);
			expect(status.memberCount).toBe(5);
			expect(status.hasEnoughMembers).toBe(true);
			expect(status.hasMeeting).toBe(true); // seedClub's one meeting
			// The whole point: the roster and the meeting are both there, and the
			// invite count is ZERO. Only the invites clause is holding it back.
			expect(status.invitedMemberCount).toBe(0);
			expect(status.hasInvitedMembers).toBe(false);
			expect(status.isNewClub).toBe(true);

			// And it graduates the moment the invites go out — the same club, one
			// fact changed, so the assertion above cannot be passing for some other
			// reason.
			const seedMembers = await testDb
				.select({ id: members.id })
				.from(members)
				.where(eq(members.clubId, seeded.clubId));
			for (const m of seedMembers) await inviteMember(seeded.clubId, m.id);

			status = await getOnboardingChecklistStatus(seeded.clubId);
			expect(status.invitedMemberCount).toBe(5);
			expect(status.hasInvitedMembers).toBe(true);
			expect(status.isNewClub).toBe(false);
		});

		it("an invite flips a member from uninvited to invited", async () => {
			const memberId = await addActiveMember(seeded.clubId, "Uninvited One");
			let status = await getOnboardingChecklistStatus(seeded.clubId);
			expect(status.memberCount).toBe(3);
			expect(status.invitedMemberCount).toBe(2); // the 2 linked seed members
			expect(status.hasInvitedMembers).toBe(false); // bar is min(5, 3) = 3

			await inviteMember(seeded.clubId, memberId);
			status = await getOnboardingChecklistStatus(seeded.clubId);
			expect(status.invitedMemberCount).toBe(3);
			expect(status.hasInvitedMembers).toBe(true);
		});

		it("a 3-member club clears the invite bar at 3 of 3 (min, not the threshold)", async () => {
			const memberId = await addActiveMember(seeded.clubId, "Third Member");
			await inviteMember(seeded.clubId, memberId);
			const status = await getOnboardingChecklistStatus(seeded.clubId);
			expect(status.memberCount).toBe(3);
			expect(status.invitedMemberCount).toBe(3);
			// The bar is min(CHECKLIST_MEMBER_THRESHOLD, memberCount): a club of 3
			// clears it by inviting everyone, even though its roster is still short
			// of the threshold — otherwise a small club could never check the row.
			expect(status.hasEnoughMembers).toBe(false);
			expect(status.hasInvitedMembers).toBe(true);
		});

		it("inactive members count toward NEITHER the roster nor the invited count", async () => {
			const memberId = await addActiveMember(
				seeded.clubId,
				"Inactive Invited",
				"inactive",
			);
			// Stamp the invite anyway — an inactive member may well have been
			// invited before they went inactive. Neither count may see them.
			await inviteMember(seeded.clubId, memberId);
			const status = await getOnboardingChecklistStatus(seeded.clubId);
			expect(status.memberCount).toBe(2);
			expect(status.invitedMemberCount).toBe(2);
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

		it("isNewClub is true for a club with zero meetings even if the roster is large and invited", async () => {
			// Remove seedClub's one meeting so this club has none.
			await testDb.delete(meetings).where(eq(meetings.clubId, seeded.clubId));
			for (let i = 0; i < 3; i++) {
				// Invited too, so the MEETINGS clause is the only one left false —
				// otherwise this passes even with that clause deleted.
				await inviteMember(
					seeded.clubId,
					await addActiveMember(seeded.clubId, `Member ${i}`),
				);
			}
			const status = await getOnboardingChecklistStatus(seeded.clubId);
			expect(status.memberCount).toBe(5);
			expect(status.hasEnoughMembers).toBe(true);
			expect(status.hasInvitedMembers).toBe(true);
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
