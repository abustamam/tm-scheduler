/**
 * DB-backed tests for `get_my_schedule` (#1281), called with a real minted token.
 *
 * Card (shared): protects=a member sees only their own roles and answer, in
 * their own open clubs, for non-cancelled meetings inside the window;
 * fails_when=another member's role or plan row, a cancelled or out-of-window
 * meeting, or an archived club appears; no_claim=the attendance precedence is
 * unit-tested on `combineAttendance`; the roll row is a seeded
 * `meeting_attendance`, not one written by the roll UI.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	clubs,
	meetingAttendance,
	meetingAttendancePlan,
	meetings,
	roleSlots,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";
import { readsOf, statementsDuring } from "#/test/query-spy";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { getMyScheduleTool, combineAttendance, isoInTimezone } = await import(
	"#/server/mcp/tools/get-my-schedule"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");

const DAY = 24 * 60 * 60 * 1000;

type Result = {
	meetings: {
		meetingId: string;
		clubId: string;
		clubName: string;
		startsAt: string;
		status: string;
		myRoles: string[];
		myAttendance: string | null;
	}[];
};

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

async function tokenFor(userId: string): Promise<string> {
	const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
	await testDb
		.insert(apiTokens)
		.values({ userId, tokenHash: hashApiToken(raw), name: "test" });
	return raw;
}

function call(token: string, args: Record<string, unknown> = {}) {
	return getMyScheduleTool.handler(args, {
		rawToken: token,
		audience: "member",
	}) as Promise<Result>;
}

/**
 * Card (combineAttendance): protects=the roll wins over the plan, as
 * CODING_STANDARDS.md "Data layer" (#1257) says: absent is unavailable whatever
 * the plan says, present is coming even after Not coming, excused and no record
 * fall through to the plan; fails_when=a present roll still reads not_coming, an
 * absent roll reads coming, or an excused roll hides the plan answer;
 * no_claim=pure function over two strings; the DB reads that feed it are the
 * integration cases below.
 */
describe("combineAttendance", () => {
	it("unavailable > not_coming > coming > null", () => {
		expect(combineAttendance("absent", "coming")).toBe("unavailable");
		expect(combineAttendance(undefined, "not_coming")).toBe("not_coming");
		expect(combineAttendance("present", "coming")).toBe("coming");
		expect(combineAttendance(undefined, "reached_out")).toBeNull();
		expect(combineAttendance(undefined, undefined)).toBeNull();
	});

	it("a present roll wins over a not_coming plan", () => {
		expect(combineAttendance("present", "not_coming")).toBe("coming");
		expect(combineAttendance("present", undefined)).toBe("coming");
	});

	it("an excused roll falls through to the plan", () => {
		expect(combineAttendance("excused", "not_coming")).toBe("not_coming");
		expect(combineAttendance("excused", "coming")).toBe("coming");
		expect(combineAttendance("excused", undefined)).toBeNull();
	});

	it("an absent roll wins over a coming plan", () => {
		expect(combineAttendance("absent", "coming")).toBe("unavailable");
		expect(combineAttendance("absent", "not_coming")).toBe("unavailable");
	});
});

describe("isoInTimezone", () => {
	it("carries the club's own UTC offset", () => {
		expect(
			isoInTimezone(new Date("2026-01-14T01:00:00Z"), "America/Chicago"),
		).toBe("2026-01-13T19:00:00-06:00");
		expect(
			isoInTimezone(new Date("2026-07-14T01:00:00Z"), "America/Chicago"),
		).toBe("2026-07-13T20:00:00-05:00");
	});
});

describe.skipIf(!hasTestDb)("get_my_schedule (#1281)", () => {
	it("returns the caller's own roles and nobody else's", async () => {
		const s = await club();
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: s.memberId, status: "claimed" })
			.where(eq(roleSlots.id, s.slotId));
		const mine = await call(await tokenFor(s.memberUserId));
		expect(mine.meetings).toHaveLength(1);
		expect(mine.meetings[0]).toMatchObject({
			meetingId: s.meetingId,
			clubId: s.clubId,
			status: "scheduled",
			myRoles: ["Timer"],
			myAttendance: null,
		});
		// The admin holds nothing in this club's roster: same meeting, no roles.
		const theirs = await call(await tokenFor(s.adminUserId));
		expect(theirs.meetings[0]?.myRoles).toEqual([]);
	});

	it("reports the caller's attendance answer, not another member's", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		await testDb
			.insert(meetingAttendancePlan)
			.values([
				{ memberId: s.adminMemberId, meetingId: s.meetingId, status: "coming" },
			]);
		expect((await call(token)).meetings[0]?.myAttendance).toBeNull();

		await testDb.insert(meetingAttendancePlan).values({
			memberId: s.memberId,
			meetingId: s.meetingId,
			status: "not_coming",
		});
		expect((await call(token)).meetings[0]?.myAttendance).toBe("not_coming");

		await testDb
			.update(meetingAttendancePlan)
			.set({ status: "coming" })
			.where(eq(meetingAttendancePlan.memberId, s.memberId));
		expect((await call(token)).meetings[0]?.myAttendance).toBe("coming");

		await testDb.insert(meetingAttendance).values({
			meetingId: s.meetingId,
			memberId: s.memberId,
			status: "absent",
		});
		expect((await call(token)).meetings[0]?.myAttendance).toBe("unavailable");
	});

	it("leaves out cancelled meetings and honours the days window, in start order", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		const add = async (
			offsetDays: number,
			status: "scheduled" | "cancelled",
		) => {
			const [m] = await testDb
				.insert(meetings)
				.values({
					clubId: s.clubId,
					scheduledAt: new Date(Date.now() + offsetDays * DAY),
					status,
				})
				.returning({ id: meetings.id });
			return m?.id as string;
		};
		const soon = await add(2, "scheduled");
		await add(3, "cancelled");
		const far = await add(40, "scheduled");
		await add(-1, "scheduled"); // already started

		const def = await call(token);
		expect(def.meetings.map((m) => m.meetingId)).toEqual([soon, s.meetingId]);
		const wide = await call(token, { days: 60 });
		expect(wide.meetings.map((m) => m.meetingId)).toEqual([
			soon,
			s.meetingId,
			far,
		]);
		await expect(call(token, { days: 0 })).rejects.toThrow();
		await expect(call(token, { days: 91 })).rejects.toThrow();
	});

	it("omits an archived club and a club the caller is not an active member of", async () => {
		const mine = await club();
		const other = await club();
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, other.clubId));
		const token = await tokenFor(mine.memberUserId);
		expect((await call(token)).meetings.map((m) => m.clubId)).toEqual([
			mine.clubId,
		]);
		// The archived club's own member sees nothing at all.
		expect((await call(await tokenFor(other.memberUserId))).meetings).toEqual(
			[],
		);
	});

	it("takes no id input: extra keys are ignored, the subject stays the token's", async () => {
		const a = await club();
		const b = await club();
		const res = await call(await tokenFor(a.memberUserId), {
			memberId: b.memberId,
			clubId: b.clubId,
		});
		expect(res.meetings.map((m) => m.clubId)).toEqual([a.clubId]);
	});

	it("a present roll shows coming over a not_coming plan, and excused falls to the plan", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		await testDb.insert(meetingAttendancePlan).values({
			memberId: s.memberId,
			meetingId: s.meetingId,
			status: "not_coming",
		});
		await testDb.insert(meetingAttendance).values({
			meetingId: s.meetingId,
			memberId: s.memberId,
			status: "present",
		});
		expect((await call(token)).meetings[0]?.myAttendance).toBe("coming");
		await testDb
			.update(meetingAttendance)
			.set({ status: "excused" })
			.where(eq(meetingAttendance.memberId, s.memberId));
		expect((await call(token)).meetings[0]?.myAttendance).toBe("not_coming");
	});

	/**
	 * Card (query count): protects=the read count of get_my_schedule is a
	 * function of the number of CLUBS, never of meetings, so a long window cannot
	 * become an N+1; fails_when=the plan, roll or role read moves inside a
	 * per-meeting loop; no_claim=counts SQL on the pool, not transactions, and
	 * says nothing about how slow any one statement is.
	 */
	it("issues the same number of reads for 1 meeting as for 4", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		const count = async () => {
			const sql = await statementsDuring(() => call(token));
			expect(
				readsOf(sql, "meeting_attendance_plan"),
				"the plan read must be observed",
			).not.toHaveLength(0);
			return sql.length;
		};
		const one = await count();
		for (const d of [2, 3, 4]) {
			await testDb.insert(meetings).values({
				clubId: s.clubId,
				scheduledAt: new Date(Date.now() + d * DAY),
				status: "scheduled",
			});
		}
		expect((await call(token)).meetings).toHaveLength(4);
		expect(await count()).toBe(one);
	});
});
