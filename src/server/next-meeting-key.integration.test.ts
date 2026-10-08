/**
 * DB-backed tests for `loadPublicNextMeetingKey` (#1140): which meeting a club's
 * `/club/<slug>/next` permalink and the signed-in `/next` shortcut both open.
 *
 * The rule is the PHASE rule (`meetingPhase`, #541), not the instant rule the
 * invite and the upcoming list use: `status = 'scheduled'` AND a date at or
 * after the start of today in the CLUB's timezone. So today's meeting stays
 * "next" after it starts, until its club-local day ends or it is completed.
 *
 * `now` is injected, and every meeting is built from a club-local wall time, so
 * no case depends on when the suite runs or on the machine's timezone. The
 * dates sit in June 2030, away from any DST changeover, so Los Angeles is a
 * fixed UTC-7 for all of them.
 *
 * The club is inserted directly rather than through `seedClub`: nothing here
 * needs users or members, and `seedClub`'s own future meeting would be a second
 * candidate in every case. Deleting the club cascades its meetings away.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clubs, meetings } from "#/db/schema";
import { zonedWallTimeToUtc } from "#/lib/datetime";
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadPublicNextMeetingKey } = await import("#/server/meetings-logic");

const LA = "America/Los_Angeles";
const CHICAGO = "America/Chicago";

let clubId: string | null = null;
let slug = "";

afterEach(async () => {
	if (clubId) {
		await testDb.delete(clubs).where(eq(clubs.id, clubId));
		clubId = null;
	}
});

async function seedClubIn(timezone: string): Promise<string> {
	const id = randomUUID();
	slug = `next-key-${id}`;
	await testDb
		.insert(clubs)
		.values({ id, name: "Next Key Club", slug, timezone });
	clubId = id;
	return id;
}

/** Insert a meeting at a club-local wall time (`YYYY-MM-DDTHH:mm`). */
async function meetingAt(
	timezone: string,
	wall: string,
	status: "scheduled" | "completed" | "cancelled" = "scheduled",
): Promise<void> {
	if (!clubId) throw new Error("seed a club first");
	await testDb.insert(meetings).values({
		clubId,
		scheduledAt: zonedWallTimeToUtc(wall, timezone),
		status,
	});
}

const at = (timezone: string, wall: string) =>
	zonedWallTimeToUtc(wall, timezone);

describe.skipIf(!hasTestDb)("loadPublicNextMeetingKey (#1140)", () => {
	it("a future meeting is next, named by its club-local date", async () => {
		const id = await seedClubIn(CHICAGO);
		await meetingAt(CHICAGO, "2030-06-11T19:00");

		const r = await loadPublicNextMeetingKey(
			id,
			at(CHICAGO, "2030-06-04T12:00"),
		);
		expect(r).toEqual({ clubSlug: slug, urlKey: "2030-06-11" });
	});

	it("today's scheduled meeting stays next after it has started", async () => {
		const id = await seedClubIn(CHICAGO);
		await meetingAt(CHICAGO, "2030-06-11T19:00");
		await meetingAt(CHICAGO, "2030-06-18T19:00");

		// 19:30: the instant rule would already have dropped it.
		const during = await loadPublicNextMeetingKey(
			id,
			at(CHICAGO, "2030-06-11T19:30"),
		);
		expect(during?.urlKey).toBe("2030-06-11");
		// 23:30: still tonight's meeting, until the club-local day ends.
		const late = await loadPublicNextMeetingKey(
			id,
			at(CHICAGO, "2030-06-11T23:30"),
		);
		expect(late?.urlKey).toBe("2030-06-11");
	});

	it("today's COMPLETED meeting is skipped for the following one, at any hour", async () => {
		const id = await seedClubIn(CHICAGO);
		await meetingAt(CHICAGO, "2030-06-11T19:00", "completed");
		await meetingAt(CHICAGO, "2030-06-18T19:00");

		for (const now of [
			"2030-06-11T08:00",
			"2030-06-11T19:30",
			"2030-06-11T23:30",
		]) {
			const r = await loadPublicNextMeetingKey(id, at(CHICAGO, now));
			expect(r?.urlKey, now).toBe("2030-06-18");
		}
	});

	it("a cancelled meeting is never chosen, even when it is the soonest", async () => {
		const id = await seedClubIn(CHICAGO);
		await meetingAt(CHICAGO, "2030-06-11T19:00", "cancelled");
		await meetingAt(CHICAGO, "2030-06-18T19:00");

		const r = await loadPublicNextMeetingKey(
			id,
			at(CHICAGO, "2030-06-04T12:00"),
		);
		expect(r?.urlKey).toBe("2030-06-18");
	});

	it("a scheduled meeting on a PAST day is never chosen", async () => {
		const id = await seedClubIn(CHICAGO);
		// Never completed, never cancelled: an officer who forgot to close it out.
		await meetingAt(CHICAGO, "2030-06-04T19:00");
		await meetingAt(CHICAGO, "2030-06-18T19:00");

		const r = await loadPublicNextMeetingKey(
			id,
			at(CHICAGO, "2030-06-11T12:00"),
		);
		expect(r?.urlKey).toBe("2030-06-18");
	});

	it("a club with nothing scheduled returns its slug and a null key", async () => {
		const id = await seedClubIn(CHICAGO);

		const r = await loadPublicNextMeetingKey(
			id,
			at(CHICAGO, "2030-06-11T12:00"),
		);
		expect(r).toEqual({ clubSlug: slug, urlKey: null });
	});

	it("two meetings on one day: the earlier stays next, under its time-suffixed key", async () => {
		const id = await seedClubIn(CHICAGO);
		await meetingAt(CHICAGO, "2030-06-11T18:30");
		await meetingAt(CHICAGO, "2030-06-11T20:00");

		const before = await loadPublicNextMeetingKey(
			id,
			at(CHICAGO, "2030-06-11T09:00"),
		);
		expect(before?.urlKey).toBe("2030-06-11-1830");
		// The later one has started, and the earlier one is still next: the
		// decided edge, because the day has not ended and it is not completed.
		const after = await loadPublicNextMeetingKey(
			id,
			at(CHICAGO, "2030-06-11T20:15"),
		);
		expect(after?.urlKey).toBe("2030-06-11-1830");
	});

	it("draws the day boundary in the club's zone, not UTC: 23:30 local is still tonight", async () => {
		const id = await seedClubIn(LA);
		await meetingAt(LA, "2030-06-11T19:00");
		await meetingAt(LA, "2030-06-18T19:00");

		// 23:30 in Los Angeles on meeting day is already 06:30 UTC the NEXT day.
		const now = at(LA, "2030-06-11T23:30");
		expect(now.toISOString()).toBe("2030-06-12T06:30:00.000Z");
		const r = await loadPublicNextMeetingKey(id, now);
		expect(r?.urlKey).toBe("2030-06-11");
	});

	it("one minute into the next local day, tonight's meeting is over", async () => {
		const id = await seedClubIn(LA);
		await meetingAt(LA, "2030-06-11T19:00");
		await meetingAt(LA, "2030-06-18T19:00");

		const r = await loadPublicNextMeetingKey(id, at(LA, "2030-06-12T00:01"));
		expect(r?.urlKey).toBe("2030-06-18");
	});
});
