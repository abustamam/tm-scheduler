/**
 * DB-backed tests for the #190 read-triggered schedule top-up: keep `keep_ahead`
 * future `scheduled` meetings materialized from a standing recurrence rule,
 * idempotently, skipping taken dates and honoring cancellation-as-skip.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test_190 \
 *     bunx vitest run src/server/schedule-topup.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubMeetingRecurrence, meetings, roleSlots } from "#/db/schema";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { ensureScheduleToppedUp } = await import("./schedule-topup-logic");

const TZ = "America/Chicago";
// A Monday noon UTC — deterministic "now" so occurrence dates are stable.
const NOW = new Date("2026-06-01T12:00:00Z");

/** Local calendar date (club tz) of a meeting instant. */
function localDate(instant: Date): string {
	return utcToZonedWallTime(instant, TZ).slice(0, 10);
}

/** Weekday (0=Sun…6=Sat) of a YYYY-MM-DD read as a calendar date. */
function weekdayOf(ymd: string): number {
	return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}

async function seedWeeklyRule(
	clubId: string,
	overrides: Partial<typeof clubMeetingRecurrence.$inferInsert> = {},
) {
	await testDb.insert(clubMeetingRecurrence).values({
		clubId,
		mode: "interval",
		weekday: 4, // Thursday
		intervalWeeks: 1,
		anchorDate: "2026-01-01",
		timeOfDay: "18:45",
		keepAhead: 4,
		enabled: true,
		location: "Main Hall",
		...overrides,
	});
}

/** Clear the meeting seedClub created so each test starts from zero meetings. */
async function clearMeetings(clubId: string) {
	await testDb.delete(meetings).where(eq(meetings.clubId, clubId));
}

async function futureScheduled(clubId: string) {
	const rows = await testDb
		.select({ scheduledAt: meetings.scheduledAt })
		.from(meetings)
		.where(and(eq(meetings.clubId, clubId), eq(meetings.status, "scheduled")));
	return rows
		.map((r) => r.scheduledAt)
		.filter((d) => d.getTime() > NOW.getTime())
		.sort((a, b) => a.getTime() - b.getTime());
}

describe.skipIf(!hasTestDb)("ensureScheduleToppedUp (#190)", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("tops up to keep_ahead future scheduled meetings on rule dates", async () => {
		await clearMeetings(club.clubId);
		await seedWeeklyRule(club.clubId);

		const res = await ensureScheduleToppedUp(club.clubId, NOW);
		expect(res.created).toBe(4);

		const rows = await futureScheduled(club.clubId);
		expect(rows.length).toBe(4);
		const dates = rows.map(localDate);
		expect(dates[0]).toBe("2026-06-04"); // first Thursday on/after Jun 1
		expect(dates.every((d) => weekdayOf(d) === 4)).toBe(true);
	});

	it("copies club default minutes, rule location, blank theme/WOD, and generates slots", async () => {
		await clearMeetings(club.clubId);
		await seedWeeklyRule(club.clubId);
		await ensureScheduleToppedUp(club.clubId, NOW);

		const [m] = await testDb
			.select()
			.from(meetings)
			.where(eq(meetings.clubId, club.clubId))
			.limit(1);
		expect(m.location).toBe("Main Hall");
		expect(m.lengthMinutes).toBe(90); // club default
		expect(m.theme).toBeNull();
		expect(m.wordOfTheDay).toBeNull();
		expect(m.status).toBe("scheduled");

		const slots = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.where(eq(roleSlots.meetingId, m.id));
		expect(slots.length).toBeGreaterThan(0); // Timer role from the club template
	});

	it("is idempotent — a second run creates nothing", async () => {
		await clearMeetings(club.clubId);
		await seedWeeklyRule(club.clubId);
		await ensureScheduleToppedUp(club.clubId, NOW);
		const second = await ensureScheduleToppedUp(club.clubId, NOW);
		expect(second.created).toBe(0);
		expect((await futureScheduled(club.clubId)).length).toBe(4);
	});

	it("skips a date already occupied by an existing meeting (no duplicate)", async () => {
		await clearMeetings(club.clubId);
		// A manual scheduled meeting on the first rule Thursday.
		await testDb.insert(meetings).values({
			clubId: club.clubId,
			scheduledAt: zonedWallTimeToUtc("2026-06-04T19:00", TZ),
			status: "scheduled",
		});
		await seedWeeklyRule(club.clubId);

		const res = await ensureScheduleToppedUp(club.clubId, NOW);
		// Already 1 future scheduled → only 3 more created to reach 4.
		expect(res.created).toBe(3);
		const onJun4 = (await futureScheduled(club.clubId)).filter(
			(d) => localDate(d) === "2026-06-04",
		);
		expect(onJun4.length).toBe(1); // not duplicated
		expect((await futureScheduled(club.clubId)).length).toBe(4);
	});

	it("cancellation: a cancelled meeting keeps its date but doesn't count toward keep_ahead", async () => {
		await clearMeetings(club.clubId);
		// Cancel the first rule Thursday.
		await testDb.insert(meetings).values({
			clubId: club.clubId,
			scheduledAt: zonedWallTimeToUtc("2026-06-04T18:45", TZ),
			status: "cancelled",
		});
		await seedWeeklyRule(club.clubId);

		const res = await ensureScheduleToppedUp(club.clubId, NOW);
		expect(res.created).toBe(4); // cancelled one doesn't count → 4 new

		const dates = (await futureScheduled(club.clubId)).map(localDate);
		expect(dates).not.toContain("2026-06-04"); // cancelled date not resurrected
		expect(dates[0]).toBe("2026-06-11"); // rolled forward past the cancelled one

		// The cancelled meeting still exists on its date.
		const cancelled = await testDb
			.select()
			.from(meetings)
			.where(
				and(eq(meetings.clubId, club.clubId), eq(meetings.status, "cancelled")),
			);
		expect(cancelled.length).toBe(1);
		expect(localDate(cancelled[0].scheduledAt)).toBe("2026-06-04");
	});

	it("is a no-op when the rule is disabled", async () => {
		await clearMeetings(club.clubId);
		await seedWeeklyRule(club.clubId, { enabled: false });
		const res = await ensureScheduleToppedUp(club.clubId, NOW);
		expect(res.created).toBe(0);
		expect((await futureScheduled(club.clubId)).length).toBe(0);
	});

	it("is a no-op when the club has no rule", async () => {
		await clearMeetings(club.clubId);
		const res = await ensureScheduleToppedUp(club.clubId, NOW);
		expect(res.created).toBe(0);
	});

	it("two concurrent top-ups create each occurrence exactly once", async () => {
		await clearMeetings(club.clubId);
		await seedWeeklyRule(club.clubId);

		await Promise.all([
			ensureScheduleToppedUp(club.clubId, NOW),
			ensureScheduleToppedUp(club.clubId, NOW),
		]);

		// Deterministic occurrences + the unique (club_id, scheduled_at) index ⇒
		// the race resolves to exactly keep_ahead, never double-created.
		const rows = await futureScheduled(club.clubId);
		expect(rows.length).toBe(4);
		const dates = rows.map(localDate);
		expect(new Set(dates).size).toBe(4);
	});
});
