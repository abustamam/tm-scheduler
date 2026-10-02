/**
 * DB-backed tests for resolveMeetingKey. Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/meeting-resolve.integration.test.ts
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

describe.skipIf(!hasTestDb)("resolveMeetingKey", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
		// Pin the club tz + move the seeded meeting far away so it never collides
		// with the 2026-07-21 fixtures below.
		await testDb
			.update(clubs)
			.set({ timezone: "America/Chicago" })
			.where(eq(clubs.id, seed.clubId));
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date("2020-01-01T19:00:00Z") })
			.where(eq(meetings.id, seed.meetingId));
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("resolves a bare date, its -HHmm form, and its uuid", async () => {
		const { resolveMeetingKey } = await import(
			"#/server/meeting-resolve-logic"
		);
		const [m] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date("2026-07-21T23:45:00Z"), // 18:45 local
				status: "scheduled",
			})
			.returning({ id: meetings.id });

		expect(await resolveMeetingKey(seed.clubId, "2026-07-21")).toBe(m.id);
		expect(await resolveMeetingKey(seed.clubId, "2026-07-21-1845")).toBe(m.id);
		expect(await resolveMeetingKey(seed.clubId, m.id)).toBe(m.id);
	});

	it("resolves by the club-LOCAL date (not the UTC date)", async () => {
		const { resolveMeetingKey } = await import(
			"#/server/meeting-resolve-logic"
		);
		const [m] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date("2026-07-22T02:30:00Z"), // 21:30 local on the 21st
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		expect(await resolveMeetingKey(seed.clubId, "2026-07-21")).toBe(m.id);
	});

	it("returns the earliest for a bare-date double-header, exact for -HHmm", async () => {
		const { resolveMeetingKey } = await import(
			"#/server/meeting-resolve-logic"
		);
		const [early] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date("2026-07-21T23:45:00Z"), // 18:45 local
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		const [late] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date("2026-07-22T01:00:00Z"), // 20:00 local, same day
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		expect(await resolveMeetingKey(seed.clubId, "2026-07-21")).toBe(early.id);
		expect(await resolveMeetingKey(seed.clubId, "2026-07-21-2000")).toBe(
			late.id,
		);
	});

	it("skips a cancelled same-day meeting when resolving a bare date", async () => {
		const { resolveMeetingKey } = await import(
			"#/server/meeting-resolve-logic"
		);
		// Cancelled earlier that local day + an active later meeting.
		await testDb.insert(meetings).values({
			clubId: seed.clubId,
			scheduledAt: new Date("2026-07-21T23:00:00Z"), // 18:00 local, cancelled
			status: "cancelled",
		});
		const [active] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date("2026-07-22T00:00:00Z"), // 19:00 local, active
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		// Bare date must resolve to the ACTIVE meeting, not the earlier cancelled one.
		expect(await resolveMeetingKey(seed.clubId, "2026-07-21")).toBe(active.id);
	});

	// Maintainer's decision on #1084: a cancelled meeting is visible, read-only,
	// and says so, so the bare-date key every link issued before the cancel
	// carries has to reach it — when nothing live shares the day.
	it("falls back to a cancelled meeting when it is the only one that day", async () => {
		const { resolveMeetingKey, resolvePublicMeetingKey } = await import(
			"#/server/meeting-resolve-logic"
		);
		const [cancelled] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date("2026-07-21T23:45:00Z"), // 18:45 local
				status: "cancelled",
			})
			.returning({ id: meetings.id });
		expect(await resolveMeetingKey(seed.clubId, "2026-07-21")).toBe(
			cancelled.id,
		);
		// The public seam the meeting page and every sub-route reads through.
		expect(await resolvePublicMeetingKey(seed.clubId, "2026-07-21")).toBe(
			cancelled.id,
		);
	});

	it("falls back to the EARLIEST cancelled meeting when a day has only cancelled ones", async () => {
		const { resolveMeetingKey } = await import(
			"#/server/meeting-resolve-logic"
		);
		const [early] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date("2026-07-21T23:00:00Z"), // 18:00 local
				status: "cancelled",
			})
			.returning({ id: meetings.id });
		await testDb.insert(meetings).values({
			clubId: seed.clubId,
			scheduledAt: new Date("2026-07-22T01:00:00Z"), // 20:00 local, same day
			status: "cancelled",
		});
		expect(await resolveMeetingKey(seed.clubId, "2026-07-21")).toBe(early.id);
	});

	it("prefers a live meeting even when it is LATER than a cancelled one that day", async () => {
		// The collision rule the maintainer tabled, stated from the other side:
		// order is live-first, THEN time, so an earlier cancelled meeting cannot
		// win on time alone.
		const { resolveMeetingKey } = await import(
			"#/server/meeting-resolve-logic"
		);
		await testDb.insert(meetings).values({
			clubId: seed.clubId,
			scheduledAt: new Date("2026-07-21T22:00:00Z"), // 17:00 local, cancelled
			status: "cancelled",
		});
		const [completed] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date("2026-07-22T02:00:00Z"), // 21:00 local
				status: "completed",
			})
			.returning({ id: meetings.id });
		// `completed` is live for this purpose: only `cancelled` is demoted.
		expect(await resolveMeetingKey(seed.clubId, "2026-07-21")).toBe(
			completed.id,
		);
	});

	it("returns null for an unknown key or a uuid from another club", async () => {
		const { resolveMeetingKey } = await import(
			"#/server/meeting-resolve-logic"
		);
		expect(await resolveMeetingKey(seed.clubId, "2026-07-20")).toBeNull();
		expect(await resolveMeetingKey(seed.clubId, "not-a-key")).toBeNull();
		expect(
			await resolveMeetingKey(
				seed.clubId,
				"9f3c1a2b-0000-4000-8000-000000000000",
			),
		).toBeNull();
	});
});
