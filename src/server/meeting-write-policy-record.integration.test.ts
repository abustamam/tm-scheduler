/**
 * The record family's writers refuse a frozen meeting by WRITE CLASS (#1137,
 * part of #1129; the policy is #1134's `MEETING_WRITE_POLICY`).
 *
 * `record` is what is written about a meeting after it happened: it refuses a
 * cancelled meeting and accepts a completed one. `plan` is what is intended for
 * a meeting that has not happened, and refuses both. The writers below are the
 * ones this issue changed or newly gated; the rows it only rewrote keep the
 * suites that already pinned them (`cancelled-meeting-officer-writes`,
 * `timings`, `role-feedback`, `guest-pipeline`).
 *
 * Every refusal here is paired with a control that differs only in the property
 * under test, and asserts the row COUNTS afterwards: a throw alone proves
 * nothing, because a broken fixture throws too.
 *
 * Two of the refusals cannot be reached by a serial call and are driven across
 * a real lock wait instead:
 *
 *  - `captureGuestVisit` resolves the meeting it records against BEFORE its
 *    transaction, and `resolveCurrentMeeting` already skips a cancelled one, so
 *    the refusal inside the transaction is only reachable when the meeting is
 *    cancelled while the visit queues on the club write lock;
 *  - `applyGuestBookPlan` has no cheaper check in front of its gate, but the
 *    gate sits inside the club's apply lock, and a test that cancels before it
 *    starts would not show the gate runs THERE.
 *
 * Run with the worktree's own database (`bun run worktree:setup`), or:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/meeting-write-policy-record.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	guests,
	mcpPendingPlans,
	meetingAttendance,
	meetingAttendancePlan,
	meetings,
	people,
	roleFeedbackNotes,
	roleSlots,
} from "#/db/schema";
import { utcToZonedWallTime } from "#/lib/datetime";
import { MEETING_CANCELLED_MESSAGE } from "#/lib/meeting-cancellation-notice";
import { MEETING_LOCKED_MESSAGE } from "#/lib/meeting-lifecycle";
import { awaitLockWaiter, holdClubLock } from "#/test/club-lock";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	testDb,
	waitForLockWait,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { lockClubForWrite } = await import("./club-write-lock");
const { captureGuestVisit } = await import("./guest-pipeline-logic");
const { clearPlanStatus, setPlanStatus, SELF_SERVICE_RUNGS } = await import(
	"./attendance-plan-logic"
);
const { leaveFeedbackLogic } = await import("./role-feedback-logic");
const { recordGuestBookTool } = await import("./mcp/tools/record-guest-book");
const { hashApiToken } = await import("./api-tokens-logic");
const { applyPendingPlan, loadPendingPlan } = await import(
	"./guest-book-pending-logic"
);

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

type Status = "scheduled" | "cancelled" | "completed";

async function setStatus(meetingId: string, status: Status): Promise<void> {
	await testDb
		.update(meetings)
		.set({ status })
		.where(eq(meetings.id, meetingId));
}

// ---------------------------------------------------------------------------
// captureInTransaction: gains the record class (the public, session-less write
// that mints a guest row)
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)(
	"captureGuestVisit refuses a meeting the record class refuses (#1137)",
	() => {
		let club: SeededClub;
		const email = () => `visitor-${club.clubId}@example.com`;

		beforeEach(async () => {
			club = await seedClub();
			// In progress now, so a visit records attendance against it.
			await testDb
				.update(meetings)
				.set({ scheduledAt: new Date(Date.now() - 10 * MIN) })
				.where(eq(meetings.id, club.meetingId));
		});

		afterEach(async () => {
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		});

		/** What the visit would have minted, read back from the tables. */
		async function minted() {
			const [g, a, p] = await Promise.all([
				testDb
					.select({ id: guests.id })
					.from(guests)
					.where(eq(guests.clubId, club.clubId)),
				testDb
					.select({ id: meetingAttendance.id })
					.from(meetingAttendance)
					.where(eq(meetingAttendance.meetingId, club.meetingId)),
				testDb
					.select({ id: people.id })
					.from(people)
					.where(eq(people.email, email())),
			]);
			return { guests: g.length, attendance: a.length, people: p.length };
		}

		/**
		 * Start a visit and park it on the club write lock, which it takes first
		 * inside its transaction and AFTER it has resolved its meeting. While it is
		 * parked the blocker's own transaction cancels the meeting (or does not,
		 * for the control); the cancel becomes visible when the lock is released.
		 *
		 * `waitForLockWait` is the control for the harness: it proves the visit is
		 * parked behind THIS blocker, so a refusal afterwards cannot be an
		 * up-front one.
		 */
		async function visitAcrossLockWait(
			cancelWhileParked: boolean,
			phone?: string,
		) {
			const blocker = await openBlockingTx(async (tx) => {
				await lockClubForWrite(tx, club.clubId);
				if (cancelWhileParked) {
					await tx
						.update(meetings)
						.set({ status: "cancelled" })
						.where(eq(meetings.id, club.meetingId));
				}
			});
			let visit:
				| Promise<
						| {
								ok: true;
								result: Awaited<ReturnType<typeof captureGuestVisit>>;
						  }
						| { ok: false; message: string }
				  >
				| undefined;
			try {
				visit = captureGuestVisit({
					clubId: club.clubId,
					name: "Visitor Guest",
					email: email(),
					phone: phone ?? null,
				}).then(
					(result) => ({ ok: true as const, result }),
					(e: unknown) => ({
						ok: false as const,
						message: e instanceof Error ? e.message : String(e),
					}),
				);
				await waitForLockWait("pg_advisory_xact_lock", blocker.pid);
			} finally {
				await blocker.commit();
			}
			// biome-ignore lint/style/noNonNullAssertion: assigned in the try above
			return visit!;
		}

		it("the control: a visit that waits on the lock and meets a scheduled meeting is recorded", async () => {
			const out = await visitAcrossLockWait(false);
			expect(out).toMatchObject({
				ok: true,
				result: { created: true, attendanceRecorded: true },
			});
			expect(await minted()).toEqual({ guests: 1, attendance: 1, people: 0 });
		});

		it("refuses a meeting cancelled while the visit waited, with the policy's sentence, and mints no guest, Person or attendance row", async () => {
			const out = await visitAcrossLockWait(true);
			expect(out).toEqual({ ok: false, message: MEETING_CANCELLED_MESSAGE });
			expect(await minted()).toEqual({ guests: 0, attendance: 0, people: 0 });
		});

		it("a RETURNING guest is refused too, and the contact fill-in rolls back with it", async () => {
			const [existing] = await testDb
				.insert(guests)
				.values({ clubId: club.clubId, name: "Visitor Guest", email: email() })
				.returning({ id: guests.id });
			if (!existing) throw new Error("failed to seed the returning guest");
			const out = await visitAcrossLockWait(true, "+1 555 010 0199");
			expect(out).toEqual({ ok: false, message: MEETING_CANCELLED_MESSAGE });
			const [row] = await testDb
				.select({ phone: guests.phone })
				.from(guests)
				.where(eq(guests.id, existing.id));
			expect(row?.phone).toBeNull();
			expect((await minted()).attendance).toBe(0);
		});

		it("a COMPLETED meeting in progress still takes the visit (record accepts what plan refuses)", async () => {
			await setStatus(club.meetingId, "completed");
			const res = await captureGuestVisit({
				clubId: club.clubId,
				name: "Visitor Guest",
				email: email(),
			});
			expect(res).toMatchObject({ created: true, attendanceRecorded: true });
			expect(await minted()).toEqual({ guests: 1, attendance: 1, people: 0 });
		});

		it("a meeting already cancelled when the visit starts is not its target: the guest is kept, no attendance, no error", async () => {
			// The public guest book is also the advance sign-up, so a cancelled
			// meeting nearby must not turn it into an error page: resolution skips it
			// and the visitor lands as a prospect, exactly as before the policy.
			await setStatus(club.meetingId, "cancelled");
			const res = await captureGuestVisit({
				clubId: club.clubId,
				name: "Visitor Guest",
				email: email(),
			});
			expect(res).toMatchObject({
				created: true,
				attendanceRecorded: false,
				meetingId: null,
			});
			expect(await minted()).toEqual({ guests: 1, attendance: 0, people: 0 });
		});
	},
);

// ---------------------------------------------------------------------------
// The guest-book confirm flow: `applyGuestBookPlan`'s callers gain the refusal
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)(
	"the guest-book flow refuses a meeting the record class refuses (#1137)",
	() => {
		let seed: SeededClub;
		let token: string;
		let meetingId: string;
		let meetingDate: string;

		async function mintToken(userId: string): Promise<string> {
			const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
			await testDb
				.insert(apiTokens)
				.values({ userId, tokenHash: hashApiToken(raw) });
			return raw;
		}

		function preview() {
			return recordGuestBookTool.handler(
				{
					clubId: seed.clubId,
					meetingDate,
					entries: [{ name: "Wanda Visitor", email: "wanda@example.com" }],
				},
				{ rawToken: token },
			) as Promise<{ pendingId: string }>;
		}

		async function pendingRows() {
			return testDb
				.select({
					id: mcpPendingPlans.id,
					appliedAt: mcpPendingPlans.appliedAt,
				})
				.from(mcpPendingPlans)
				.where(eq(mcpPendingPlans.clubId, seed.clubId));
		}

		async function rows() {
			const [g, a] = await Promise.all([
				testDb
					.select({ id: guests.id })
					.from(guests)
					.where(eq(guests.clubId, seed.clubId)),
				testDb
					.select({ id: meetingAttendance.id })
					.from(meetingAttendance)
					.where(eq(meetingAttendance.meetingId, meetingId)),
			]);
			return { guests: g.length, attendance: a.length };
		}

		/** A page previewed against the (completed) meeting, rendered editable. */
		async function renderedPlan() {
			const { pendingId } = await preview();
			const view = await loadPendingPlan({
				pendingId,
				userId: seed.adminUserId,
			});
			if (view.status !== "editable") {
				throw new Error(`expected an editable plan, got ${view.status}`);
			}
			return { pendingId, planHash: view.planHash };
		}

		beforeEach(async () => {
			seed = await seedClub();
			token = await mintToken(seed.adminUserId);
			// A meeting a week ago, COMPLETED: the record class accepts it, which is
			// what makes every refusal below the status's doing and nothing else.
			const past = new Date(Date.now() - 7 * DAY);
			const [row] = await testDb
				.insert(meetings)
				.values({ clubId: seed.clubId, scheduledAt: past, status: "completed" })
				.returning({ id: meetings.id });
			if (!row) throw new Error("failed to seed the past meeting");
			meetingId = row.id;
			meetingDate = utcToZonedWallTime(past, "America/Chicago").slice(0, 10);
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		it("record_guest_book previews a COMPLETED meeting (the control)", async () => {
			const { pendingId } = await preview();
			expect(pendingId).toEqual(expect.any(String));
			expect(await pendingRows()).toHaveLength(1);
		});

		it("record_guest_book refuses a CANCELLED meeting with LOCKED and stores no pending page", async () => {
			await setStatus(meetingId, "cancelled");
			await expect(preview()).rejects.toMatchObject({
				code: "LOCKED",
				message: MEETING_CANCELLED_MESSAGE,
			});
			expect(await pendingRows()).toEqual([]);
		});

		it("the confirm page shows a meeting cancelled since it was previewed as unplannable, with the sentence", async () => {
			const { pendingId } = await renderedPlan();
			await setStatus(meetingId, "cancelled");
			const view = await loadPendingPlan({
				pendingId,
				userId: seed.adminUserId,
			});
			expect(view).toMatchObject({
				status: "unplannable",
				reason: "LOCKED",
				message: MEETING_CANCELLED_MESSAGE,
			});
		});

		describe("the apply, inside the club's lock", () => {
			async function applyAcrossLockWait(cancelWhileParked: boolean) {
				const { pendingId, planHash } = await renderedPlan();
				const lock = holdClubLock(seed.clubId);
				await lock.acquired;
				const applying = applyPendingPlan({
					pendingId,
					userId: seed.adminUserId,
					planHash,
				});
				// Parked inside its transaction, past every up-front check.
				await awaitLockWaiter(seed.clubId);
				if (cancelWhileParked) await setStatus(meetingId, "cancelled");
				await lock.release();
				return { pendingId, result: await applying };
			}

			it("the control: the same apply lands on a completed meeting", async () => {
				const { result } = await applyAcrossLockWait(false);
				expect(result.ok).toBe(true);
				expect(await rows()).toEqual({ guests: 1, attendance: 1 });
			});

			it("refuses a meeting cancelled during the wait, with the sentence, and writes nothing", async () => {
				const { pendingId, result } = await applyAcrossLockWait(true);
				expect(result.ok).toBe(false);
				expect(result.message).toBe(MEETING_CANCELLED_MESSAGE);
				expect(await rows()).toEqual({ guests: 0, attendance: 0 });
				// The refusal rolled back, so the page is still open for the officer to
				// see why, not tombstoned as recorded.
				const [pending] = (await pendingRows()).filter(
					(r) => r.id === pendingId,
				);
				expect(pending?.appliedAt).toBeNull();
			});
		});
	},
);

// ---------------------------------------------------------------------------
// The plan seam: both frozen statuses, in the body
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)(
	"the planned-attendance seam refuses by the plan class (#1137)",
	() => {
		let club: SeededClub;

		beforeEach(async () => {
			club = await seedClub();
		});

		afterEach(async () => {
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		});

		const set = () =>
			setPlanStatus(testDb, {
				memberId: club.memberId,
				meetingId: club.meetingId,
				clubId: club.clubId,
				status: "coming",
				actorMemberId: club.adminMemberId,
			});

		const clear = () =>
			clearPlanStatus(testDb, {
				memberId: club.memberId,
				meetingId: club.meetingId,
				clubId: club.clubId,
				actorMemberId: club.adminMemberId,
				onlyFrom: SELF_SERVICE_RUNGS,
			});

		const planRows = () =>
			testDb
				.select({ status: meetingAttendancePlan.status })
				.from(meetingAttendancePlan)
				.where(
					and(
						eq(meetingAttendancePlan.memberId, club.memberId),
						eq(meetingAttendancePlan.meetingId, club.meetingId),
					),
				);

		it("setPlanStatus writes on a scheduled meeting (the control)", async () => {
			await set();
			expect(await planRows()).toEqual([{ status: "coming" }]);
		});

		it.each([
			["cancelled", MEETING_CANCELLED_MESSAGE],
			["completed", MEETING_LOCKED_MESSAGE],
		] as const)("setPlanStatus on a %s meeting says %j and writes nothing", async (status, message) => {
			await setStatus(club.meetingId, status);
			await expect(set()).rejects.toThrow(
				new RegExp(`^${message.replace(/\./g, "\\.")}$`),
			);
			expect(await planRows()).toEqual([]);
		});

		it("clearPlanStatus clears on a scheduled meeting (the control)", async () => {
			await set();
			expect(await clear()).toEqual({ ok: true, cleared: true });
			expect(await planRows()).toEqual([]);
		});

		it.each([
			["cancelled", MEETING_CANCELLED_MESSAGE],
			["completed", MEETING_LOCKED_MESSAGE],
		] as const)("clearPlanStatus on a %s meeting says %j and leaves the answer", async (status, message) => {
			await set();
			await setStatus(club.meetingId, status);
			await expect(clear()).rejects.toThrow(
				new RegExp(`^${message.replace(/\./g, "\\.")}$`),
			);
			expect(await planRows()).toEqual([{ status: "coming" }]);
		});
	},
);

// ---------------------------------------------------------------------------
// Feedback: a note is written ABOUT a meeting, so it is the record class
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)(
	"anonymous feedback is a record write (#1137)",
	() => {
		let club: SeededClub;

		beforeEach(async () => {
			club = await seedClub();
			await testDb
				.update(meetings)
				.set({
					scheduledAt: new Date(Date.now() - 10 * MIN),
					lengthMinutes: 90,
				})
				.where(eq(meetings.id, club.meetingId));
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: club.memberId, status: "claimed" })
				.where(eq(roleSlots.id, club.slotId));
		});

		afterEach(async () => {
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		});

		const note = () => ({
			meetingId: club.meetingId,
			target: { kind: "slot" as const, id: club.slotId },
			wentWell: "Clear signals",
		});
		const notes = () =>
			testDb
				.select({ id: roleFeedbackNotes.id })
				.from(roleFeedbackNotes)
				.where(eq(roleFeedbackNotes.meetingId, club.meetingId));

		it("a COMPLETED meeting takes a note: record accepts what plan refuses", async () => {
			// Feedback is left after a meeting, which is when it is completed. A class
			// that refused `completed` would shut the feature at the moment of use.
			await setStatus(club.meetingId, "completed");
			expect(await leaveFeedbackLogic(note())).toEqual({ ok: true });
			expect(await notes()).toHaveLength(1);
		});

		it("a CANCELLED meeting refuses with the feedback sentence, not the policy's", async () => {
			await setStatus(club.meetingId, "cancelled");
			await expect(leaveFeedbackLogic(note())).rejects.toThrow(
				"This meeting was cancelled.",
			);
			expect(await notes()).toHaveLength(0);
		});
	},
);
