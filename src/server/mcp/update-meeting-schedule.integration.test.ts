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
	guestInvites,
	guests,
	meetingGuestRsvps,
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
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
// Pass-through, so one test can make the top-up throw AFTER the club columns
// were written and see the transaction roll them back.
vi.mock("#/server/schedule-topup-logic", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("#/server/schedule-topup-logic")>();
	return {
		...actual,
		ensureScheduleToppedUp: vi.fn(actual.ensureScheduleToppedUp),
	};
});

vi.mock("#/server/recurrence-rule-logic", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("#/server/recurrence-rule-logic")>();
	return {
		...actual,
		selectOldPatternMeetings: vi.fn(actual.selectOldPatternMeetings),
	};
});

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
const recurrenceLogic = await import("#/server/recurrence-rule-logic");

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
		removedWithoutReplacement: {
			meetingId: string;
			date: string;
			time: string;
		}[];
		created: { date: string; time: string }[];
		lengthForNewMeetings: number;
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
		const detail = err.detail as { plan: Result["plan"]; planHash: string };
		expect(detail.planHash).toMatch(/^[0-9a-f]{64}$/);
		expect(detail.planHash).not.toBe(p.planHash);
		// The fresh plan names the newly touched meeting as staying.
		expect(detail.plan.staying.map((m) => m.meetingId)).toEqual([before[2].id]);
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

	it("refuses a time change while the schedule is switched off, and writes nothing", async () => {
		await testDb
			.update(clubMeetingRecurrence)
			.set({ enabled: false })
			.where(eq(clubMeetingRecurrence.clubId, seed.clubId));
		const before = await snapshot();
		const err = await expectMcpError(
			call(adminToken, { timeOfDay: "19:30" }),
			"VALIDATION",
		);
		expect(err.message).toBe(
			"This club's standing meeting schedule is switched off, so a new time would delete meetings and create none. Switch the schedule on in the app first, then change the time.",
		);
		expect(await snapshot()).toEqual(before);
		// The other fields do not need the schedule on.
		const p = await preview({ defaultMeetingMinutes: 45 });
		expect(p.plan.changes.defaultMeetingMinutes).toEqual({ from: 90, to: 45 });
	});

	it("a member sending invalid input gets FORBIDDEN, not the bounds", async () => {
		await expectMcpError(
			call(memberToken, { defaultMeetingMinutes: 100000 }),
			"FORBIDDEN",
		);
		await expectMcpError(call(memberToken, {}), "FORBIDDEN");
		await expectMcpError(
			call(memberToken, { scheduleText: "x".repeat(201) }),
			"FORBIDDEN",
		);
		// An officer still sees the bound.
		await expectMcpError(
			call(adminToken, { defaultMeetingMinutes: 1441 }),
			"VALIDATION",
		);
		// The edge itself is accepted.
		const ok = await preview({ defaultMeetingMinutes: 1440 });
		expect(ok.plan.changes.defaultMeetingMinutes).toEqual({
			from: 90,
			to: 1440,
		});
		const text = await preview({ scheduleText: "x".repeat(200) });
		expect(text.plan.changes.scheduleText?.to).toHaveLength(200);
		await expectMcpError(
			call(adminToken, { scheduleText: "x".repeat(201) }),
			"VALIDATION",
		);
	});

	it("a guest RSVP or invite keeps its meeting: listed as staying, not deleted", async () => {
		const before = await future();
		const [g] = await testDb
			.insert(guests)
			.values(
				await withGuestPerson({ clubId: seed.clubId, name: "Visiting Vi" }),
			)
			.returning({ id: guests.id });
		const guestId = (g as { id: string }).id;
		await testDb.insert(meetingGuestRsvps).values({
			clubId: seed.clubId,
			meetingId: before[0].id,
			guestId,
			clientKey: randomUUID(),
		});
		await testDb.insert(guestInvites).values({
			clubId: seed.clubId,
			meetingId: before[1].id,
			guestId,
		});

		const input = { timeOfDay: "19:30" };
		const p = await preview(input);
		expect(p.plan.staying.map((m) => m.meetingId).sort()).toEqual(
			[before[0].id, before[1].id].sort(),
		);
		expect(p.plan.recreated).toHaveLength(2);
		await apply(input, p.planHash as string);
		const after = (await future()).map((m) => m.id);
		expect(after).toContain(before[0].id);
		expect(after).toContain(before[1].id);
		expect(
			await testDb
				.select()
				.from(meetingGuestRsvps)
				.where(eq(meetingGuestRsvps.meetingId, before[0].id)),
		).toHaveLength(1);
		expect(
			await testDb
				.select()
				.from(guestInvites)
				.where(eq(guestInvites.meetingId, before[1].id)),
		).toHaveLength(1);
	});

	it.each([
		["location", { location: "Zoom room" }],
		["length", { lengthMinutes: 45 }],
		["join link", { joinUrl: "https://example.com/join" }],
		["meeting number", { meetingNumber: 77 }],
	])("a per-meeting %s override is listed as staying, not deleted", async (_l, patch) => {
		const before = await future();
		await testDb
			.update(meetings)
			.set(patch)
			.where(eq(meetings.id, before[2].id));
		const input = { timeOfDay: "19:30" };
		const p = await preview(input);
		expect(p.plan.staying.map((m) => m.meetingId)).toEqual([before[2].id]);
		expect(p.plan.recreated.map((m) => m.meetingId)).not.toContain(
			before[2].id,
		);
		await apply(input, p.planHash as string);
		expect((await future()).map((m) => m.id)).toContain(before[2].id);
	});

	it("after the club default length changes, a time change keeps those meetings with their own note", async () => {
		await apply(
			{ defaultMeetingMinutes: 60 },
			(await preview({ defaultMeetingMinutes: 60 })).planHash as string,
		);
		const before = await future();
		const p = await preview({ timeOfDay: "19:30" });
		expect(p.plan.recreated).toHaveLength(0);
		expect(p.plan.staying).toHaveLength(before.length);
		for (const m of p.plan.staying) {
			expect(m.note).toContain("default length, venue or video-call link");
			expect(m.note).toContain("stays at its old time");
			expect(m.note).not.toContain("Someone has touched");
		}
		await apply({ timeOfDay: "19:30" }, p.planHash as string);
		const after = await future();
		expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));
		expect(after.every((m) => localTime(m.scheduledAt) === "18:45")).toBe(true);
	});

	it("after the default length changes, a genuinely touched meeting still says touched", async () => {
		await apply(
			{ defaultMeetingMinutes: 60 },
			(await preview({ defaultMeetingMinutes: 60 })).planHash as string,
		);
		const before = await future();
		await testDb
			.update(meetings)
			.set({ theme: "Space" })
			.where(eq(meetings.id, before[0].id));
		const p = await preview({ timeOfDay: "19:30" });
		const line = p.plan.staying.find((m) => m.meetingId === before[0].id);
		expect(line?.note).toContain("Someone has touched");
	});

	it("a planned delete set that differs from what the save deletes rolls everything back and is PLAN_STALE with a fresh plan", async () => {
		const before = await snapshot();
		const input = { timeOfDay: "19:30", defaultMeetingMinutes: 60 };
		const selection = vi.mocked(recurrenceLogic.selectOldPatternMeetings);
		const real = selection.getMockImplementation() as NonNullable<
			ReturnType<typeof selection.getMockImplementation>
		>;
		// The plan (preview and the apply's re-plan, both through the tool's own
		// call) sees one meeting fewer than the save's internal selection does, so
		// the hash matches and only the DRIFT check can catch it.
		selection.mockImplementation(async (...args) => {
			const r = await real(...args);
			return { ...r, deleted: r.deleted.slice(1) };
		});
		try {
			const p = await preview(input);
			expect(p.plan.recreated).toHaveLength(3);
			const err = await expectMcpError(
				apply(input, p.planHash as string),
				"PLAN_STALE",
			);
			const detail = err.detail as {
				plan: Result["plan"];
				planHash: string;
			};
			expect(detail.plan.recreated).toHaveLength(3);
			expect(detail.planHash).toMatch(/^[0-9a-f]{64}$/);
		} finally {
			selection.mockImplementation(real);
		}
		// Rolled back: rule, club columns (length too) and every meeting.
		expect(await snapshot()).toEqual(before);
	});

	it.each([
		["a 1440-minute length", { defaultMeetingMinutes: 1440 }, true],
		["a 1441-minute length", { defaultMeetingMinutes: 1441 }, false],
		["a 200-character line", { scheduleText: "x".repeat(200) }, true],
		["a 201-character line", { scheduleText: "x".repeat(201) }, false],
	])("the tool schema takes %s: %s", async (_l, input, ok) => {
		if (ok) {
			expect((await preview(input)).applied).toBe(false);
		} else {
			await expectMcpError(call(adminToken, input), "VALIDATION");
		}
	});

	it("a failure after the club columns are written rolls everything back", async () => {
		const before = await snapshot();
		vi.mocked(ensureScheduleToppedUp).mockRejectedValueOnce(
			new Error("boom after the club write"),
		);
		const input = {
			timeOfDay: "19:30",
			scheduleText: "Thursdays, 7:30 PM",
			defaultMeetingMinutes: 60,
		};
		const p = await preview(input);
		await expect(apply(input, p.planHash as string)).rejects.toThrow(
			"boom after the club write",
		);
		const after = await snapshot();
		expect(after.club?.meetingSchedule).toBe("Thursdays, 6:45 PM");
		expect(after.club?.defaultMeetingMinutes).toBe(90);
		expect(after).toEqual(before);
	});

	it("today's meeting moved to a time that has passed by apply is PLAN_STALE, and nothing is deleted", async () => {
		// Thursday 2027-03-04, 17:55 Chicago (CST, UTC-6).
		vi.setSystemTime(new Date("2027-03-04T23:55:00Z"));
		const before = await future();
		const today = before.find(
			(m) =>
				utcToZonedWallTime(m.scheduledAt, TZ).slice(0, 10) === "2027-03-04",
		);
		expect(today).toBeDefined();
		const input = { timeOfDay: "18:00" };
		const p = await preview(input);
		expect(p.plan.recreated.map((m) => m.date)).toContain("2027-03-04");
		expect(p.plan.created.map((c) => c.date)).toContain("2027-03-04");

		// 18:05: the 18:00 slot has gone; today's old 18:45 meeting still exists.
		vi.setSystemTime(new Date("2027-03-05T00:05:00Z"));
		const err = await expectMcpError(
			apply(input, p.planHash as string),
			"PLAN_STALE",
		);
		const detail = err.detail as { plan: Result["plan"] };
		expect(detail.plan.created.map((c) => c.date)).not.toContain("2027-03-04");
		expect(detail.plan.removedWithoutReplacement.map((m) => m.date)).toEqual([
			"2027-03-04",
		]);
		expect((await future()).map((m) => m.id)).toEqual(before.map((m) => m.id));
		expect((await getRecurrenceRule(seed.clubId))?.timeOfDay).toBe("18:45");
	});

	it("a default length changed between preview and apply is PLAN_STALE, even for a time-only preview", async () => {
		const input = { timeOfDay: "19:30" };
		const p = await preview(input);
		expect(p.plan.lengthForNewMeetings).toBe(90);
		await testDb
			.update(clubs)
			.set({ defaultMeetingMinutes: 60 })
			.where(eq(clubs.id, seed.clubId));
		const err = await expectMcpError(
			apply(input, p.planHash as string),
			"PLAN_STALE",
		);
		const detail = err.detail as { plan: Result["plan"] };
		expect(detail.plan.lengthForNewMeetings).toBe(60);
	});

	it("a time change and a new default length together: recreated meetings get the new length", async () => {
		const input = { timeOfDay: "19:30", defaultMeetingMinutes: 60 };
		const p = await preview(input);
		expect(p.plan.lengthForNewMeetings).toBe(60);
		await apply(input, p.planHash as string);
		const after = await future();
		expect(after).toHaveLength(4);
		expect(after.map((m) => m.lengthMinutes)).toEqual([60, 60, 60, 60]);
		expect(after.map((m) => localTime(m.scheduledAt))).toEqual(
			Array(4).fill("19:30"),
		);
	});

	it("an apply returns the created count; the summary is singular for one meeting and plural for several", async () => {
		const plural = await preview({ timeOfDay: "19:30" });
		expect(plural.summary).toContain("4 meetings recreated");
		const out = await apply({ timeOfDay: "19:30" }, plural.planHash as string);
		expect(out.created).toBe(4);

		// Touch three of the four, so exactly one is recreated.
		const now = await future();
		for (const m of now.slice(0, 3)) {
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: seed.memberId, status: "claimed" })
				.where(eq(roleSlots.meetingId, m.id));
		}
		const one = await preview({ timeOfDay: "20:15" });
		expect(one.summary).toContain("1 meeting recreated");
		expect(one.summary).not.toContain("1 meetings");
		const out2 = await apply({ timeOfDay: "20:15" }, one.planHash as string);
		expect(out2.created).toBe(1);
	});

	it("warns that no schedule line is set when there is none to go stale", async () => {
		await testDb
			.update(clubs)
			.set({ meetingSchedule: null })
			.where(eq(clubs.id, seed.clubId));
		const p = await preview({ timeOfDay: "19:30" });
		expect(p.plan.warnings).toEqual([
			"No schedule line is set for guests, so nothing there can be out of date.",
		]);
	});

	async function moveUntouchedOntoNextRuleDate() {
		const before = await future();
		const [moved, displaced] = before;
		const originalDate = utcToZonedWallTime(moved.scheduledAt, TZ).slice(0, 10);
		// The officer's move lands on a rule date; the meeting already there is gone.
		await testDb.delete(meetings).where(eq(meetings.id, displaced.id));
		const movedTo = new Date(moved.scheduledAt.getTime() + 7 * 86_400_000);
		await testDb
			.update(meetings)
			.set({ scheduledAt: movedTo, slotDate: originalDate })
			.where(eq(meetings.id, moved.id));
		return { moved, movedTo, originalDate };
	}

	it("an untouched meeting an officer moved onto another rule date survives a time change from update_meeting_schedule (#1521)", async () => {
		const { moved, movedTo, originalDate } =
			await moveUntouchedOntoNextRuleDate();
		const input = { timeOfDay: "19:30" };
		const p = await preview(input);
		expect(p.plan.recreated.map((m) => m.meetingId)).not.toContain(moved.id);
		expect(p.plan.staying.map((m) => m.meetingId)).toContain(moved.id);

		const out = await apply(input, p.planHash as string);
		expect(out.applied).toBe(true);
		const after = await future();
		const survivor = after.find((m) => m.id === moved.id);
		expect(survivor?.scheduledAt.getTime()).toBe(movedTo.getTime());
		const dates = after.map((m) =>
			utcToZonedWallTime(m.scheduledAt, TZ).slice(0, 10),
		);
		expect(dates).not.toContain(originalDate);
		expect(dates).toHaveLength(new Set(dates).size);
	});

	it("the same moved meeting survives a time change saved from the web (#1521)", async () => {
		const { moved, movedTo, originalDate } =
			await moveUntouchedOntoNextRuleDate();
		await saveRecurrenceRule(
			seed.clubId,
			{ ...weeklyThursday, timeOfDay: "19:30" },
			NOW,
		);
		const after = await future();
		expect(after.find((m) => m.id === moved.id)?.scheduledAt.getTime()).toBe(
			movedTo.getTime(),
		);
		expect(
			after.map((m) => utcToZonedWallTime(m.scheduledAt, TZ).slice(0, 10)),
		).not.toContain(originalDate);
	});

	it("preview and apply agree for a club holding a moved meeting, and its slot date stays reserved (#1521)", async () => {
		const before = await future();
		const moved = before[0];
		const slotDate = utcToZonedWallTime(moved.scheduledAt, TZ).slice(0, 10);
		await testDb
			.update(meetings)
			.set({
				scheduledAt: new Date(moved.scheduledAt.getTime() + 2 * 86_400_000),
				slotDate,
			})
			.where(eq(meetings.id, moved.id));
		// Touched, so the time change leaves it alone.
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: seed.memberId, status: "claimed" })
			.where(eq(roleSlots.meetingId, moved.id));

		const input = { timeOfDay: "19:30" };
		const p = await preview(input);
		// `created` is every meeting the apply will leave in place of the deleted ones.
		const plannedDates = p.plan.created.map((m) => m.date);
		expect(plannedDates).not.toContain(slotDate);
		expect(p.plan.recreated.map((m) => m.date)).not.toContain(slotDate);

		const out = await apply(input, p.planHash as string);
		expect(out.applied).toBe(true);
		const after = await future();
		const afterDates = after.map((m) =>
			utcToZonedWallTime(m.scheduledAt, TZ).slice(0, 10),
		);
		expect(afterDates).not.toContain(slotDate);
		expect(afterDates).toHaveLength(new Set(afterDates).size);
		// Every date the apply produced was in the preview, plus the staying one.
		const stayingDate = utcToZonedWallTime(
			(after.find((m) => m.id === moved.id) as { scheduledAt: Date })
				.scheduledAt,
			TZ,
		).slice(0, 10);
		expect([...afterDates].sort()).toEqual(
			[...plannedDates, stayingDate].sort(),
		);
	});
});
