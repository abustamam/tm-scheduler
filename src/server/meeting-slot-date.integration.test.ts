/**
 * #1521: `meetings.slot_date` keeps the date a meeting was created on reserved,
 * so the schedule top-up does not recreate a meeting on a date an officer moved
 * one away from.
 */
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubMeetingRecurrence, meetings } from "#/db/schema";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";
import { planTopUpInstants } from "#/server/schedule-topup-logic";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { ensureScheduleToppedUp } = await import("./schedule-topup-logic");
const { applyMeetingMetaPatch, applyCreateMeeting } = await import(
	"./meetings-logic"
);
const { applyBatchCreateMeetings } = await import("./batch-meetings-logic");

const TZ = "America/Chicago";
const NOW = new Date("2026-06-01T12:00:00Z");
const local = (d: Date) => utcToZonedWallTime(d, TZ).slice(0, 10);

const RULE = {
	mode: "interval" as const,
	weekday: 4, // Thursday
	intervalWeeks: 1,
	anchorDate: "2026-01-01",
	timeOfDay: "18:45",
	keepAhead: 4,
	enabled: true,
};

describe("planTopUpInstants slot date (#1521)", () => {
	const base = {
		rule: { ...RULE, ordinals: [], location: null },
		timezone: TZ,
		now: NOW,
	};
	const moved = (slotDate: string | null) => [
		{
			// Moved from Thu Jun 4 to Sat Jun 6.
			scheduledAt: zonedWallTimeToUtc("2026-06-06T18:45", TZ),
			status: "scheduled",
			slotDate,
		},
	];

	it("reserves both the current date and the slot date", () => {
		const dates = planTopUpInstants({
			...base,
			existing: moved("2026-06-04"),
		}).map(local);
		expect(dates).not.toContain("2026-06-04");
		expect(dates).not.toContain("2026-06-06");
		expect(dates[0]).toBe("2026-06-11");
	});

	it("a null slot date behaves as before", () => {
		const dates = planTopUpInstants({ ...base, existing: moved(null) }).map(
			local,
		);
		expect(dates[0]).toBe("2026-06-04");
	});
});

describe.skipIf(!hasTestDb)("meetings.slot_date (#1521)", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
		await testDb.delete(meetings).where(eq(meetings.clubId, club.clubId));
		await testDb
			.insert(clubMeetingRecurrence)
			.values({ clubId: club.clubId, ...RULE, location: "Main Hall" });
		await testDb.execute(
			sql`update clubs set timezone = ${TZ} where id = ${club.clubId}`,
		);
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	const all = () =>
		testDb
			.select()
			.from(meetings)
			.where(eq(meetings.clubId, club.clubId))
			.orderBy(meetings.scheduledAt);

	it("the top-up writes slot_date, and a moved meeting's date is not recreated", async () => {
		await ensureScheduleToppedUp(club.clubId, NOW);
		const first = (await all())[0];
		expect(first.slotDate).toBe("2026-06-04");

		// An officer moves Thu Jun 4 to Sat Jun 6 (the web dialog's logic).
		await applyMeetingMetaPatch({
			meetingId: first.id,
			actorMemberId: club.adminMemberId,
			scheduledAt: "2026-06-06T18:45",
		});
		const afterMove = (await all()).find((m) => m.id === first.id);
		expect(afterMove && local(afterMove.scheduledAt)).toBe("2026-06-06");
		expect(afterMove?.slotDate).toBe("2026-06-04"); // unchanged by the move

		// Drop the future count below keep_ahead: cancel the next meeting.
		const rows = await all();
		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, rows[1].id));
		const before = (await all()).length;
		await ensureScheduleToppedUp(club.clubId, NOW);

		const after = await all();
		const dates = after.map((m) => local(m.scheduledAt));
		// Not vacuous: the second top-up created something (the next free
		// occurrence), and it is not the vacated Jun 4.
		expect(after.length).toBeGreaterThan(before);
		expect(dates).toContain("2026-07-02");
		expect(dates.filter((d) => d === "2026-06-04")).toHaveLength(0);
		expect(dates).toHaveLength(new Set(dates).size);
		expect(dates.filter((d) => d === "2026-06-06")).toHaveLength(1);
	});

	it("the manual create and the batch create write slot_date", async () => {
		const { meetingId } = await applyCreateMeeting({
			clubId: club.clubId,
			scheduledAt: "2026-07-02T23:30", // near midnight UTC-5 is still Jul 2 local
		});
		const [m] = await testDb
			.select()
			.from(meetings)
			.where(eq(meetings.id, meetingId));
		expect(m.slotDate).toBe("2026-07-02");

		await applyBatchCreateMeetings({
			clubId: club.clubId,
			wallTimes: ["2026-07-09T18:45"],
		});
		const batch = (await all()).find(
			(r) => local(r.scheduledAt) === "2026-07-09",
		);
		expect(batch?.slotDate).toBe("2026-07-09");
	});
});
