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
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
// Wrap the seam so a test can see whether it ran, or interleave a write with it.
// With no override it is the real function.
vi.mock("#/server/meetings-logic", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("#/server/meetings-logic")>();
	return {
		...actual,
		applyMeetingMetaPatch: vi.fn(actual.applyMeetingMetaPatch),
	};
});

const {
	MEETING_CANCELLED_MESSAGE,
	MEETING_STARTED_MESSAGE,
	NEW_START_PAST_MESSAGE,
	NO_SUCH_TIME_MESSAGE,
	SLOT_TAKEN_MESSAGE,
	rescheduleMeetingTool,
} = await import("#/server/mcp/tools/reschedule-meeting");
const { applyMeetingMetaPatch } = await import("#/server/meetings-logic");
const { readAgendaSnapshot } = await import(
	"#/server/meeting-agenda-edit-logic"
);
const { agendaRunSheet } = await import("#/lib/agenda-run-sheet");
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
	async function expectMcpError(
		p: Promise<unknown>,
		code: string,
		message?: string,
	) {
		const err = await p.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(McpError);
		expect((err as InstanceType<typeof McpError>).code).toBe(code);
		// Five refusals share VALIDATION: the message says which one fired.
		if (message !== undefined) expect((err as Error).message).toBe(message);
		return err as InstanceType<typeof McpError>;
	}
	/** An apply that must be refused leaves the row and the audit log alone. */
	async function expectApplyRefused(
		input: Record<string, unknown>,
		planHash: string | undefined,
		code: string,
		message: string,
	) {
		const before = await row();
		await expectMcpError(call({ ...input, planHash }), code, message);
		expect(await row()).toEqual(before);
		expect(await edits()).toHaveLength(0);
	}

	beforeEach(async () => {
		vi.restoreAllMocks();
		vi.mocked(applyMeetingMetaPatch).mockClear();
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

	it("refuses a completed meeting with LOCKED, at preview and at apply", async () => {
		const p = await preview({ lengthMinutes: 30 });
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, seed.meetingId));
		await expectMcpError(
			preview({ lengthMinutes: 30 }),
			"LOCKED",
			MEETING_STARTED_MESSAGE,
		);
		await expectApplyRefused(
			{ lengthMinutes: 30 },
			p.planHash,
			"LOCKED",
			MEETING_STARTED_MESSAGE,
		);
	});

	it("refuses a meeting that has already started with LOCKED, at preview and at apply", async () => {
		const p = await preview({ lengthMinutes: 30 });
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date("2027-02-25T00:00:00Z") })
			.where(eq(meetings.id, seed.meetingId));
		await expectMcpError(
			preview({ lengthMinutes: 30 }),
			"LOCKED",
			MEETING_STARTED_MESSAGE,
		);
		await expectApplyRefused(
			{ lengthMinutes: 30 },
			p.planHash,
			"LOCKED",
			MEETING_STARTED_MESSAGE,
		);
	});

	it("refuses a new start in the past with VALIDATION, at preview and at apply", async () => {
		await expectMcpError(
			preview({ date: "2027-02-20" }),
			"VALIDATION",
			NEW_START_PAST_MESSAGE,
		);
		// Valid at preview (2027-03-10 is ahead of NOW); the clock then passes it
		// while the stored start (03-18) is still ahead.
		const p = await preview({ date: "2027-03-10" });
		vi.setSystemTime(new Date("2027-03-12T12:00:00Z"));
		await expectApplyRefused(
			{ date: "2027-03-10" },
			p.planHash,
			"VALIDATION",
			NEW_START_PAST_MESSAGE,
		);
	});

	it("refuses a cancelled meeting with VALIDATION, at preview and at apply", async () => {
		const p = await preview({ lengthMinutes: 30 });
		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, seed.meetingId));
		await expectMcpError(
			preview({ lengthMinutes: 30 }),
			"VALIDATION",
			MEETING_CANCELLED_MESSAGE,
		);
		await expectApplyRefused(
			{ lengthMinutes: 30 },
			p.planHash,
			"VALIDATION",
			MEETING_CANCELLED_MESSAGE,
		);
	});

	it("refuses a slot another meeting holds with VALIDATION, at preview and at apply", async () => {
		const taken = new Date("2027-03-25T23:45:00Z");
		await testDb
			.insert(meetings)
			.values({ clubId: seed.clubId, scheduledAt: taken });
		await expectMcpError(
			preview({ date: "2027-03-25" }),
			"VALIDATION",
			SLOT_TAKEN_MESSAGE,
		);
		// Apply: the slot was free at preview and is taken by the time of the apply.
		const p = await preview({ date: "2027-03-26" });
		await testDb.insert(meetings).values({
			clubId: seed.clubId,
			scheduledAt: new Date("2027-03-26T23:45:00Z"),
		});
		await expectApplyRefused(
			{ date: "2027-03-26" },
			p.planHash,
			"VALIDATION",
			SLOT_TAKEN_MESSAGE,
		);
	});

	it("a slot taken inside the apply (past the plan's own check) is VALIDATION and rolls back", async () => {
		const p = await preview({ date: "2027-03-26" });
		// The clash appears AFTER the plan was built under the lock and BEFORE the
		// UPDATE: the real 23505 from `meetings_club_scheduled_unique`, wrapped by
		// the driver and drizzle, reaches the tool's catch.
		vi.mocked(applyMeetingMetaPatch).mockImplementationOnce(
			async (input, conn) => {
				await (conn ?? testDb).insert(meetings).values({
					clubId: seed.clubId,
					scheduledAt: new Date("2027-03-26T23:45:00Z"),
				});
				const actual = await vi.importActual<
					typeof import("#/server/meetings-logic")
				>("#/server/meetings-logic");
				return actual.applyMeetingMetaPatch(input, conn);
			},
		);
		await expectApplyRefused(
			{ date: "2027-03-26" },
			p.planHash,
			"VALIDATION",
			SLOT_TAKEN_MESSAGE,
		);
		expect(vi.mocked(applyMeetingMetaPatch)).toHaveBeenCalledTimes(1);
		// The whole transaction rolled back, the clash row included.
		const same = await testDb
			.select({ id: meetings.id })
			.from(meetings)
			.where(
				and(
					eq(meetings.clubId, seed.clubId),
					eq(meetings.scheduledAt, new Date("2027-03-26T23:45:00Z")),
				),
			);
		expect(same).toHaveLength(0);
	});

	it("refuses a time the clocks skip with VALIDATION, at preview and at apply", async () => {
		await expectMcpError(
			preview({ date: "2027-03-14", startTime: "02:30" }),
			"VALIDATION",
			NO_SUCH_TIME_MESSAGE,
		);
		// 02:30 on 03-14 exists in UTC, so the preview is clean; the club's zone
		// then changes to Chicago, where the clocks skip it.
		await testDb
			.update(clubs)
			.set({ timezone: "UTC" })
			.where(eq(clubs.id, seed.clubId));
		const p = await preview({ date: "2027-03-14", startTime: "02:30" });
		await testDb
			.update(clubs)
			.set({ timezone: TZ })
			.where(eq(clubs.id, seed.clubId));
		await expectApplyRefused(
			{ date: "2027-03-14", startTime: "02:30" },
			p.planHash,
			"VALIDATION",
			NO_SUCH_TIME_MESSAGE,
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

	it("an officer token for another club cannot preview or apply here", async () => {
		const other = await seedClub();
		try {
			const otherToken = await mintToken(other.adminUserId);
			const p = await preview({ lengthMinutes: 30 });
			const before = await row();
			for (const planHash of [undefined, p.planHash]) {
				const err = await expectMcpError(
					call({ lengthMinutes: 30, planHash }, otherToken),
					"FORBIDDEN",
				);
				// Nothing about the meeting comes back with the refusal.
				expect(JSON.stringify(err)).not.toContain(seed.meetingId);
				expect(err.detail).toBeUndefined();
			}
			expect(await row()).toEqual(before);
			expect(await edits()).toHaveLength(0);
		} finally {
			await testDb
				.delete(apiTokens)
				.where(eq(apiTokens.userId, other.adminUserId));
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("a stale hash is PLAN_STALE with the fresh plan and writes nothing", async () => {
		const p = await preview({ startTime: "19:30" });
		expect(p.plan.lengthMinutes.to).toBe(90);
		await testDb
			.update(meetings)
			.set({ lengthMinutes: 75 })
			.where(eq(meetings.id, seed.meetingId));
		const err = await expectMcpError(
			call({ startTime: "19:30", planHash: p.planHash }),
			"PLAN_STALE",
		);
		const fresh = err.detail as {
			plan: Result["plan"];
			planHash: string;
		};
		expect(fresh.plan.lengthMinutes).toEqual({ from: 75, to: 75 });
		expect(fresh.plan.end.to).toBe("2027-03-18T20:45:00-05:00");
		expect(fresh.planHash).not.toBe(p.planHash);
		expect((await row()).scheduledAt).toEqual(MEETING_AT);
		expect((await row()).lengthMinutes).toBe(75);
		expect(await edits()).toHaveLength(0);
	});

	/** Run `change` after the tool has authorized the call and before its apply
	 *  transaction opens: the window the in-transaction club read exists for. */
	function beforeApplyTransaction(change: () => Promise<unknown>) {
		const real = testDb.transaction.bind(testDb);
		vi.spyOn(testDb, "transaction").mockImplementationOnce(
			// biome-ignore lint/suspicious/noExplicitAny: forwards the driver's own overloads untouched
			(async (...args: any[]) => {
				await change();
				return (real as (...a: unknown[]) => unknown)(...args);
			}) as typeof testDb.transaction,
		);
	}

	it("a club timezone change after authorization is PLAN_STALE, not a different instant", async () => {
		const p = await preview({ startTime: "19:30" });
		beforeApplyTransaction(() =>
			testDb
				.update(clubs)
				.set({ timezone: "America/Los_Angeles" })
				.where(eq(clubs.id, seed.clubId)),
		);
		const err = await expectMcpError(
			call({ startTime: "19:30", planHash: p.planHash }),
			"PLAN_STALE",
		);
		expect((err.detail as { plan: { timezone: string } }).plan.timezone).toBe(
			"America/Los_Angeles",
		);
		expect((await row()).scheduledAt).toEqual(MEETING_AT);
		expect(await edits()).toHaveLength(0);
	});

	it("a club archived after authorization is ARCHIVED and writes nothing", async () => {
		const p = await preview({ startTime: "19:30" });
		beforeApplyTransaction(() =>
			testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, seed.clubId)),
		);
		await expectApplyRefused(
			{ startTime: "19:30" },
			p.planHash,
			"ARCHIVED",
			CLUB_ARCHIVED_MESSAGE,
		);
	});

	it("a no-op plan says so and applying it never reaches the seam", async () => {
		const r = await apply({ startTime: "18:45", lengthMinutes: 90 });
		expect(r.applied).toBe(true);
		expect(r.plan.noop).toBe(true);
		expect(vi.mocked(applyMeetingMetaPatch)).not.toHaveBeenCalled();
		expect(await edits()).toHaveLength(0);
		expect((await row()).scheduledAt).toEqual(MEETING_AT);
	});

	it("compares at the seam's minute granularity: a stored start with seconds", async () => {
		const withSeconds = new Date("2027-03-18T23:45:30Z");
		await testDb
			.update(meetings)
			.set({ scheduledAt: withSeconds })
			.where(eq(meetings.id, seed.meetingId));
		// Same minute: no change, nothing written, the stored seconds untouched.
		const same = await apply({ startTime: "18:45" });
		expect(same.plan.noop).toBe(true);
		expect(vi.mocked(applyMeetingMetaPatch)).not.toHaveBeenCalled();
		expect((await row()).scheduledAt).toEqual(withSeconds);
		expect(await edits()).toHaveLength(0);
		// A different minute: written at :00, and the plan's `to` is exactly that.
		const moved = await apply({ startTime: "18:46" });
		expect(moved.plan.noop).toBe(false);
		expect(moved.plan.start.to).toBe("2027-03-18T18:46:00-05:00");
		expect((await row()).scheduledAt.toISOString()).toBe(
			"2027-03-18T23:46:00.000Z",
		);
		expect(await edits()).toHaveLength(1);
	});

	it("a time-only move on the spring-forward day crosses 02:00 and keeps the local date", async () => {
		// Sun 2027-03-14 01:30 CST (07:30Z), 30 minutes before the clocks skip 02:00.
		// Moving only the time to 03:30 lands after the change (CDT, -05:00).
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date("2027-03-14T07:30:00Z") })
			.where(eq(meetings.id, seed.meetingId));
		const r = await apply({ startTime: "03:30" });
		expect(r.plan.date).toEqual({ from: "2027-03-14", to: "2027-03-14" });
		expect(r.plan.start).toEqual({
			from: "2027-03-14T01:30:00-06:00",
			to: "2027-03-14T03:30:00-05:00",
		});
		// 03:30 CDT is 08:30Z, one real hour after 01:30 CST despite two wall hours.
		expect((await row()).scheduledAt.toISOString()).toBe(
			"2027-03-14T08:30:00.000Z",
		);
	});

	it("warns when the run sheet overruns the new end time, and still applies", async () => {
		// Pin the fixture instead of trusting the seed: the agenda this meeting
		// carries must overrun 20 minutes and fit 90, by the same pure function the
		// tool uses, and the warning must name that exact overrun.
		const snap = await readAgendaSnapshot(seed.meetingId);
		expect(snap).not.toBeNull();
		if (!snap) return;
		const at = (lengthMinutes: number) =>
			agendaRunSheet({
				...snap,
				scheduledAt: MEETING_AT.toISOString(),
				lengthMinutes,
			});
		const over = at(20).overByMinutes;
		expect(over).toBeGreaterThan(0);
		expect(at(90).overByMinutes).toBeLessThanOrEqual(0);
		const fits = await preview({ lengthMinutes: 90 });
		expect(fits.plan.warnings).toEqual([]);
		const p = await preview({ lengthMinutes: 20 });
		expect(p.plan.warnings).toHaveLength(1);
		expect(p.plan.warnings[0]).toContain(
			`ends ${over} minute${over === 1 ? "" : "s"} after the new end time`,
		);
		await call({ lengthMinutes: 20, planHash: p.planHash });
		expect((await row()).lengthMinutes).toBe(20);
	});
});
