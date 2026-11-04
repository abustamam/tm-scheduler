/**
 * DB-backed tests for `reschedule_meeting` and the new `lengthMinutes` /
 * `endsAt` read fields (#1513).
 *
 * Run with:
 *   bunx vitest run src/server/mcp/reschedule-meeting.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, apiTokens, clubs, meetings } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { rescheduleMeetingTool } = await import(
	"#/server/mcp/tools/reschedule-meeting"
);
const { getAgendaTool } = await import("#/server/mcp/tools/get-agenda");
const { listMeetingsTool } = await import("#/server/mcp/tools/list-meetings");
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { McpError } = await import("#/server/mcp/errors");

const TZ = "America/Chicago";
const NOW = new Date("2027-03-01T12:00:00Z");
// 2027-03-14 is the spring-forward day in Chicago.
const MEETING_AT = new Date("2027-03-18T23:45:00Z"); // Thu 18:45 CDT

interface Result {
	applied: boolean;
	meetingId: string;
	planHash?: string;
	plan: {
		noop: boolean;
		start: { from: string; to: string };
		end: { from: string; to: string };
		date: { from: string; to: string };
		lengthMinutes: { from: number; to: number };
		warnings: string[];
	};
}

describe.skipIf(!hasTestDb)("reschedule_meeting (#1513)", () => {
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
	function call(
		input: Record<string, unknown>,
		token = adminToken,
		meetingId = seed.meetingId,
	) {
		return rescheduleMeetingTool.handler(
			{ meetingId, ...input },
			{ rawToken: token },
		);
	}
	async function preview(input: Record<string, unknown>) {
		return (await call(input)) as Result;
	}
	async function apply(input: Record<string, unknown>) {
		const p = await preview(input);
		return (await call({ ...input, planHash: p.planHash })) as Result;
	}
	async function row(id = seed.meetingId) {
		const [r] = await testDb.select().from(meetings).where(eq(meetings.id, id));
		return r as NonNullable<typeof r>;
	}
	async function edits() {
		return testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.action, "meeting_edit"),
				),
			);
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
		await testDb
			.update(clubs)
			.set({ timezone: TZ })
			.where(eq(clubs.id, seed.clubId));
		await testDb
			.update(meetings)
			.set({ scheduledAt: MEETING_AT, lengthMinutes: 90, status: "scheduled" })
			.where(eq(meetings.id, seed.meetingId));
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

	it("a preview shows old and new in club time and writes nothing", async () => {
		const before = await row();
		const r = await preview({ startTime: "19:30", lengthMinutes: 60 });
		expect(r.applied).toBe(false);
		expect(r.plan.start).toEqual({
			from: "2027-03-18T18:45:00-05:00",
			to: "2027-03-18T19:30:00-05:00",
		});
		expect(r.plan.end).toEqual({
			from: "2027-03-18T20:15:00-05:00",
			to: "2027-03-18T20:30:00-05:00",
		});
		expect(r.plan.date).toEqual({ from: "2027-03-18", to: "2027-03-18" });
		expect(await row()).toEqual(before);
		expect(await edits()).toHaveLength(0);
	});

	it("an apply with the hash writes the changed columns and exactly one meeting_edit", async () => {
		const r = await apply({ startTime: "19:30", lengthMinutes: 60 });
		expect(r.applied).toBe(true);
		const after = await row();
		expect(after.scheduledAt.toISOString()).toBe("2027-03-19T00:30:00.000Z");
		expect(after.lengthMinutes).toBe(60);
		const log = await edits();
		expect(log).toHaveLength(1);
		const detail = log[0]?.detail as {
			before: Record<string, unknown>;
			after: Record<string, unknown>;
		};
		expect(Object.keys(detail.after).sort()).toEqual([
			"lengthMinutes",
			"scheduledAt",
		]);
		expect(Object.keys(detail.before).sort()).toEqual([
			"lengthMinutes",
			"scheduledAt",
		]);
	});

	it("a length-only change leaves scheduled_at alone and names only length", async () => {
		await apply({ lengthMinutes: 45 });
		expect((await row()).scheduledAt).toEqual(MEETING_AT);
		const log = await edits();
		expect(Object.keys((log[0]?.detail as { after: object }).after)).toEqual([
			"lengthMinutes",
		]);
	});

	it("changing only startTime keeps the club-local date across a DST boundary", async () => {
		// Sun 2027-03-14 20:00 CDT, the day the clocks sprang forward at 02:00.
		const dst = new Date("2027-03-15T01:00:00Z");
		await testDb
			.update(meetings)
			.set({ scheduledAt: dst })
			.where(eq(meetings.id, seed.meetingId));
		const r = await apply({ startTime: "19:00" });
		expect(r.plan.date).toEqual({ from: "2027-03-14", to: "2027-03-14" });
		expect((await row()).scheduledAt.toISOString()).toBe(
			"2027-03-15T00:00:00.000Z",
		);
	});

	it("a date change keeps the local time across DST and get_agenda reads it", async () => {
		// Thursday 18:45 CDT moved back to Friday 2027-03-12, still CST (-06:00).
		const r = await apply({ date: "2027-03-12" });
		expect(r.plan.start.to).toBe("2027-03-12T18:45:00-06:00");
		const agenda = (await getAgendaTool.handler(
			{ meetingId: seed.meetingId },
			{ rawToken: adminToken },
		)) as { date: string; time: string; lengthMinutes: number; endsAt: string };
		expect(agenda.date).toBe("2027-03-12");
		expect(agenda.time).toBe("18:45");
		expect(agenda.lengthMinutes).toBe(90);
		expect(agenda.endsAt).toBe("2027-03-12T20:15:00-06:00");
	});

	it("list_meetings returns lengthMinutes and endsAt beside the old fields", async () => {
		const out = (await listMeetingsTool.handler(
			{ clubId: seed.clubId, from: "2027-03-18", to: "2027-03-18" },
			{ rawToken: adminToken },
		)) as { meetings: Record<string, unknown>[] };
		const m = out.meetings.find((x) => x.meetingId === seed.meetingId);
		expect(m).toMatchObject({
			date: "2027-03-18",
			time: "18:45",
			lengthMinutes: 90,
			endsAt: "2027-03-18T20:15:00-05:00",
		});
		expect(m).toHaveProperty("status");
		expect(m).toHaveProperty("openSlots");
	});

	it("refuses a completed meeting with LOCKED", async () => {
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, seed.meetingId));
		await expectMcpError(preview({ lengthMinutes: 30 }), "LOCKED");
	});

	it("refuses a meeting that has already started with LOCKED", async () => {
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date("2027-02-25T00:00:00Z") })
			.where(eq(meetings.id, seed.meetingId));
		await expectMcpError(preview({ lengthMinutes: 30 }), "LOCKED");
	});

	it("refuses a new start in the past with VALIDATION", async () => {
		await expectMcpError(preview({ date: "2027-02-20" }), "VALIDATION");
	});

	it("refuses a cancelled meeting with VALIDATION", async () => {
		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, seed.meetingId));
		await expectMcpError(preview({ lengthMinutes: 30 }), "VALIDATION");
	});

	it("refuses a slot another meeting holds with VALIDATION, at preview and apply", async () => {
		const taken = new Date("2027-03-25T23:45:00Z");
		await testDb
			.insert(meetings)
			.values({ clubId: seed.clubId, scheduledAt: taken });
		await expectMcpError(preview({ date: "2027-03-25" }), "VALIDATION");
		await expectMcpError(
			call({ date: "2027-03-25", planHash: "anything" }),
			"VALIDATION",
		);
	});

	it("refuses a time the clocks skip with VALIDATION", async () => {
		await expectMcpError(
			preview({ date: "2027-03-14", startTime: "02:30" }),
			"VALIDATION",
		);
	});

	it("refuses no field and a malformed time with VALIDATION", async () => {
		await expectMcpError(preview({}), "VALIDATION");
		await expectMcpError(preview({ startTime: "7pm" }), "VALIDATION");
	});

	it("refuses a plain member with FORBIDDEN, even with bad input", async () => {
		await expectMcpError(
			call({ startTime: "19:30" }, memberToken),
			"FORBIDDEN",
		);
		await expectMcpError(call({ startTime: "nope" }, memberToken), "FORBIDDEN");
	});

	it("a stale hash is PLAN_STALE with a fresh plan and writes nothing", async () => {
		const p = await preview({ startTime: "19:30" });
		await testDb
			.update(meetings)
			.set({ lengthMinutes: 75 })
			.where(eq(meetings.id, seed.meetingId));
		const err = await expectMcpError(
			call({ startTime: "19:30", planHash: p.planHash }),
			"PLAN_STALE",
		);
		expect(JSON.stringify(err)).toContain("planHash");
		expect((await row()).scheduledAt).toEqual(MEETING_AT);
		expect(await edits()).toHaveLength(0);
	});

	it("a no-op plan says so and applying it writes nothing", async () => {
		const r = await apply({ startTime: "18:45", lengthMinutes: 90 });
		expect(r.applied).toBe(true);
		expect(r.plan.noop).toBe(true);
		expect(await edits()).toHaveLength(0);
		expect((await row()).scheduledAt).toEqual(MEETING_AT);
	});

	it("warns when the run sheet overruns the new end time, and still applies", async () => {
		const p = await preview({ lengthMinutes: 20 });
		expect(p.plan.warnings.join(" ")).toMatch(/after the new end time/);
		await call({ lengthMinutes: 20, planHash: p.planHash });
		expect((await row()).lengthMinutes).toBe(20);
	});
});
