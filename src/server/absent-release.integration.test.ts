/**
 * #1256: marking a role-holder Absent on the roll frees their roles, opt-in,
 * in the same transaction as the Absent write.
 *
 * Runs the REAL `setAttendance` handler through the minimal adapter
 * `attendance-mode-authz.integration.test.ts` uses (a `createServerFn` handler
 * needs the Start runtime), against the worktree's test database. Only
 * `requireUser` is stubbed; `requireClubRole`, the record-window checks, the
 * transaction and the release all run for real.
 *
 * Fixture: the seeded member holds the seeded Timer slot AND Speaker 2 (with a
 * speech attached); the admin holds Speaker 1. So a release that numbered the
 * member's own slots only would say "Speaker", one that freed by meeting would
 * take the admin's slot too, and a release that deleted the speech would show.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	meetingAttendance,
	meetingAttendancePlan,
	meetings,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({
		validator: (parse: (input: unknown) => unknown) => ({
			handler:
				(handle: (input: { data: unknown }) => unknown) =>
				({ data }: { data: unknown }) =>
					handle({ data: parse(data) }),
		}),
	}),
}));

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { currentUser } = vi.hoisted(() => ({
	currentUser: { id: "" },
}));

vi.mock("./guards", async (importOriginal) => ({
	...(await importOriginal<typeof import("./guards")>()),
	requireUser: vi.fn(async () => ({ id: currentUser.id })),
}));

const { setAttendance } = await import("./minutes");
const { NO_PERMISSION_MESSAGE } = await import("./guards");
const { ATTENDANCE_BEFORE_MEETING_MESSAGE } = await import(
	"#/lib/meeting-lifecycle"
);

/** The adapter runs the validator synchronously, so a validation refusal is a
 *  THROW rather than a rejection; this folds both into one promise. */
const attempt = (fn: () => unknown) => (async () => fn())();

const DAY = 24 * 60 * 60 * 1000;
const SPEECH_TITLE = "Ice Breaker";

describe.skipIf(!hasTestDb)("Absent releases held roles (#1256)", () => {
	let seed: SeededClub;
	let speakerOneId: string;
	let speakerTwoId: string;
	let speechId: string;

	beforeEach(async () => {
		seed = await seedClub();
		currentUser.id = seed.adminUserId;
		// The meeting day must have arrived or `assertAttendanceRecordable`
		// refuses first.
		await setMeeting({ scheduledAt: new Date(Date.now() - 60 * 1000) });

		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
				sortOrder: 5,
			})
			.returning({ id: roleDefinitions.id });
		const [speech] = await testDb
			.insert(speeches)
			.values({ personId: seed.personId, title: SPEECH_TITLE })
			.returning({ id: speeches.id });
		speechId = speech!.id;
		const [one, two] = await testDb
			.insert(roleSlots)
			.values([
				{
					meetingId: seed.meetingId,
					roleDefinitionId: def!.id,
					slotIndex: 0,
					status: "claimed",
					assignedMemberId: seed.adminMemberId,
					claimedAt: new Date(),
				},
				{
					meetingId: seed.meetingId,
					roleDefinitionId: def!.id,
					slotIndex: 1,
					status: "claimed",
					assignedMemberId: seed.memberId,
					claimedAt: new Date(),
					speechId,
				},
			])
			.returning({ id: roleSlots.id });
		speakerOneId = one!.id;
		speakerTwoId = two!.id;
		// The seeded Timer slot.
		await testDb
			.update(roleSlots)
			.set({
				assignedMemberId: seed.memberId,
				status: "claimed",
				claimedAt: new Date(),
			})
			.where(eq(roleSlots.id, seed.slotId));
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	async function setMeeting(set: Partial<typeof meetings.$inferInsert>) {
		await testDb
			.update(meetings)
			.set(set)
			.where(eq(meetings.id, seed.meetingId));
	}

	async function slotRow(id: string) {
		const [row] = await testDb
			.select({
				status: roleSlots.status,
				assignedMemberId: roleSlots.assignedMemberId,
				claimedAt: roleSlots.claimedAt,
				speechId: roleSlots.speechId,
			})
			.from(roleSlots)
			.where(eq(roleSlots.id, id));
		return row;
	}

	async function attendanceOf(memberId: string) {
		return testDb
			.select({ status: meetingAttendance.status })
			.from(meetingAttendance)
			.where(
				and(
					eq(meetingAttendance.meetingId, seed.meetingId),
					eq(meetingAttendance.memberId, memberId),
				),
			);
	}

	async function releaseRows() {
		const rows = await testDb
			.select({
				targetId: activityLog.targetId,
				actorMemberId: activityLog.actorMemberId,
				detail: activityLog.detail,
			})
			.from(activityLog)
			.where(eq(activityLog.action, "release"));
		// Scoped to this run's slots: `activity_log` is shared across parallel files.
		return rows.filter((r) =>
			[seed.slotId, speakerOneId, speakerTwoId].includes(r.targetId ?? ""),
		);
	}

	/** The dialog listed Timer and Speaker 2; those ids are what the officer
	 *  confirmed and what rides with the flag. */
	const absentWithRelease = (
		releaseSlotIds: string[] = [seed.slotId, speakerTwoId],
	) =>
		setAttendance({
			data: {
				meetingId: seed.meetingId,
				memberId: seed.memberId,
				status: "absent",
				releaseHeldRoles: true,
				releaseSlotIds,
			},
		});

	it("frees every held role, keeps the speech, records Absent, leaves the plan answer, logs one release per slot", async () => {
		// protects=criterion 1: both slots open with null assignee/claimed_at/speech_id,
		//   the speech row still there, attendance absent, plan row unchanged, two
		//   release rows (cause absent) credited to the officer, the numbered labels
		//   returned, and another member's slot untouched
		// fails_when=the release stops after one slot, deletes the speech, rewrites the
		//   plan row to not_coming, drops the cause, numbers "Speaker" off the member's
		//   own slots, or frees by meeting instead of by holder
		// no_claim=the toast/dialog (component and route tests); the drain (unit)
		await testDb.insert(meetingAttendancePlan).values({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			status: "coming",
		});

		const result = await absentWithRelease();

		expect(result.ok).toBe(true);
		expect(result.released.map((r) => [r.label, r.speechTitle]).sort()).toEqual(
			[
				["Speaker 2", SPEECH_TITLE],
				["Timer", null],
			],
		);
		for (const id of [seed.slotId, speakerTwoId]) {
			expect(await slotRow(id)).toEqual({
				status: "open",
				assignedMemberId: null,
				claimedAt: null,
				speechId: null,
			});
		}
		const [kept] = await testDb
			.select({ title: speeches.title })
			.from(speeches)
			.where(eq(speeches.id, speechId));
		expect(kept?.title).toBe(SPEECH_TITLE);

		expect(await attendanceOf(seed.memberId)).toEqual([{ status: "absent" }]);
		const [plan] = await testDb
			.select({ status: meetingAttendancePlan.status })
			.from(meetingAttendancePlan)
			.where(eq(meetingAttendancePlan.memberId, seed.memberId));
		expect(plan?.status).toBe("coming");

		const logs = await releaseRows();
		expect(logs).toHaveLength(2);
		expect(logs.map((l) => l.targetId).sort()).toEqual(
			[seed.slotId, speakerTwoId].sort(),
		);
		for (const log of logs) {
			expect(log.actorMemberId).toBe(seed.adminMemberId);
			expect(log.detail).toMatchObject({
				fromMemberId: seed.memberId,
				cause: "absent",
				proof: "session",
			});
		}
		// The admin's own Speaker 1 is not the member's to lose.
		expect((await slotRow(speakerOneId))?.assignedMemberId).toBe(
			seed.adminMemberId,
		);
	});

	it("releases on a scheduled meeting whose day has long PASSED", async () => {
		// protects=criterion 2 (day passed): no time window on the roll release
		// fails_when=the Not-coming window (`assertReleasableWindow`) is reused here
		// no_claim=a completed meeting (next case); the pre-day refusal (last case)
		await setMeeting({ scheduledAt: new Date(Date.now() - 30 * DAY) });

		const result = await absentWithRelease();

		expect(result.released).toHaveLength(2);
		expect((await slotRow(seed.slotId))?.status).toBe("open");
		expect((await slotRow(speakerTwoId))?.assignedMemberId).toBeNull();
	});

	it("releases on a COMPLETED meeting", async () => {
		// protects=criterion 2 (completed): after Complete the roll is the way to
		//   free a role, so the record class must accept it
		// fails_when=the release runs under the plan class (refuses completed) and
		//   the Absent write lands while the roles stay assigned
		// no_claim=a cancelled meeting, which `assertMinutesMeetingRecordable`
		//   refuses (cancelled-meeting-officer-writes suite)
		await setMeeting({ status: "completed" });

		const result = await absentWithRelease();

		expect(result.released).toHaveLength(2);
		expect((await slotRow(seed.slotId))?.assignedMemberId).toBeNull();
		expect((await slotRow(speakerTwoId))?.speechId).toBeNull();
		expect(await attendanceOf(seed.memberId)).toEqual([{ status: "absent" }]);
	});

	it("Keep roles: Absent is recorded and both slots stay assigned", async () => {
		// protects=criterion 3: `releaseHeldRoles: false` is a plain Absent
		// fails_when=the server frees roles whenever status is absent
		// no_claim=that the dialog sends false for "Keep roles" (route guard)
		const result = await setAttendance({
			data: {
				meetingId: seed.meetingId,
				memberId: seed.memberId,
				status: "absent",
				releaseHeldRoles: false,
			},
		});

		expect(result.released).toEqual([]);
		expect(await attendanceOf(seed.memberId)).toEqual([{ status: "absent" }]);
		expect((await slotRow(seed.slotId))?.assignedMemberId).toBe(seed.memberId);
		expect((await slotRow(speakerTwoId))?.assignedMemberId).toBe(seed.memberId);
		expect(await releaseRows()).toEqual([]);
	});

	it("a call WITHOUT the field (a tab from before the deploy) releases nothing", async () => {
		// protects=criterion 4, the stale-tab rule of #663: the field defaults false
		// fails_when=the schema default flips to true, or the field becomes required
		//   (an old tab's write would then fail instead of recording Absent)
		// no_claim=that the zod default is spelled `.default(false)` (guard test)
		const result = await setAttendance({
			data: {
				meetingId: seed.meetingId,
				memberId: seed.memberId,
				status: "absent",
			},
		});

		expect(result.released).toEqual([]);
		expect(await attendanceOf(seed.memberId)).toEqual([{ status: "absent" }]);
		expect((await slotRow(seed.slotId))?.assignedMemberId).toBe(seed.memberId);
		expect(await releaseRows()).toEqual([]);
	});

	it("a LISTED slot reassigned before the release runs is NOT freed, and is not reported", async () => {
		// protects=criterion 6: the release re-checks the holder at execution (a
		//   queued op drains later), so a confirmed slot now held by someone else is
		//   left alone; the result names only what was freed
		// fails_when=the UPDATE drops `assigned_member_id = member`, or the labels
		//   come from the pre-update read instead of the RETURNING rows
		// no_claim=the toast text (use-offline-minutes test); the queue is simulated
		//   by reassigning in the database, not by a real offline drain
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: seed.adminMemberId })
			.where(eq(roleSlots.id, seed.slotId));

		const result = await absentWithRelease();

		expect(result.released.map((r) => r.label)).toEqual(["Speaker 2"]);
		expect((await slotRow(seed.slotId))?.assignedMemberId).toBe(
			seed.adminMemberId,
		);
		expect((await slotRow(speakerTwoId))?.assignedMemberId).toBeNull();
		expect((await releaseRows()).map((r) => r.targetId)).toEqual([
			speakerTwoId,
		]);
	});

	it("a role given to the member after the confirm survives the replay (H1)", async () => {
		// protects=H1's own scenario: release confirmed for slot A (Timer); the
		//   member is later assigned slot B (Speaker 2's sibling); the replay frees
		//   A's (already open) nothing and leaves B assigned
		// fails_when=the replay frees by holder instead of by the confirmed ids
		// no_claim=none beyond protects
		const timerOnly = [seed.slotId];
		await absentWithRelease(timerOnly);
		expect((await slotRow(seed.slotId))?.assignedMemberId).toBeNull();
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: seed.memberId, status: "claimed" })
			.where(eq(roleSlots.id, speakerOneId));

		const replay = await absentWithRelease(timerOnly);

		expect(replay.released).toEqual([]);
		expect((await slotRow(speakerOneId))?.assignedMemberId).toBe(seed.memberId);
		// Speaker 2 was never in the list either.
		expect((await slotRow(speakerTwoId))?.assignedMemberId).toBe(seed.memberId);
	});

	it("refuses releaseHeldRoles without releaseSlotIds, and releaseSlotIds without releaseHeldRoles", async () => {
		// protects=the schema ties the ids to the flag both ways: a bare flag (which
		//   would free whatever is held at replay time) is a refusal, as are ids
		//   with no flag or an empty list
		// fails_when=the refinement is dropped or only checks one direction
		// no_claim=the guard test pins the schema text
		const base = {
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			status: "absent" as const,
		};
		for (const data of [
			{ ...base, releaseHeldRoles: true },
			{ ...base, releaseHeldRoles: true, releaseSlotIds: [] },
			{ ...base, releaseSlotIds: [seed.slotId] },
			{ ...base, releaseHeldRoles: false, releaseSlotIds: [seed.slotId] },
		]) {
			await expect(attempt(() => setAttendance({ data }))).rejects.toThrow(
				/releaseSlotIds is required with releaseHeldRoles/,
			);
		}
		expect(await attendanceOf(seed.memberId)).toEqual([]);
		expect((await slotRow(seed.slotId))?.assignedMemberId).toBe(seed.memberId);
	});

	it("replaying the release after the roles are gone frees nothing and still records Absent", async () => {
		// protects=an op replayed after its roles were freed (a retry, a double tap) is
		//   ordinary: empty list, attendance still absent, no extra activity rows
		// fails_when=an empty release throws, skips the Absent upsert, or logs again
		// no_claim=none beyond protects
		const first = await absentWithRelease();
		expect(first.released).toHaveLength(2);

		const again = await absentWithRelease();

		expect(again.released).toEqual([]);
		expect(await attendanceOf(seed.memberId)).toEqual([{ status: "absent" }]);
		expect(await releaseRows()).toHaveLength(2);
	});

	it("refuses releaseHeldRoles with status present, and writes nothing", async () => {
		// protects=criterion 5: only Absent frees roles
		// fails_when=the refinement is dropped, so Present + flag frees the roles of
		//   a member who is in the room
		// no_claim=Excused (retiring, #1255) is covered by the same refinement but
		//   not exercised here
		await expect(
			attempt(() =>
				setAttendance({
					data: {
						meetingId: seed.meetingId,
						memberId: seed.memberId,
						status: "present",
						releaseHeldRoles: true,
						releaseSlotIds: [seed.slotId],
					},
				}),
			),
		).rejects.toThrow(/Only an absent attendee's roles can be released/);

		expect(await attendanceOf(seed.memberId)).toEqual([]);
		expect((await slotRow(seed.slotId))?.assignedMemberId).toBe(seed.memberId);
	});

	it("a plain member cannot release another member's roles", async () => {
		// protects=criterion 7: `gateAdmin` runs ahead of the release; nothing is
		//   written and the slots stay
		// fails_when=the release is reachable before / without the admin gate
		// no_claim=non-members and signed-out callers (`requireUser`/`requireClubRole`
		//   own those)
		currentUser.id = seed.memberUserId;

		await expect(absentWithRelease()).rejects.toThrow(NO_PERMISSION_MESSAGE);

		expect(await attendanceOf(seed.memberId)).toEqual([]);
		expect((await slotRow(seed.slotId))?.assignedMemberId).toBe(seed.memberId);
		expect((await slotRow(speakerTwoId))?.assignedMemberId).toBe(seed.memberId);
		expect(await releaseRows()).toEqual([]);
	});

	it("a meeting still weeks away is refused before anything is freed", async () => {
		// protects=`assertAttendanceRecordable` still runs ahead of the release: Not
		//   coming covers the before-the-day case
		// fails_when=the release path skips the pre-day check
		// no_claim=none beyond protects
		await setMeeting({ scheduledAt: new Date(Date.now() + 7 * DAY) });

		await expect(absentWithRelease()).rejects.toThrow(
			ATTENDANCE_BEFORE_MEETING_MESSAGE,
		);

		expect(await attendanceOf(seed.memberId)).toEqual([]);
		expect((await slotRow(seed.slotId))?.assignedMemberId).toBe(seed.memberId);
	});
});
