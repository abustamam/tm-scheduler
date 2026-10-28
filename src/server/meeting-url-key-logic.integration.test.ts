/**
 * #1396: a meeting has ONE canonical URL key, the same on every surface, and a
 * CANCELLED meeting on the same club-local date counts as a collision. Without
 * that, the cancelled meeting got the bare date, which resolves to the live
 * one, so every link on its page opened the other meeting.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, meetings } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// Chicago is UTC-5 in July (CDT). Far future so the "upcoming" readers see them.
const TZ = "America/Chicago";
const LIVE_AT = new Date("2036-07-22T00:00:00Z"); // 19:00 local on the 21st
const CANCELLED_AT = new Date("2036-07-21T23:00:00Z"); // 18:00 local on the 21st

describe.skipIf(!hasTestDb)("canonical meeting URL key (#1396)", () => {
	let seed: SeededClub;
	let liveId: string;
	let cancelledId: string;

	beforeEach(async () => {
		seed = await seedClub();
		await testDb
			.update(clubs)
			.set({ timezone: TZ })
			.where(eq(clubs.id, seed.clubId));
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date("2036-01-01T19:00:00Z") })
			.where(eq(meetings.id, seed.meetingId));
		[{ id: liveId }] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: LIVE_AT,
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		[{ id: cancelledId }] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: CANCELLED_AT,
				status: "cancelled",
			})
			.returning({ id: meetings.id });
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("gives a cancelled and a live meeting on one date distinct -HHmm keys, each reaching its own meeting", async () => {
		const { resolveMeetingUrlKey } = await import(
			"#/server/meeting-url-key-logic"
		);
		const { resolveMeetingKey } = await import(
			"#/server/meeting-resolve-logic"
		);
		const liveKey = await resolveMeetingUrlKey(seed.clubId, LIVE_AT, TZ);
		const cancelledKey = await resolveMeetingUrlKey(
			seed.clubId,
			CANCELLED_AT,
			TZ,
		);
		expect(liveKey).toBe("2036-07-21-1900");
		expect(cancelledKey).toBe("2036-07-21-1800");
		expect(await resolveMeetingKey(seed.clubId, liveKey)).toBe(liveId);
		expect(await resolveMeetingKey(seed.clubId, cancelledKey)).toBe(
			cancelledId,
		);
	});

	it("keeps the bare date naming the LIVE meeting (#1084)", async () => {
		const { resolveMeetingKey } = await import(
			"#/server/meeting-resolve-logic"
		);
		expect(await resolveMeetingKey(seed.clubId, "2036-07-21")).toBe(liveId);
	});

	it("names the live meeting the same on the page, the grid, the strip sources and the archive", async () => {
		const { resolveMeetingUrlKey } = await import(
			"#/server/meeting-url-key-logic"
		);
		const { loadPublicUpcomingMeetings, loadCancelledMeetings } = await import(
			"#/server/meetings-logic"
		);
		const { loadSeasonGrid } = await import("#/server/season-grid-logic");
		const page = await resolveMeetingUrlKey(seed.clubId, LIVE_AT, TZ);

		const upcoming = await loadPublicUpcomingMeetings(seed.clubId);
		expect(upcoming.find((m) => m.id === liveId)?.urlKey).toBe(page);

		const grid = await loadSeasonGrid({ clubId: seed.clubId, count: "all" });
		expect(grid.meetings.find((m) => m.id === liveId)?.urlKey).toBe(page);

		const cancelled = await loadCancelledMeetings(
			seed.clubId,
			new Date("2036-07-01T00:00:00Z"),
		);
		expect(cancelled.find((m) => m.id === cancelledId)?.urlKey).toBe(
			await resolveMeetingUrlKey(seed.clubId, CANCELLED_AT, TZ),
		);
	});

	it("names a past meeting the same in the archive list as on its page", async () => {
		const { resolveMeetingUrlKey } = await import(
			"#/server/meeting-url-key-logic"
		);
		const { loadPastMeetings } = await import("#/server/past-meetings-logic");
		await testDb
			.update(meetings)
			.set({
				scheduledAt: new Date("2020-07-22T00:00:00Z"),
				status: "completed",
			})
			.where(eq(meetings.id, liveId));
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date("2020-07-21T23:00:00Z") })
			.where(eq(meetings.id, cancelledId));
		const past = await loadPastMeetings({ clubId: seed.clubId });
		expect(past.meetings.find((m) => m.id === liveId)?.urlKey).toBe(
			await resolveMeetingUrlKey(
				seed.clubId,
				new Date("2020-07-22T00:00:00Z"),
				TZ,
			),
		);
		expect(past.meetings.find((m) => m.id === liveId)?.urlKey).toBe(
			"2020-07-21-1900",
		);
	});
});
