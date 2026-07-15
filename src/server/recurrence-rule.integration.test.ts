/**
 * DB-backed tests for the #190 recurrence-rule CRUD + edit reconciliation:
 * saving a rule tops up; editing the PATTERN deletes only pristine-empty future
 * meetings on the OLD pattern and regenerates on the new one; customized and
 * off-old-pattern meetings survive; disabling stops generation.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test_190 \
 *     bunx vitest run src/server/recurrence-rule.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meetings, roleSlots } from "#/db/schema";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { saveRecurrenceRule, getRecurrenceRule } = await import(
	"./recurrence-rule-logic"
);

const TZ = "America/Chicago";
const NOW = new Date("2026-06-01T12:00:00Z");

function localDate(instant: Date): string {
	return utcToZonedWallTime(instant, TZ).slice(0, 10);
}
function weekdayOf(ymd: string): number {
	return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}

const weeklyThursday = {
	mode: "interval" as const,
	weekday: 4,
	intervalWeeks: 1,
	anchorDate: "2026-01-01",
	ordinals: null,
	timeOfDay: "18:45",
	location: "Main Hall",
	keepAhead: 4,
	enabled: true,
};

async function futureScheduled(clubId: string) {
	const rows = await testDb
		.select({ id: meetings.id, scheduledAt: meetings.scheduledAt })
		.from(meetings)
		.where(and(eq(meetings.clubId, clubId), eq(meetings.status, "scheduled")));
	return rows
		.filter((r) => r.scheduledAt.getTime() > NOW.getTime())
		.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
}

describe.skipIf(!hasTestDb)(
	"recurrence-rule CRUD + reconciliation (#190)",
	() => {
		let club: SeededClub;

		beforeEach(async () => {
			club = await seedClub();
			await testDb.delete(meetings).where(eq(meetings.clubId, club.clubId));
		});
		afterEach(async () => {
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		});

		it("creating a rule persists it and tops up the schedule", async () => {
			const res = await saveRecurrenceRule(club.clubId, weeklyThursday, NOW);
			expect(res.created).toBe(4);

			const rule = await getRecurrenceRule(club.clubId);
			expect(rule?.mode).toBe("interval");
			expect(rule?.weekday).toBe(4);

			const rows = await futureScheduled(club.clubId);
			expect(rows.length).toBe(4);
			expect(
				rows
					.map((r) => localDate(r.scheduledAt))
					.every((d) => weekdayOf(d) === 4),
			).toBe(true);
		});

		it("editing the weekday moves pristine future meetings to the new pattern", async () => {
			await saveRecurrenceRule(club.clubId, weeklyThursday, NOW);
			// Edit Thursday → Wednesday.
			await saveRecurrenceRule(
				club.clubId,
				{ ...weeklyThursday, weekday: 3 },
				NOW,
			);

			const dates = (await futureScheduled(club.clubId)).map((r) =>
				localDate(r.scheduledAt),
			);
			expect(dates.length).toBe(4);
			expect(dates.every((d) => weekdayOf(d) === 3)).toBe(true); // all Wednesdays now
			expect(dates.some((d) => weekdayOf(d) === 4)).toBe(false); // no Thursdays left
		});

		it("editing preserves a future meeting that has a claimed role slot", async () => {
			await saveRecurrenceRule(club.clubId, weeklyThursday, NOW);
			const before = await futureScheduled(club.clubId);
			// Claim a slot on the 2nd Thursday → it's now customized, not pristine.
			const kept = before[1];
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: club.memberId, status: "claimed" })
				.where(eq(roleSlots.meetingId, kept.id));

			await saveRecurrenceRule(
				club.clubId,
				{ ...weeklyThursday, weekday: 3 },
				NOW,
			);

			// The claimed Thursday meeting survives; the other pristine Thursdays are gone.
			const rows = await futureScheduled(club.clubId);
			const ids = rows.map((r) => r.id);
			expect(ids).toContain(kept.id);
			const thursdays = rows.filter(
				(r) => weekdayOf(localDate(r.scheduledAt)) === 4,
			);
			expect(thursdays.map((r) => r.id)).toEqual([kept.id]);
		});

		it("editing does not delete a manual off-old-pattern meeting", async () => {
			await saveRecurrenceRule(club.clubId, weeklyThursday, NOW);
			// A manual pristine meeting on a Tuesday (not on the old Thursday pattern).
			const [tue] = await testDb
				.insert(meetings)
				.values({
					clubId: club.clubId,
					scheduledAt: zonedWallTimeToUtc("2026-06-16T12:00", TZ), // a Tuesday
					status: "scheduled",
				})
				.returning({ id: meetings.id });

			await saveRecurrenceRule(
				club.clubId,
				{ ...weeklyThursday, weekday: 3 },
				NOW,
			);

			const ids = (await futureScheduled(club.clubId)).map((r) => r.id);
			expect(ids).toContain(tue.id); // off-pattern manual meeting untouched
		});

		it("disabling stops generation and leaves existing meetings in place", async () => {
			await saveRecurrenceRule(club.clubId, weeklyThursday, NOW);
			const beforeIds = (await futureScheduled(club.clubId))
				.map((r) => r.id)
				.sort();

			const res = await saveRecurrenceRule(
				club.clubId,
				{ ...weeklyThursday, enabled: false },
				NOW,
			);
			expect(res.created).toBe(0);

			const afterIds = (await futureScheduled(club.clubId))
				.map((r) => r.id)
				.sort();
			expect(afterIds).toEqual(beforeIds); // unchanged
			expect((await getRecurrenceRule(club.clubId))?.enabled).toBe(false);
		});
	},
);
