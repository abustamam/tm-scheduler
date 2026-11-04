/**
 * DB-backed tests for `update_meeting_schedule` (#1514).
 *
 * Time is faked (Date only) to 2027-03-01, in the two weeks before the US
 * spring-forward on 2027-03-14, so a weekly Thursday rule in America/Chicago
 * straddles a DST boundary.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	clubMeetingRecurrence,
	clubs,
	meetings,
	roleSlots,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import { utcToZonedWallTime } from "#/lib/datetime";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { updateMeetingScheduleTool } = await import(
	"#/server/mcp/tools/update-meeting-schedule"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { McpError } = await import("#/server/mcp/errors");
const { saveRecurrenceRule, getRecurrenceRule } = await import(
	"#/server/recurrence-rule-logic"
);
const { ensureScheduleToppedUp } = await import(
	"#/server/schedule-topup-logic"
);

const TZ = "America/Chicago";
const NOW = new Date("2027-03-01T12:00:00Z");

const weeklyThursday = {
	mode: "interval" as const,
	weekday: 4,
	intervalWeeks: 1,
	anchorDate: "2027-01-07",
	ordinals: null,
	timeOfDay: "18:45",
	location: "Main Hall",
	keepAhead: 4,
	enabled: true,
};

interface Result {
	applied: boolean;
	clubId: string;
	summary: string;
	plan: {
		changes: Record<string, { from: unknown; to: unknown }>;
		noop: boolean;
		recreated: {
			meetingId: string;
			date: string;
			time: string;
			newTime: string;
		}[];
		staying: { meetingId: string; date: string; time: string; note: string }[];
		warnings: string[];
		currentScheduleText: string | null;
	};
	planHash?: string;
	created?: number;
}

describe.skipIf(!hasTestDb)("update_meeting_schedule (#1514)", () => {
	let seed: SeededClub;
	let adminToken: string;
	let memberToken: string;

	async function mintToken(userId: string): Promise<string> {
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId, tokenHash: hashApiToken(raw) });
		return raw;
	}

	function call(token: string, input: Record<string, unknown>) {
		return updateMeetingScheduleTool.handler(
			{ clubId: seed.clubId, ...input },
			{ rawToken: token },
		);
	}
	async function preview(input: Record<string, unknown>) {
		return (await call(adminToken, input)) as Result;
	}
	async function apply(input: Record<string, unknown>, hash: string) {
		return (await call(adminToken, { ...input, planHash: hash })) as Result;
	}

	async function future() {
		const rows = await testDb
			.select({
				id: meetings.id,
				scheduledAt: meetings.scheduledAt,
				lengthMinutes: meetings.lengthMinutes,
			})
			.from(meetings)
			.where(
				and(eq(meetings.clubId, seed.clubId), eq(meetings.status, "scheduled")),
			);
		return rows.sort(
			(a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime(),
		);
	}
	const localTime = (d: Date) => utcToZonedWallTime(d, TZ).slice(11, 16);

	async function snapshot() {
		const rule = await getRecurrenceRule(seed.clubId);
		const club = await testDb.query.clubs.findFirst({
			where: eq(clubs.id, seed.clubId),
		});
		return { rule, club, meetings: await future() };
	}

	async function expectMcpError(p: Promise<unknown>, code: string) {
		const err = await p.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(McpError);
		expect((err as InstanceType<typeof McpError>).code).toBe(code);
		return err as InstanceType<typeof McpError>;
	}

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		seed = await seedClub();
		await testDb.delete(meetings).where(eq(meetings.clubId, seed.clubId));
		await testDb
			.update(clubs)
			.set({
				timezone: TZ,
				district: "District 99",
				mission: "Our mission",
				meetingSchedule: "Thursdays, 6:45 PM",
			})
			.where(eq(clubs.id, seed.clubId));
		await saveRecurrenceRule(seed.clubId, weeklyThursday, NOW);
		adminToken = await mintToken(seed.adminUserId);
		memberToken = await mintToken(seed.memberUserId);
	});

	afterEach(async () => {
		vi.useRealTimers();
		await testDb
			.delete(apiTokens)
			.where(inArray(apiTokens.userId, [seed.adminUserId, seed.memberUserId]));
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("a preview writes nothing: rule, club row and meetings are unchanged", async () => {
		const before = await snapshot();
		const r = await preview({
			timeOfDay: "19:30",
			scheduleText: "Thursdays, 7:30 PM",
			defaultMeetingMinutes: 60,
		});
		expect(r.applied).toBe(false);
		expect(r.planHash).toMatch(/^[0-9a-f]{64}$/);
		expect(r.plan.changes.timeOfDay).toEqual({ from: "18:45", to: "19:30" });
		expect(r.plan.changes.defaultMeetingMinutes).toEqual({ from: 90, to: 60 });
		expect(r.plan.recreated).toHaveLength(4);
		expect(await snapshot()).toEqual(before);
	});

	it("a time change recreates untouched future meetings at the new local time across DST", async () => {
		const before = await future();
		expect(before.map((m) => localTime(m.scheduledAt))).toEqual(
			Array(4).fill("18:45"),
		);
		const input = { timeOfDay: "19:30" };
		const p = await preview(input);
		const out = await apply(input, p.planHash as string);
		expect(out.applied).toBe(true);

		const after = await future();
		expect(after).toHaveLength(4);
		expect(after.map((m) => localTime(m.scheduledAt))).toEqual(
			Array(4).fill("19:30"),
		);
		// Same local dates; the UTC hour moved with the DST changeover.
		expect(
			after.map((m) => utcToZonedWallTime(m.scheduledAt, TZ).slice(0, 10)),
		).toEqual(
			before.map((m) => utcToZonedWallTime(m.scheduledAt, TZ).slice(0, 10)),
		);
		const utcHours = new Set(after.map((m) => m.scheduledAt.getUTCHours()));
		expect(utcHours.size).toBe(2);
		expect(before.some((m) => after.some((a) => a.id === m.id))).toBe(false);
		// Only timeOfDay moved in the rule.
		const rule = await getRecurrenceRule(seed.clubId);
		expect(rule).toMatchObject({ ...weeklyThursday, timeOfDay: "19:30" });
	});

	it("a touched meeting keeps its time and is listed as staying; the planned delete set is exactly what the save deleted", async () => {
		const before = await future();
		const touched = before[1];
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: seed.memberId, status: "claimed" })
			.where(eq(roleSlots.meetingId, touched.id));

		const input = { timeOfDay: "19:30" };
		const p = await preview(input);
		expect(p.plan.staying.map((m) => m.meetingId)).toEqual([touched.id]);
		expect(p.plan.staying[0].note).toContain("in the app");
		const planned = p.plan.recreated.map((m) => m.meetingId).sort();
		expect(planned).toEqual(
			before
				.filter((m) => m.id !== touched.id)
				.map((m) => m.id)
				.sort(),
		);

		await apply(input, p.planHash as string);
		const after = await future();
		const survivors = before.filter((m) => after.some((a) => a.id === m.id));
		const deleted = before.filter((m) => !after.some((a) => a.id === m.id));
		expect(survivors.map((m) => m.id)).toEqual([touched.id]);
		expect(deleted.map((m) => m.id).sort()).toEqual(planned);
		const kept = after.find((m) => m.id === touched.id);
		expect(localTime((kept as { scheduledAt: Date }).scheduledAt)).toBe(
			"18:45",
		);
	});

	it("a meeting touched between preview and apply is PLAN_STALE and nothing is deleted", async () => {
		const before = await future();
		const input = { timeOfDay: "19:30" };
		const p = await preview(input);
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: seed.memberId, status: "claimed" })
			.where(eq(roleSlots.meetingId, before[2].id));

		const err = await expectMcpError(
			apply(input, p.planHash as string),
			"PLAN_STALE",
		);
		expect(JSON.stringify(err)).not.toBe("");
		expect((await future()).map((m) => m.id)).toEqual(before.map((m) => m.id));
		expect((await getRecurrenceRule(seed.clubId))?.timeOfDay).toBe("18:45");
	});

	it("scheduleText alone leaves the rule, district and mission unchanged, and warns nothing", async () => {
		const before = await snapshot();
		const input = { scheduleText: "  Thursdays at 6:45 PM  " };
		const p = await preview(input);
		expect(p.plan.warnings).toEqual([]);
		await apply(input, p.planHash as string);
		const after = await snapshot();
		expect(after.club?.meetingSchedule).toBe("Thursdays at 6:45 PM");
		expect(after.club?.district).toBe("District 99");
		expect(after.club?.mission).toBe("Our mission");
		expect(after.rule).toEqual(before.rule);
		expect(after.meetings).toEqual(before.meetings);
	});

	it("scheduleText null clears the line", async () => {
		const input = { scheduleText: null };
		const p = await preview(input);
		await apply(input, p.planHash as string);
		expect((await snapshot()).club?.meetingSchedule).toBeNull();
	});

	it("a time change without scheduleText warns the line may be stale, and does not block", async () => {
		const p = await preview({ timeOfDay: "19:30" });
		expect(p.plan.currentScheduleText).toBe("Thursdays, 6:45 PM");
		expect(p.plan.warnings.join(" ")).toContain("Thursdays, 6:45 PM");
		const withText = await preview({
			timeOfDay: "19:30",
			scheduleText: "Thursdays, 7:30 PM",
		});
		expect(withText.plan.warnings).toEqual([]);
	});

	it("defaultMeetingMinutes alone changes what the next new meeting gets and leaves existing ones", async () => {
		const before = await future();
		const input = { defaultMeetingMinutes: 60 };
		const p = await preview(input);
		await apply(input, p.planHash as string);

		const mid = await future();
		expect(mid.map((m) => [m.id, m.lengthMinutes])).toEqual(
			before.map((m) => [m.id, m.lengthMinutes]),
		);
		await testDb.delete(meetings).where(eq(meetings.id, before[3].id));
		await ensureScheduleToppedUp(seed.clubId, NOW);
		const after = await future();
		expect(after).toHaveLength(4);
		const created = after.find((m) => !before.some((b) => b.id === m.id));
		expect(created?.lengthMinutes).toBe(60);
		expect(after.filter((m) => m.lengthMinutes === 90)).toHaveLength(3);
	});

	it("an input that changes nothing plans a no-op and the apply writes nothing", async () => {
		const before = await snapshot();
		const input = {
			timeOfDay: "18:45",
			scheduleText: "Thursdays, 6:45 PM",
			defaultMeetingMinutes: 90,
		};
		const p = await preview(input);
		expect(p.plan.noop).toBe(true);
		expect(p.summary).toMatch(/Nothing to change/);
		const out = await apply(input, p.planHash as string);
		expect(out.applied).toBe(true);
		expect(await snapshot()).toEqual(before);
	});

	it("refuses a plain member with FORBIDDEN", async () => {
		await expectMcpError(
			call(memberToken, { timeOfDay: "19:30" }),
			"FORBIDDEN",
		);
	});

	it("refuses an archived club with ARCHIVED", async () => {
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));
		const err = await expectMcpError(
			call(adminToken, { timeOfDay: "19:30" }),
			"ARCHIVED",
		);
		expect(err.message).toBe(CLUB_ARCHIVED_MESSAGE);
	});

	it("refuses a time change on a club with no standing rule with VALIDATION", async () => {
		await testDb
			.delete(clubMeetingRecurrence)
			.where(eq(clubMeetingRecurrence.clubId, seed.clubId));
		const err = await expectMcpError(
			call(adminToken, { timeOfDay: "19:30" }),
			"VALIDATION",
		);
		expect(err.message).toContain("meeting schedule in the app first");
		// The other two fields still work without a rule.
		const p = await preview({ defaultMeetingMinutes: 45 });
		expect(p.plan.changes.defaultMeetingMinutes).toEqual({ from: 90, to: 45 });
	});

	it.each([
		["a bad time", { timeOfDay: "25:00" }],
		["a non-time", { timeOfDay: "6pm" }],
		["a zero length", { defaultMeetingMinutes: 0 }],
		["a fractional length", { defaultMeetingMinutes: 60.5 }],
		["an absurd length", { defaultMeetingMinutes: 100000 }],
		["no field at all", {}],
	])("refuses %s with VALIDATION", async (_label, input) => {
		await expectMcpError(call(adminToken, input), "VALIDATION");
	});

	it("a switched-off schedule warns that deleted meetings will not be recreated", async () => {
		await testDb
			.update(clubMeetingRecurrence)
			.set({ enabled: false })
			.where(eq(clubMeetingRecurrence.clubId, seed.clubId));
		const p = await preview({ timeOfDay: "19:30" });
		expect(p.plan.warnings.join(" ")).toContain("switched off");
	});
});
