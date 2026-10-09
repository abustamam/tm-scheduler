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
 * Several refusals cannot be reached by a serial call and are driven across a
 * real wait instead, each with a `waitForLockWait` that proves the writer is
 * parked behind THIS test's transaction before the world moves:
 *
 *  - `captureGuestVisit` resolves the meeting it records against BEFORE its
 *    transaction, and `resolveCurrentMeeting` already skips a cancelled one, so
 *    the refusal inside the transaction is only reachable when the meeting is
 *    cancelled after that read: while the visit queues on the club write lock,
 *    or while a cancel is still uncommitted when the visit reads the row (the
 *    `FOR SHARE` makes it wait for the commit and then see it);
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
	guestInvites,
	guests,
	mcpPendingPlans,
	meetingAttendance,
	meetingAttendancePlan,
	meetings,
	people,
	roleDefinitions,
	roleFeedbackNotes,
	roleSlots,
	speeches,
} from "#/db/schema";
import { utcToZonedWallTime } from "#/lib/datetime";
import { MEETING_CANCELLED_MESSAGE } from "#/lib/meeting-cancellation-notice";
import type { MeetingStatus } from "#/lib/meeting-lifecycle";
import { awaitLockWaiter, holdClubLock } from "#/test/club-lock";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	type TestTx,
	testDb,
	waitForLockWait,
	withGuestPerson,
} from "#/test/db";
import type { Conn } from "./guest-book-plan";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { lockClubForWrite } = await import("./club-write-lock");
const { applyRecordGuestInvite, captureGuestVisit } = await import(
	"./guest-pipeline-logic"
);
const { clearPlanStatus, setPlanStatus, SELF_SERVICE_RUNGS } = await import(
	"./attendance-plan-logic"
);
const { attachSpeechToOpenSlot } = await import("./speeches-logic");
const { leaveFeedbackLogic } = await import("./role-feedback-logic");
const { recordGuestBookTool } = await import("./mcp/tools/record-guest-book");
const { hashApiToken } = await import("./api-tokens-logic");
const { applyPendingPlan, loadPendingPlan } = await import(
	"./guest-book-pending-logic"
);
const { assertGuestBookMeetingRecordable, DATE_NAMES_NO_MEETING_MESSAGE } =
	await import("./guest-book-recordable");
const { McpError } = await import("./mcp/errors");

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Exact-string matcher, so a case cannot pass on an unrelated throw. */
const exact = (message: string) =>
	new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

async function setStatus(
	meetingId: string,
	status: MeetingStatus,
): Promise<void> {
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

		/**
		 * What the visit would have minted, read back from the tables. A visit
		 * writes a guest row and an attendance row and nothing else, so those are
		 * the two counts that can fall short of the truth.
		 */
		async function minted() {
			const [g, a] = await Promise.all([
				testDb
					.select({ id: guests.id })
					.from(guests)
					.where(eq(guests.clubId, club.clubId)),
				testDb
					.select({ id: meetingAttendance.id })
					.from(meetingAttendance)
					.where(eq(meetingAttendance.meetingId, club.meetingId)),
			]);
			return { guests: g.length, attendance: a.length };
		}

		type VisitOutcome =
			| { ok: true; result: Awaited<ReturnType<typeof captureGuestVisit>> }
			| { ok: false; message: string };

		function startVisit(phone?: string): Promise<VisitOutcome> {
			return captureGuestVisit({
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
		}

		/**
		 * Start a visit, park it on a statement a blocker's open transaction holds
		 * up, run `work` in that transaction, then commit it and let the visit
		 * finish. The blocker is committed in a `finally`, so a harness failure
		 * never leaves a transaction (and its locks) open for the next test.
		 *
		 * `parkedIn` is a fragment of the statement the visit must be stuck in;
		 * `waitForLockWait` is the control for the harness, proving the visit is
		 * parked behind THIS blocker, so a refusal afterwards cannot be an
		 * up-front one.
		 */
		async function visitWhile(
			work: (tx: TestTx) => Promise<void>,
			parkedIn: string,
			phone?: string,
		): Promise<VisitOutcome> {
			const blocker = await openBlockingTx(work);
			const visit = startVisit(phone);
			try {
				await waitForLockWait(parkedIn, blocker.pid);
			} finally {
				await blocker.commit();
				await visit;
			}
			return visit;
		}

		/** Hold the club write lock the visit takes first, then run `change`. */
		function visitQueuedOnClubLock(
			change?: (tx: TestTx) => Promise<void>,
			phone?: string,
		) {
			return visitWhile(
				async (tx) => {
					await lockClubForWrite(tx, club.clubId);
					await change?.(tx);
				},
				"pg_advisory_xact_lock",
				phone,
			);
		}

		const cancel = (tx: TestTx) =>
			tx
				.update(meetings)
				.set({ status: "cancelled" })
				.where(eq(meetings.id, club.meetingId))
				.then(() => undefined);

		it("the control: a visit that waits on the club lock and meets a scheduled meeting is recorded", async () => {
			const out = await visitQueuedOnClubLock();
			expect(out).toMatchObject({
				ok: true,
				result: { created: true, attendanceRecorded: true },
			});
			expect(await minted()).toEqual({ guests: 1, attendance: 1 });
		});

		it("refuses a meeting cancelled while the visit waited on the club lock, with the policy's sentence, and mints no guest or attendance row", async () => {
			const out = await visitQueuedOnClubLock(cancel);
			expect(out).toEqual({ ok: false, message: MEETING_CANCELLED_MESSAGE });
			expect(await minted()).toEqual({ guests: 0, attendance: 0 });
		});

		it("a RETURNING guest is refused too, and the contact fill-in rolls back with it", async () => {
			const [existing] = await testDb
				.insert(guests)
				.values(
					await withGuestPerson(
						{ clubId: club.clubId, name: "Visitor Guest", email: email() },
						testDb,
					),
				)
				.returning({ id: guests.id });
			if (!existing) throw new Error("failed to seed the returning guest");
			const out = await visitQueuedOnClubLock(cancel, "+1 555 010 0199");
			expect(out).toEqual({ ok: false, message: MEETING_CANCELLED_MESSAGE });
			const [row] = await testDb
				.select({ phone: people.phone })
				.from(guests)
				.innerJoin(people, eq(people.id, guests.personId))
				.where(eq(guests.id, existing.id));
			expect(row?.phone).toBeNull();
			expect((await minted()).attendance).toBe(0);
		});

		describe("a cancel that has not committed yet (the FOR SHARE on the meeting row)", () => {
			it("the control: a visit blocked behind an unrelated uncommitted edit of the meeting waits, then records", async () => {
				// Proves the harness: the visit really is stuck on the meeting row, and
				// what it does after the commit is the ordinary write.
				const out = await visitWhile(
					(tx) =>
						tx
							.update(meetings)
							.set({ theme: "Edited while a visit arrived" })
							.where(eq(meetings.id, club.meetingId))
							.then(() => undefined),
					"for share",
				);
				expect(out).toMatchObject({
					ok: true,
					result: { created: true, attendanceRecorded: true },
				});
				expect(await minted()).toEqual({ guests: 1, attendance: 1 });
			});

			it("waits for the cancel to commit, then refuses with the policy's sentence and mints nothing", async () => {
				// The visit resolved the meeting as scheduled and is now reading its
				// status while a cancel holds the row uncommitted. A plain read would
				// answer "scheduled" at once and write the attendance row under it.
				const out = await visitWhile(cancel, "for share");
				expect(out).toEqual({ ok: false, message: MEETING_CANCELLED_MESSAGE });
				expect(await minted()).toEqual({ guests: 0, attendance: 0 });
			});
		});

		it("a meeting that is deleted while the visit waited says so, and mints nothing", async () => {
			const out = await visitQueuedOnClubLock((tx) =>
				tx
					.delete(meetings)
					.where(eq(meetings.id, club.meetingId))
					.then(() => undefined),
			);
			expect(out).toEqual({ ok: false, message: "Meeting not found." });
			expect((await minted()).guests).toBe(0);
		});

		it("a COMPLETED meeting in progress still takes the visit (record accepts what plan refuses)", async () => {
			await setStatus(club.meetingId, "completed");
			const res = await captureGuestVisit({
				clubId: club.clubId,
				name: "Visitor Guest",
				email: email(),
			});
			expect(res).toMatchObject({ created: true, attendanceRecorded: true });
			expect(await minted()).toEqual({ guests: 1, attendance: 1 });
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
			expect(await minted()).toEqual({ guests: 1, attendance: 0 });
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

		const apply = (pendingId: string, planHash: string) =>
			applyPendingPlan({ pendingId, userId: seed.adminUserId, planHash });

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

		it("the scheduled happy path: a meeting nobody pressed Complete on previews, renders and applies", async () => {
			// Clubs routinely never press Complete, so a past meeting still reads
			// `scheduled`, and it must stay recordable.
			await setStatus(meetingId, "scheduled");
			const { pendingId, planHash } = await renderedPlan();
			const result = await apply(pendingId, planHash);
			expect(result.ok).toBe(true);
			expect(await rows()).toEqual({ guests: 1, attendance: 1 });
		});

		describe("the apply, inside the club's lock", () => {
			async function applyAcrossLockWait(cancelWhileParked: boolean) {
				const { pendingId, planHash } = await renderedPlan();
				const lock = holdClubLock(seed.clubId);
				await lock.acquired;
				const applying = apply(pendingId, planHash);
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

			it("waits for a cancel that has not committed yet, then refuses (FOR SHARE on the meeting row)", async () => {
				const { pendingId, planHash } = await renderedPlan();
				const blocker = await openBlockingTx((tx) =>
					tx
						.update(meetings)
						.set({ status: "cancelled" })
						.where(eq(meetings.id, meetingId))
						.then(() => undefined),
				);
				const applying = apply(pendingId, planHash);
				try {
					await waitForLockWait("for share", blocker.pid);
				} finally {
					await blocker.commit();
					await applying;
				}
				const result = await applying;
				expect(result.ok).toBe(false);
				expect(result.message).toBe(MEETING_CANCELLED_MESSAGE);
				expect(await rows()).toEqual({ guests: 0, attendance: 0 });
			});

			describe("precedence over a stale page", () => {
				/** The club changes under the page: Wanda is now on file, so the plan's
				 *  `new` becomes `matched` and the hash the page holds goes stale. */
				async function staleThePage() {
					await testDb.insert(guests).values(
						await withGuestPerson(
							{
								clubId: seed.clubId,
								name: "Wanda Visitor",
								email: "wanda@example.com",
							},
							testDb,
						),
					);
				}

				it("the control: a stale page on a completed meeting hears that it is stale", async () => {
					const { pendingId, planHash } = await renderedPlan();
					await staleThePage();
					const result = await apply(pendingId, planHash);
					expect(result.ok).toBe(false);
					expect(result.message).toMatch(
						/^The club changed since this page was loaded/,
					);
				});

				it("a page that is BOTH stale and for a cancelled meeting hears the cancellation", async () => {
					// The gate runs ahead of the hash comparison, so the officer is told
					// the reason a refresh cannot fix, not "check the refreshed plan".
					const { pendingId, planHash } = await renderedPlan();
					await staleThePage();
					await setStatus(meetingId, "cancelled");
					const result = await apply(pendingId, planHash);
					expect(result.ok).toBe(false);
					expect(result.message).toBe(MEETING_CANCELLED_MESSAGE);
				});
			});
		});

		describe("assertGuestBookMeetingRecordable, on a connection that answers what a real one cannot", () => {
			/** The query chain the helper builds, ending in `for("share")`. */
			function answering(found: { status: string }[]): Conn {
				const chain = {
					from: () => chain,
					where: () => chain,
					limit: () => chain,
					for: () => Promise.resolve(found),
				};
				return { select: () => chain } as unknown as Conn;
			}

			it("a meeting that is gone is BLOCKED with the shared sentence, not left to a foreign key", async () => {
				await expect(
					assertGuestBookMeetingRecordable(answering([]), meetingId),
				).rejects.toMatchObject({
					code: "BLOCKED",
					message: DATE_NAMES_NO_MEETING_MESSAGE,
				});
			});

			it("a status the policy has never heard of is NOT reported as LOCKED", async () => {
				// A Postgres enum value cannot be dropped, so one added and rolled back
				// stays in the column. The write fails closed, and says what it knows:
				// not that the meeting is locked.
				const err = await assertGuestBookMeetingRecordable(
					answering([{ status: "archived" }]),
					meetingId,
				).then(
					() => null,
					(e: unknown) => e,
				);
				expect(err).toBeInstanceOf(Error);
				expect(err).not.toBeInstanceOf(McpError);
				expect((err as Error).message).toBe("Unknown meeting status: archived");
			});
		});
	},
);

// ---------------------------------------------------------------------------
// The plan seam: refuses CANCELLED itself, and leaves completed to its callers
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)(
	"the planned-attendance seam refuses cancelled and leaves completed to its callers (#1137)",
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

		it("setPlanStatus on a cancelled meeting says the policy's sentence and writes nothing", async () => {
			await setStatus(club.meetingId, "cancelled");
			await expect(set()).rejects.toThrow(exact(MEETING_CANCELLED_MESSAGE));
			expect(await planRows()).toEqual([]);
		});

		it("setPlanStatus on a completed meeting writes: completed is the callers' to refuse, as it was", async () => {
			await setStatus(club.meetingId, "completed");
			await set();
			expect(await planRows()).toEqual([{ status: "coming" }]);
		});

		it("clearPlanStatus clears on a scheduled meeting (the control)", async () => {
			await set();
			expect(await clear()).toEqual({ ok: true, cleared: true });
			expect(await planRows()).toEqual([]);
		});

		it("clearPlanStatus on a cancelled meeting says the policy's sentence and leaves the answer", async () => {
			await set();
			await setStatus(club.meetingId, "cancelled");
			await expect(clear()).rejects.toThrow(exact(MEETING_CANCELLED_MESSAGE));
			expect(await planRows()).toEqual([{ status: "coming" }]);
		});

		it("clearPlanStatus on a completed meeting clears: the same split", async () => {
			await set();
			await setStatus(club.meetingId, "completed");
			expect(await clear()).toEqual({ ok: true, cleared: true });
			expect(await planRows()).toEqual([]);
		});
	},
);

// ---------------------------------------------------------------------------
// A RECORD write reaches the plan seam on a completed meeting, on purpose
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)(
	"attachSpeechToOpenSlot on a completed meeting reaches the plan seam and is accepted (#1137)",
	() => {
		let club: SeededClub;
		let speakerSlotId: string;
		let speechId: string;

		beforeEach(async () => {
			club = await seedClub();
			const [def] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: club.clubId,
					name: "Speaker",
					category: "speaker",
					isSpeakerRole: true,
				})
				.returning({ id: roleDefinitions.id });
			if (!def) throw new Error("failed to seed the speaker role");
			const [slot] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: club.meetingId,
					roleDefinitionId: def.id,
					status: "open",
				})
				.returning({ id: roleSlots.id });
			if (!slot) throw new Error("failed to seed the speaker slot");
			speakerSlotId = slot.id;
			const [speech] = await testDb
				.insert(speeches)
				.values({ personId: club.personId, title: "Ice Breaker" })
				.returning({ id: speeches.id });
			if (!speech) throw new Error("failed to seed the speech");
			speechId = speech.id;
			// A speech given in an open slot is recorded after the meeting: that is
			// the whole reason this writer is a record write.
			await setStatus(club.meetingId, "completed");
		});

		afterEach(async () => {
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		});

		const slotRow = async () => {
			const [row] = await testDb
				.select({
					status: roleSlots.status,
					assignedMemberId: roleSlots.assignedMemberId,
					speechId: roleSlots.speechId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, speakerSlotId));
			return row;
		};

		const planRows = () =>
			testDb
				.select({
					memberId: meetingAttendancePlan.memberId,
					status: meetingAttendancePlan.status,
				})
				.from(meetingAttendancePlan)
				.where(eq(meetingAttendancePlan.meetingId, club.meetingId));

		it("the speech's OWNER scheduling it: the slot is written and they are recorded as coming", async () => {
			// The self arm goes through `markComingOnSelfClaim` into `setPlanStatus`.
			// A seam that refused completed would answer "This meeting is locked." to
			// a member recording their own speech, where an officer is let through.
			await attachSpeechToOpenSlot(testDb, {
				speechId,
				slotId: speakerSlotId,
				actorMemberId: club.memberId,
			});
			expect(await slotRow()).toEqual({
				status: "claimed",
				assignedMemberId: club.memberId,
				speechId,
			});
			expect(await planRows()).toEqual([
				{ memberId: club.memberId, status: "coming" },
			]);
		});

		it("an OFFICER scheduling it: the slot is written and nobody is recorded as coming for the speaker", async () => {
			await attachSpeechToOpenSlot(testDb, {
				speechId,
				slotId: speakerSlotId,
				actorMemberId: club.adminMemberId,
			});
			expect(await slotRow()).toEqual({
				status: "claimed",
				assignedMemberId: club.memberId,
				speechId,
			});
			expect(await planRows()).toEqual([]);
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
				exact("This meeting was cancelled."),
			);
			expect(await notes()).toHaveLength(0);
		});
	},
);

// ---------------------------------------------------------------------------
// Invites: the writer's own sentence survives the class
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)(
	"applyRecordGuestInvite refuses a cancelled meeting in its own words (#1137)",
	() => {
		let club: SeededClub;
		let guestId: string;

		beforeEach(async () => {
			club = await seedClub();
			const [guest] = await testDb
				.insert(guests)
				.values(
					await withGuestPerson(
						{ clubId: club.clubId, name: "Invitee", stage: "prospect" },
						testDb,
					),
				)
				.returning({ id: guests.id });
			if (!guest) throw new Error("failed to seed the guest");
			guestId = guest.id;
		});

		afterEach(async () => {
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		});

		const invite = () =>
			applyRecordGuestInvite({
				clubId: club.clubId,
				guestId,
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});

		const invites = () =>
			testDb
				.select({ id: guestInvites.id })
				.from(guestInvites)
				.where(eq(guestInvites.clubId, club.clubId));

		it("records the invite on a scheduled meeting (the control)", async () => {
			expect(await invite()).toEqual({ ok: true });
			expect(await invites()).toHaveLength(1);
		});

		it("refuses a cancelled meeting with 'That meeting is cancelled.', not the policy's default, and records nothing", async () => {
			await setStatus(club.meetingId, "cancelled");
			await expect(invite()).rejects.toThrow(
				exact("That meeting is cancelled."),
			);
			expect(await invites()).toEqual([]);
		});
	},
);
