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
