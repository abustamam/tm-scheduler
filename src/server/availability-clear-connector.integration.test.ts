/**
 * DB-backed tests for `clearPlannedAttendanceCore` with `proof: "connector"` (#1570).
 *
 * Card: protects=a token call may delete ONLY the token owner's own coming /
 * not_coming row: a claim naming another member is refused before any write,
 * and an officer-set reached_out is not the member's answer to take back;
 * fails_when=the isConnectorSelf gate is removed, the floor is widened, or the
 * connector path starts needing a cookie session; no_claim=the session path
 * (its own suites) and the MCP tool wrapper (set-my-attendance suite).
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
			).rejects.toThrow();
			expect(await planOf(s, s.memberId)).toBe("coming");
		});
	},
);
