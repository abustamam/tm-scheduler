/**
 * DB-backed tests for what leaving the club does to a member's planned-attendance
 * rows (#1342).
 *
 * Ending a membership (`applySetMemberStatus` -> former) deletes the member's
 * plan rows on every meeting that is not completed, and the public "not coming"
 * list (`listNotComingWithNames`) names ACTIVE members only. The roster hides a
 * former member, so a name on the public list the roster does not carry told a
 * signed-out reader who used to be a member.
 *
 * Run with a bootstrapped worktree (`bun run worktree:setup`):
 *   bunx vitest run src/server/former-member-plan-rows.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	meetingAttendancePlan,
	meetings,
	members,
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

const { applySetMemberStatus } = await import("#/server/members-logic");
const { listNotComingWithNames } = await import(
	"#/server/attendance-plan-logic"
);

type Status = "active" | "inactive" | "former";
type MeetingStatus = "scheduled" | "cancelled" | "completed";
type Plan = "coming" | "not_coming" | "reached_out";

describe.skipIf(!hasTestDb)("leaving the club and plan rows (#1342)", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	async function addMember(name: string, status: Status = "active") {
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

	async function addMeeting(status: MeetingStatus, daysFromNow: number) {
		const [m] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date(Date.now() + daysFromNow * 86_400_000),
				status,
			})
			.returning({ id: meetings.id });
		if (!m) throw new Error("meeting insert failed");
		return m.id;
	}

	const plan = (memberId: string, meetingId: string, status: Plan) =>
		testDb
			.insert(meetingAttendancePlan)
			.values({ memberId, meetingId, status });

	const rowsOf = async (memberId: string) =>
		(
			await testDb
				.select({
					meetingId: meetingAttendancePlan.meetingId,
					status: meetingAttendancePlan.status,
				})
				.from(meetingAttendancePlan)
				.where(eq(meetingAttendancePlan.memberId, memberId))
		).sort((a, b) => a.meetingId.localeCompare(b.meetingId));

	const set = (memberId: string, status: Status) =>
		applySetMemberStatus({
			clubId: seed.clubId,
			memberId,
			status,
			actorMemberId: seed.adminMemberId,
		});

	describe("ending the membership", () => {
		it("deletes the plan rows on every meeting that is not completed, and only those", async () => {
			// protects=the delete's meeting filter, both ways; fails_when=the filter is dropped (the completed meeting's row goes too), narrowed to scheduled (the cancelled meeting's row stays), or the delete is not scoped to the member (the other member's row goes); no_claim=the status change itself (members-former.integration.test.ts)
			const leaver = await addMember("Lee Leaver");
			const stayer = await addMember("Sam Stayer");
			const scheduled = await addMeeting("scheduled", 7);
			const cancelled = await addMeeting("cancelled", 14);
			const completed = await addMeeting("completed", -7);
			for (const m of [scheduled, cancelled, completed]) {
				await plan(leaver, m, "not_coming");
				await plan(stayer, m, "not_coming");
			}
			// The seeded meeting too: any rung goes, not only the answers.
			await plan(leaver, seed.meetingId, "reached_out");

			await set(leaver, "former");

			expect(await rowsOf(leaver)).toEqual([
				{ meetingId: completed, status: "not_coming" },
			]);
			expect((await rowsOf(stayer)).map((r) => r.meetingId).sort()).toEqual(
				[scheduled, cancelled, completed].sort(),
			);
		});

		it("deletes the row on a past meeting that is still scheduled, since the decision is by status", async () => {
			// protects=that "not yet completed" is read from the meeting's STATUS, not its date: a past meeting nobody closed is still scheduled and its row goes; fails_when=the delete is narrowed to meetings in the future (the past-but-scheduled row stays); no_claim=the completed meeting's row (previous test)
			const leaver = await addMember("Pat Past-due");
			const pastScheduled = await addMeeting("scheduled", -3);
			await plan(leaver, pastScheduled, "not_coming");

			await set(leaver, "former");

			expect(await rowsOf(leaver)).toEqual([]);
		});

		it("deletes the rows of an INACTIVE member who is then ended", async () => {
			// protects=ending from `inactive` deletes, as ending from `active` does (the rows an inactive member kept are the ones the ending must now clear); fails_when=the delete is gated on the previous status being active; no_claim=going inactive (next test)
			const lapsed = await addMember("Ivy Inactive-Leaver", "inactive");
			const scheduled = await addMeeting("scheduled", 7);
			await plan(lapsed, scheduled, "not_coming");

			await set(lapsed, "former");

			expect(await rowsOf(lapsed)).toEqual([]);
		});

		it("leaves a member who goes inactive, rather than ends, with their rows", async () => {
			// protects=that only an ENDING deletes: an inactive member is expected back and keeps their answers; fails_when=the delete moves out of the `ending` branch into `releasing` (the deactivation path), so going inactive also deletes; no_claim=none beyond protects
			const lapsing = await addMember("Lou Lapsing");
			const scheduled = await addMeeting("scheduled", 7);
			await plan(lapsing, scheduled, "not_coming");

			await set(lapsing, "inactive");

			expect(await rowsOf(lapsing)).toEqual([
				{ meetingId: scheduled, status: "not_coming" },
			]);
		});

		it("does not bring the rows back when the member is reactivated", async () => {
			const leaver = await addMember("Rae Returner");
			const scheduled = await addMeeting("scheduled", 7);
			await plan(leaver, scheduled, "not_coming");

			await set(leaver, "former");
			await set(leaver, "active");

			expect(await rowsOf(leaver)).toEqual([]);
		});

		it("deletes without writing a plan_set row per swept answer", async () => {
			const leaver = await addMember("Quinn Quiet");
			for (const days of [7, 14, 21]) {
				await plan(leaver, await addMeeting("scheduled", days), "not_coming");
			}

			await set(leaver, "former");

			const planSets = await testDb
				.select({ id: activityLog.id })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.action, "plan_set"),
					),
				);
			expect(planSets).toEqual([]);
		});
	});

	describe("the public not-coming list", () => {
		it("names active members only", async () => {
			// protects=the active-only filter, from each non-active status; fails_when=the `members.status = 'active'` predicate is dropped (the former and the inactive member are listed); no_claim=which readers are handed this list (meeting-detail-unavailable.integration.test.ts)
			const active = await addMember("Ann Active");
			const inactive = await addMember("Ian Inactive", "inactive");
			const former = await addMember("Fay Former", "former");
			for (const m of [active, inactive, former]) {
				await plan(m, seed.meetingId, "not_coming");
			}

			expect(await listNotComingWithNames(testDb, seed.meetingId)).toEqual([
				{ id: active, name: "Ann Active" },
			]);
		});

		it("drops a row that lands after the ending, as the ending's own delete cannot", async () => {
			// The second line of defence: a session-less answer racing the ending
			// can insert after the delete ran, and must still not be published.
			const leaver = await addMember("Max Mid-flight");
			await set(leaver, "former");
			await plan(leaver, seed.meetingId, "not_coming");

			expect(await listNotComingWithNames(testDb, seed.meetingId)).toEqual([]);
		});

		it("lists a member again once they are reactivated and answer again", async () => {
			const leaver = await addMember("Una Undone");
			await set(leaver, "former");
			await set(leaver, "active");
			await plan(leaver, seed.meetingId, "not_coming");

			expect(await listNotComingWithNames(testDb, seed.meetingId)).toEqual([
				{ id: leaver, name: "Una Undone" },
			]);
		});
	});
});
