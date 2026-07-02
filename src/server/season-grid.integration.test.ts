/**
 * DB-backed tests for loadSeasonGrid. Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/season-grid.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetings,
	memberAvailability,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("loadSeasonGrid", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
		// Pin the seeded meeting to a clearly-future date so it stays
		// "upcoming"/anchor regardless of when the suite runs.
		const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
		await testDb
			.update(meetings)
			.set({ scheduledAt: future })
			.where(eq(meetings.id, seed.meetingId));
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("windows past lookback + upcoming, expands multi-count rows, counts open", async () => {
		const { loadSeasonGrid } = await import("#/server/season-grid-logic");

		// seedClub gives: a Timer role def, one upcoming meeting (pinned future
		// in beforeEach), one open Timer slot. Add a past meeting + a 3-count
		// Speaker role.
		const [speaker] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Speaker",
				category: "speaker",
				defaultCount: 3,
				sortOrder: 5,
				isSpeakerRole: true,
			})
			.returning({ id: roleDefinitions.id });

		const [pastMeeting] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date("2020-01-01T19:00:00Z"),
				status: "scheduled",
			})
			.returning({ id: meetings.id });

		// 3 speaker slots on the upcoming meeting; assign the seeded member to slot 0.
		await testDb.insert(roleSlots).values([
			{
				meetingId: seed.meetingId,
				roleDefinitionId: speaker!.id,
				slotIndex: 0,
				status: "claimed",
				assignedMemberId: seed.memberId,
			},
			{
				meetingId: seed.meetingId,
				roleDefinitionId: speaker!.id,
				slotIndex: 1,
			},
			{
				meetingId: seed.meetingId,
				roleDefinitionId: speaker!.id,
				slotIndex: 2,
			},
		]);

		// member is NA for the past meeting
		await testDb.insert(memberAvailability).values({
			memberId: seed.memberId,
			meetingId: pastMeeting!.id,
		});

		const data = await loadSeasonGrid({ clubId: seed.clubId, count: 8 });

		// columns: the past meeting (lookback) + the upcoming meeting
		expect(data.meetings).toHaveLength(2);
		expect(data.meetings[0]!.id).toBe(pastMeeting!.id);
		expect(data.meetings[0]!.isPast).toBe(true);
		expect(data.meetings[1]!.id).toBe(seed.meetingId);
		expect(data.meetings[1]!.isAnchor).toBe(true);

		// rows: Timer (1) + Speaker expanded (3) = 4, ordered by sortOrder
		const speakerRows = data.rows.filter(
			(r) => r.roleDefinitionId === speaker!.id,
		);
		expect(speakerRows.map((r) => r.label)).toEqual([
			"Speaker 1",
			"Speaker 2",
			"Speaker 3",
		]);
		expect(speakerRows[1]!.shortCode).toBe("SP2");

		// open count on the upcoming meeting: 1 Timer + 2 unassigned speakers = 3
		const upcoming = data.meetings.find((m) => m.id === seed.meetingId)!;
		expect(upcoming.openCount).toBe(3);

		// the assigned cell + availability surfaced
		const assigned = data.cells.find(
			(c) => c.memberId === seed.memberId && c.meetingId === seed.meetingId,
		);
		expect(assigned?.status).toBe("claimed");
		expect(data.unavailable).toContainEqual({
			memberId: seed.memberId,
			meetingId: pastMeeting!.id,
		});
	});

	it("count: 4 limits upcoming meetings", async () => {
		const { loadSeasonGrid } = await import("#/server/season-grid-logic");
		// seedClub already inserted 1 upcoming meeting; add 5 more upcoming.
		for (let i = 0; i < 5; i++) {
			await testDb.insert(meetings).values({
				clubId: seed.clubId,
				scheduledAt: new Date(Date.now() + (i + 2) * 7 * 24 * 60 * 60 * 1000),
				status: "scheduled",
			});
		}
		const data = await loadSeasonGrid({ clubId: seed.clubId, count: 4 });
		const upcomingCols = data.meetings.filter((m) => !m.isPast);
		expect(upcomingCols).toHaveLength(4);
	});

	it("count: 'all' returns every upcoming meeting", async () => {
		const { loadSeasonGrid } = await import("#/server/season-grid-logic");
		// seedClub already inserted 1 upcoming meeting; add 2 more (3 total).
		for (let i = 0; i < 2; i++) {
			await testDb.insert(meetings).values({
				clubId: seed.clubId,
				scheduledAt: new Date(Date.now() + (i + 2) * 7 * 24 * 60 * 60 * 1000),
				status: "scheduled",
			});
		}
		const data = await loadSeasonGrid({ clubId: seed.clubId, count: "all" });
		const upcomingCols = data.meetings.filter((m) => !m.isPast);
		expect(upcomingCols).toHaveLength(3);
	});
});
