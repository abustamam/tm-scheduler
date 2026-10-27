/**
 * DB-backed tests for the readers that must not publish a non-active member's
 * planned-attendance answer (#1342, the widened scope), and for the guest
 * conversion undo that returns a membership to `former`.
 *
 * Every plan row here is inserted DIRECTLY, never through `applySetMemberStatus`:
 * these readers are what covers a membership that ended before the delete
 * existed, or a row that landed after it, so the delete must not be what makes
 * the test pass.
 *
 * Run with a bootstrapped worktree (`bun run worktree:setup`):
 *   bunx vitest run src/server/former-member-readers.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetingAttendancePlan,
	members,
	mentorshipRequests,
	people,
	roleDefinitions,
	roleSlots,
	user,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { listUnavailableWithNames, isMemberUnavailable } = await import(
	"#/server/attendance-plan-logic"
);
const { loadSeasonGrid } = await import("#/server/season-grid-logic");
const { loadMeetingDetailForTest, loadTmodPanelData } = await import(
	"#/server/meetings-logic"
);
const { loadMyMentorRequests } = await import("#/server/mentorship-logic");
const {
	applyConvertGuestToMember,
	applyUndoGuestConversion,
	captureGuestVisit,
} = await import("#/server/guest-pipeline-logic");

type Status = "active" | "inactive" | "former";

describe.skipIf(!hasTestDb)("non-active members' plan rows (#1342)", () => {
	let seed: SeededClub;
	const strayUsers: string[] = [];
	const strayPeople: string[] = [];
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [
			seed.adminUserId,
			seed.memberUserId,
			...strayUsers.splice(0),
		]);
		// The Persons a test minted are not covered by cleanup(club); delete them
		// after it, since the club's guests reference them.
		for (const id of strayPeople.splice(0))
			await testDb.delete(people).where(eq(people.id, id));
	});

	async function addMember(name: string, status: Status) {
		const [m] = await testDb
			.insert(members)
			.values({
				clubId: seed.clubId,
				personId: await seedPerson({ name }),
				name,
				status,
			})
			.returning({ id: members.id });
		if (!m) throw new Error("member insert failed");
		return m.id;
	}

	const answer = (
		memberId: string,
		status: "coming" | "not_coming" | "reached_out",
	) =>
		testDb
			.insert(meetingAttendancePlan)
			.values({ memberId, meetingId: seed.meetingId, status });

	describe("the public season grid", () => {
		it("carries active members' unavailable pairs only", async () => {
			// protects=the grid's `unavailable` partition is active-only; fails_when=`activeOnly` is dropped from the grid's listPlanForMeetings call (the former and the inactive member's pairs ship); no_claim=names (next tests)
			const active = await addMember("Ann Active", "active");
			const inactive = await addMember("Ian Inactive", "inactive");
			const former = await addMember("Fay Former", "former");
			for (const m of [active, inactive, former]) await answer(m, "not_coming");

			const data = await loadSeasonGrid({ clubId: seed.clubId, count: 8 });

			expect(data.unavailable).toEqual([
				{ memberId: active, meetingId: seed.meetingId },
			]);
		});

		it("does not name a former member who holds nothing, and keeps a former holder's name", async () => {
			// protects=`memberNames` is active members plus past holders: history still resolves, a stranger is not named; fails_when=the filter is dropped (the idle former member is named) or narrowed to active only (the holder of a role loses their name on the roles orientation); no_claim=the plan pairs (previous test)
			const idle = await addMember("Ida Idle Former", "former");
			const holder = await addMember("Hal Holder Former", "former");
			const [def] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: seed.clubId,
					name: "Grammarian",
					category: "leadership",
					sortOrder: 9,
				})
				.returning({ id: roleDefinitions.id });
			if (!def) throw new Error("role def failed");
			await testDb.insert(roleSlots).values({
				meetingId: seed.meetingId,
				roleDefinitionId: def.id,
				status: "confirmed",
				assignedMemberId: holder,
			});

			const data = await loadSeasonGrid({ clubId: seed.clubId, count: 8 });
			const named = data.memberNames.map((m) => m.id);

			expect(named).toContain(holder);
			expect(named).not.toContain(idle);
			expect(named).toContain(seed.memberId);
		});
	});

	describe("the meeting payload's answeredRungs", () => {
		it("names active members only", async () => {
			// protects=`answeredRungs` is active-only; fails_when=`activeOnly` is dropped from the payload's plan read (a former or inactive member's answer ships to a signed-out reader); no_claim=the officer's `plan` ladder
			const active = await addMember("Ann Active", "active");
			const inactive = await addMember("Ian Inactive", "inactive");
			const former = await addMember("Fay Former", "former");
			await answer(active, "coming");
			await answer(inactive, "not_coming");
			await answer(former, "not_coming");

			const { answeredRungs, plan } = await loadMeetingDetailForTest(
				seed.meetingId,
				{ canManage: true },
			);

			expect(answeredRungs).toEqual([{ memberId: active, status: "coming" }]);
			expect(plan.map((r) => r.memberId)).toEqual([active]);
		});
	});

	describe("the Toastmaster's panel", () => {
		it("carries active members' rungs only", async () => {
			// protects=the TMOD ladder is active-only, like the roster beside it; fails_when=`activeOnly` is dropped from loadTmodPanelData (the former member's rung is in the ladder); no_claim=the TMOD grant itself (tmod-panel-data.integration.test.ts)
			const active = await addMember("Ann Active", "active");
			const former = await addMember("Fay Former", "former");
			await answer(active, "not_coming");
			await answer(former, "reached_out");
			const [def] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: seed.clubId,
					name: "Toastmaster of the Day",
					key: "toastmaster_of_the_day",
					category: "leadership",
					sortOrder: 1,
				})
				.returning({ id: roleDefinitions.id });
			if (!def) throw new Error("role def failed");
			await testDb.insert(roleSlots).values({
				meetingId: seed.meetingId,
				roleDefinitionId: def.id,
				status: "confirmed",
				assignedMemberId: seed.adminMemberId,
			});

			const { plan } = await loadTmodPanelData({
				meetingId: seed.meetingId,
				memberId: seed.adminMemberId,
				sessionUserId: seed.adminUserId,
			});

			expect(plan).toEqual([{ memberId: active, status: "not_coming" }]);
		});
	});

	describe("the roll-aware unavailable list", () => {
		it("ignores a non-active member's not_coming row", async () => {
			// protects=`unavailableBase` joins the plan for active members only; fails_when=the `members.status = 'active'` condition is dropped from the plan join (the former member is listed unavailable and isMemberUnavailable says true); no_claim=the roll's Absent, which still counts
			const active = await addMember("Ann Active", "active");
			const former = await addMember("Fay Former", "former");
			await answer(active, "not_coming");
			await answer(former, "not_coming");

			expect(await listUnavailableWithNames(testDb, seed.meetingId)).toEqual([
				{ id: active, name: "Ann Active" },
			]);
			expect(
				await isMemberUnavailable(testDb, {
					memberId: former,
					meetingId: seed.meetingId,
				}),
			).toBe(false);
			expect(
				await isMemberUnavailable(testDb, {
					memberId: active,
					meetingId: seed.meetingId,
				}),
			).toBe(true);
		});
	});

	describe("a mentee's own outgoing request", () => {
		async function mentorWithRequest(status: Status) {
			const userId = randomUUID();
			strayUsers.push(userId);
			await testDb.insert(user).values({
				id: userId,
				name: "Mia Mentor",
				email: `${userId}@login.example`,
				emailVerified: true,
			});
			const [person] = await testDb
				.insert(people)
				.values({
					name: "Mia Mentor",
					email: "mia@example.org",
					phone: "+15555550111",
					userId,
					preferredContact: "email",
				})
				.returning({ id: people.id });
			if (!person) throw new Error("person failed");
			const [m] = await testDb
				.insert(members)
				.values({
					clubId: seed.clubId,
					personId: person.id,
					name: "Mia Mentor",
					status,
					willingToMentor: true,
					mentorListedAt: new Date(),
				})
				.returning({ id: members.id });
			if (!m) throw new Error("mentor failed");
			await testDb.insert(mentorshipRequests).values({
				clubId: seed.clubId,
				menteeMemberId: seed.memberId,
				mentorMemberId: m.id,
				status: "pending",
			});
			return m.id;
		}

		it("keeps a former mentor's name and withholds their contact", async () => {
			// protects=a mentor who left is named on the request the mentee can still withdraw, with no email, phone or preference; fails_when=the status check is dropped from the outgoing mapping (the former mentor's email and phone are returned); no_claim=an inactive mentor (next test)
			const mentorId = await mentorWithRequest("former");

			const mine = await loadMyMentorRequests(seed.memberId);

			expect(mine?.outgoing?.mentor).toMatchObject({
				id: mentorId,
				name: "Mia Mentor",
				email: null,
				phone: null,
			});
		});

		it("still gives an active mentor's contact", async () => {
			const mentorId = await mentorWithRequest("active");

			const mine = await loadMyMentorRequests(seed.memberId);

			expect(mine?.outgoing?.mentor).toMatchObject({
				id: mentorId,
				email: "mia@example.org",
				phone: "+15555550111",
			});
		});
	});

	describe("undoing a conversion that woke a former member", () => {
		async function formerPerson(name: string) {
			const email = `${name.toLowerCase().replace(/\W+/g, "-")}-${randomUUID()}@example.com`;
			const [p] = await testDb
				.insert(people)
				.values({ name, email })
				.returning({ id: people.id });
			if (!p) throw new Error("person failed");
			strayPeople.push(p.id);
			const [m] = await testDb
				.insert(members)
				.values({
					clubId: seed.clubId,
					personId: p.id,
					name,
					status: "former",
					endedAt: "2020-01-15",
				})
				.returning({ id: members.id });
			if (!m) throw new Error("member failed");
			return { membershipId: m.id, personId: p.id, email };
		}

		async function wake(name: string, email: string) {
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name,
				email,
			});
			await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
				confirmedEmail: email,
			});
			return guestId;
		}

		const rowsOf = (memberId: string) =>
			testDb
				.select({ id: meetingAttendancePlan.id })
				.from(meetingAttendancePlan)
				.where(eq(meetingAttendancePlan.memberId, memberId));

		it("deletes the plan rows written while they were active", async () => {
			// protects=undo back to `former` is an ending: the answer the woken member gave does not outlive it; fails_when=the deletePlanRowsOfEndedMember call is dropped from the undo's restore branch (the row survives on a former member); no_claim=the undo's refusals (guest-undo-after-change.integration.test.ts)
			const { membershipId, email } = await formerPerson("Wendy Woken");
			const guestId = await wake("Wendy Woken", email);
			await testDb.insert(meetingAttendancePlan).values({
				memberId: membershipId,
				meetingId: seed.meetingId,
				status: "not_coming",
			});

			await applyUndoGuestConversion({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			const [after] = await testDb
				.select({ status: members.status })
				.from(members)
				.where(eq(members.id, membershipId));
			expect(after?.status).toBe("former");
			expect(await rowsOf(membershipId)).toEqual([]);
		});
	});
});
