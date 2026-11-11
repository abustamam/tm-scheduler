/**
 * DB-backed tests for `clearPlannedAttendanceCore` with `proof: "connector"` (#1570).
 *
 * Card: protects=a token call may delete ONLY the token owner's own coming /
 * not_coming row: a claim naming another member is refused before any write,
 * and an officer-set reached_out is not the member's answer to take back;
 * fails_when=connectorActor stops refusing a claim that is not the subject,
 * the floor is widened to take an officer's reached_out, the session
 * path stops requiring a proven session, or the
 * attendance lock + re-read is dropped so a newer answer is deleted;
 * no_claim=the session path (its own suites) and the MCP tool wrapper
 * (set-my-attendance suite).
 */
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { meetingAttendancePlan } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { clearPlannedAttendanceCore } = await import(
	"#/server/availability-logic"
);
const { SELF_ONLY_MESSAGE } = await import("#/server/attendance-actor-logic");
const { SIGN_IN_REQUIRED_MESSAGE } = await import("#/lib/write-proof");
const { lockMemberAttendance } = await import("#/server/attendance-plan-logic");
const { HeldSlotsChangedError } = await import("#/server/availability-logic");

const seeded: SeededClub[] = [];
afterEach(async () => {
	for (const s of seeded.splice(0).reverse()) {
		await cleanup(s.clubId, [s.adminUserId, s.memberUserId]);
	}
});

async function club(): Promise<SeededClub> {
	const s = await seedClub();
	seeded.push(s);
	return s;
}

const put = (
	s: SeededClub,
	memberId: string,
	status: "coming" | "not_coming" | "reached_out",
) =>
	testDb
		.insert(meetingAttendancePlan)
		.values({ memberId, meetingId: s.meetingId, status });

async function planOf(s: SeededClub, memberId: string) {
	const [row] = await testDb
		.select({ status: meetingAttendancePlan.status })
		.from(meetingAttendancePlan)
		.where(
			and(
				eq(meetingAttendancePlan.memberId, memberId),
				eq(meetingAttendancePlan.meetingId, s.meetingId),
			),
		);
	return row?.status ?? null;
}

const args = (s: SeededClub, claimed?: string) => ({
	memberId: s.memberId,
	meetingId: s.meetingId,
	clubId: s.clubId,
	claimedActorMemberId: claimed,
	proof: "connector" as const,
});

describe.skipIf(!hasTestDb)(
	"clearPlannedAttendanceCore, connector proof (#1570)",
	() => {
		it.each([
			"coming",
			"not_coming",
		] as const)("a connector clears its own %s row", async (status) => {
			const s = await club();
			await put(s, s.memberId, status);
			const out = await clearPlannedAttendanceCore(testDb, args(s, s.memberId));
			expect(out).toEqual({ ok: true, cleared: true });
			expect(await planOf(s, s.memberId)).toBeNull();
		});

		it("refuses a claim naming another member, before any write", async () => {
			const s = await club();
			await put(s, s.memberId, "not_coming");
			await expect(
				clearPlannedAttendanceCore(testDb, args(s, s.adminMemberId)),
			).rejects.toThrow(SELF_ONLY_MESSAGE);
			await expect(
				clearPlannedAttendanceCore(testDb, args(s, undefined)),
			).rejects.toThrow(SELF_ONLY_MESSAGE);
			expect(await planOf(s, s.memberId)).toBe("not_coming");
		});

		it("does not clear an officer-set reached_out row", async () => {
			const s = await club();
			await put(s, s.memberId, "reached_out");
			const out = await clearPlannedAttendanceCore(testDb, args(s, s.memberId));
			expect(out).toEqual({ ok: true, cleared: false });
			expect(await planOf(s, s.memberId)).toBe("reached_out");
		});

		it("leaves another member's row alone", async () => {
			const s = await club();
			await put(s, s.memberId, "coming");
			await put(s, s.adminMemberId, "coming");
			await clearPlannedAttendanceCore(testDb, args(s, s.memberId));
			expect(await planOf(s, s.adminMemberId)).toBe("coming");
		});

		it("without proof it still needs a cookie session (unchanged)", async () => {
			const s = await club();
			await put(s, s.memberId, "coming");
			await expect(
				clearPlannedAttendanceCore(testDb, {
					memberId: s.memberId,
					meetingId: s.meetingId,
					clubId: s.clubId,
					claimedActorMemberId: s.memberId,
				}),
			).rejects.toThrow(SIGN_IN_REQUIRED_MESSAGE);
			expect(await planOf(s, s.memberId)).toBe("coming");
		});

		it("a differing expectedPlanStatus is refused and the row survives", async () => {
			const s = await club();
			await put(s, s.memberId, "coming");
			await expect(
				clearPlannedAttendanceCore(testDb, {
					...args(s, s.memberId),
					expectedPlanStatus: "not_coming",
				}),
			).rejects.toBeInstanceOf(HeldSlotsChangedError);
			expect(await planOf(s, s.memberId)).toBe("coming");
		});

		it("a matching expectedPlanStatus clears", async () => {
			const s = await club();
			await put(s, s.memberId, "coming");
			const out = await clearPlannedAttendanceCore(testDb, {
				...args(s, s.memberId),
				expectedPlanStatus: "coming",
			});
			expect(out).toEqual({ ok: true, cleared: true });
			expect(await planOf(s, s.memberId)).toBeNull();
		});

		it("waits on the member's attendance lock and re-reads under it", async () => {
			const s = await club();
			await put(s, s.memberId, "not_coming");
			let release = () => {};
			const held = new Promise<void>((r) => {
				release = r;
			});
			let locked = () => {};
			const gotLock = new Promise<void>((r) => {
				locked = r;
			});
			// Another writer holds the lock, answers `coming`, then commits.
			const writer = testDb.transaction(async (tx) => {
				await lockMemberAttendance(tx, s.meetingId, s.memberId);
				locked();
				await held;
				await tx
					.update(meetingAttendancePlan)
					.set({ status: "coming" })
					.where(
						and(
							eq(meetingAttendancePlan.memberId, s.memberId),
							eq(meetingAttendancePlan.meetingId, s.meetingId),
						),
					);
			});
			await gotLock;
			// Previewed `not_coming`; the clear must queue behind the writer.
			const clear = clearPlannedAttendanceCore(testDb, {
				...args(s, s.memberId),
				expectedPlanStatus: "not_coming",
			}).then(
				() => null,
				(e: unknown) => e,
			);
			await new Promise((r) => setTimeout(r, 300));
			release();
			await writer;
			expect(await clear).toBeInstanceOf(HeldSlotsChangedError);
			expect(await planOf(s, s.memberId)).toBe("coming");
		});
	},
);
