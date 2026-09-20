/**
 * The `upsert_agendas` planner against real data (#808).
 *
 * `plan()` is the one thing the MCP preview, every render of the confirm page
 * and the re-plan inside the apply transaction all call, so the branch each
 * date takes — and the diff each `update` line carries — is the whole basis of
 * the hash comparison. It reads a club's meetings and its standing rule, so it
 * needs a database rather than a fixture.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/agenda-plan.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubMeetingRecurrence, clubs, meetings } from "#/db/schema";
import { zonedWallTimeToUtc } from "#/lib/datetime";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { plan, agendaPlanHash, agendaPlanSummary } = await import(
	"#/server/agenda-plan"
);

/** Fixed calendar dates, so nothing here moves with the wall clock. */
const TUESDAY = "2027-03-02";
const NEXT_TUESDAY = "2027-03-09";
const WEDNESDAY = "2027-03-10";
/** 0 = Sunday … 2 = Tuesday, matching `club_meeting_recurrence.weekday`. */
const TUESDAY_INDEX = 2;

describe.skipIf(!hasTestDb)("the agenda planner", () => {
	let seed: SeededClub;
	let club: { clubId: string; timezone: string };

	/** A meeting at a club-local date and time; returns its id. */
	async function seedMeeting(
		date: string,
		time = "19:00",
		overrides: Partial<typeof meetings.$inferInsert> = {},
	): Promise<string> {
		const [row] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: zonedWallTimeToUtc(`${date}T${time}`, club.timezone),
				...overrides,
			})
			.returning({ id: meetings.id });
		if (!row) throw new Error("failed to seed a meeting");
		return row.id;
	}

	/** Give the club a standing Tuesday-19:00 rule. */
	async function seedRule(enabled = true) {
		await testDb.insert(clubMeetingRecurrence).values({
			clubId: seed.clubId,
			mode: "interval",
			weekday: TUESDAY_INDEX,
			intervalWeeks: 1,
			anchorDate: TUESDAY,
			timeOfDay: "19:00",
			location: "The usual hall",
			enabled,
		});
	}

	beforeEach(async () => {
		seed = await seedClub();
		const [row] = await testDb
			.select({ timezone: clubs.timezone })
			.from(clubs)
			.where(eq(clubs.id, seed.clubId));
		club = {
			clubId: seed.clubId,
			timezone: row?.timezone ?? "America/Chicago",
		};
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	describe("the create branch", () => {
		it("plans a create for a date with no meeting, taking time and location from the rule", async () => {
			await seedRule();
			const { plan: p, blocking } = await plan(testDb, club, [
				{ date: TUESDAY, theme: "Harvest" },
			]);
			expect(blocking).toStrictEqual([]);
			expect(p.lines).toHaveLength(1);
			const line = p.lines[0];
			if (line?.action !== "create") throw new Error("expected a create");
			expect(line.time).toBe("19:00");
			expect(line.location).toBe("The usual hall");
			expect(line.meta.theme).toBe("Harvest");
			expect(line.weekday).toBe("Tuesday");
		});

		it("prefers the time the entry names over the rule's", async () => {
			await seedRule();
			const { plan: p } = await plan(testDb, club, [
				{ date: TUESDAY, time: "07:30" },
			]);
			const line = p.lines[0];
			if (line?.action !== "create") throw new Error("expected a create");
			expect(line.time).toBe("07:30");
		});

		it("still takes the time from a DISABLED rule", async () => {
			// Pausing top-up (#190) says "stop materialising meetings", not "the
			// club has forgotten when it meets" — and a caller naming a date
			// explicitly is not asking for top-up. Only the absence of a row means
			// there is nothing to fall back on.
			await seedRule(false);
			const { plan: p, blocking } = await plan(testDb, club, [
				{ date: TUESDAY },
			]);
			expect(blocking).toStrictEqual([]);
			expect(p.lines[0]?.action).toBe("create");
		});

		it("blocks MISSING_TIME when the club has no rule and the entry names no time", async () => {
			const { plan: p, blocking } = await plan(testDb, club, [
				{ date: TUESDAY, theme: "Harvest" },
			]);
			expect(p.lines).toStrictEqual([]);
			expect(blocking).toHaveLength(1);
			expect(blocking[0]?.code).toBe("MISSING_TIME");
			expect(blocking[0]?.entryIndex).toBe(0);
			expect(blocking[0]?.message).toContain(TUESDAY);
		});

		it("does not block when the club has no rule but the entry names a time", async () => {
			const { plan: p, blocking } = await plan(testDb, club, [
				{ date: TUESDAY, time: "19:00" },
			]);
			expect(blocking).toStrictEqual([]);
			const line = p.lines[0];
			if (line?.action !== "create") throw new Error("expected a create");
			expect(line.location).toBeNull();
		});

		it("clears the location when the entry explicitly empties it", async () => {
			await seedRule();
			const { plan: p } = await plan(testDb, club, [
				{ date: TUESDAY, location: null },
			]);
			const line = p.lines[0];
			if (line?.action !== "create") throw new Error("expected a create");
			expect(line.location).toBeNull();
		});
	});

	describe("the update branch", () => {
		it("matches a meeting by its CLUB-LOCAL date and diffs only what moves", async () => {
			const meetingId = await seedMeeting(TUESDAY, "19:00", {
				theme: "Old",
				wordOfTheDay: "ebullient",
			});
			const { plan: p, blocking } = await plan(testDb, club, [
				{ date: TUESDAY, theme: "Harvest" },
			]);
			expect(blocking).toStrictEqual([]);
			const line = p.lines[0];
			if (line?.action !== "update") throw new Error("expected an update");
			expect(line.meetingId).toBe(meetingId);
			expect(line.time).toBe("19:00");
			// AC2, and the property behind AC8: the Word of the Day is not in the
			// diff, so it is not in the patch, so it survives.
			expect(line.changes).toStrictEqual([
				{ field: "theme", from: "Old", to: "Harvest" },
			]);
		});

		it("plans an empty diff for a date whose fields already match", async () => {
			await seedMeeting(TUESDAY, "19:00", { theme: "Harvest" });
			const { plan: p } = await plan(testDb, club, [
				{ date: TUESDAY, theme: "Harvest" },
			]);
			const line = p.lines[0];
			if (line?.action !== "update") throw new Error("expected an update");
			expect(line.changes).toStrictEqual([]);
			expect(agendaPlanSummary(p)).toMatchObject({ unchanged: 1, updated: 0 });
		});

		it("warns rather than blocking when the entry names a different time", async () => {
			// Moving a meeting is a reschedule with its own authorization
			// (ADR-0010). The time is dropped — said out loud rather than
			// discarded silently.
			await seedMeeting(TUESDAY, "19:00");
			const { plan: p } = await plan(testDb, club, [
				{ date: TUESDAY, time: "07:30", theme: "Breakfast" },
			]);
			const line = p.lines[0];
			if (line?.action !== "update") throw new Error("expected an update");
			expect(line.time).toBe("19:00");
			expect(line.warnings).toContain("time_ignored");
		});

		it("warns on a cancelled meeting, which still occupies its date", async () => {
			await seedMeeting(TUESDAY, "19:00", { status: "cancelled" });
			const { plan: p, blocking } = await plan(testDb, club, [
				{ date: TUESDAY, theme: "Harvest" },
			]);
			expect(blocking).toStrictEqual([]);
			expect(p.lines[0]?.warnings).toContain("meeting_cancelled");
		});

		it("reports a provisional meeting number ALONGSIDE the plan, never inside it", async () => {
			// Numbers freeze when a meeting is completed (#358) and are derived
			// until then, so one being frozen elsewhere in the season must not
			// change the hash — see `AgendaPlan`. Asserted by MOVING the anchor
			// and watching the number change while the hash does not: grepping the
			// serialised plan for the digits would be satisfied by any uuid that
			// happened to contain them, which is how this case first passed for
			// the wrong reason.
			const anchorId = await seedMeeting("2027-02-23", "19:00", {
				status: "completed",
				meetingNumber: 40,
			});
			await seedMeeting(TUESDAY, "19:00");
			const args = [{ date: TUESDAY, theme: "Harvest" }];
			const before = await plan(testDb, club, args);
			expect(before.meetingNumbers[0]).toBe(41);

			await testDb
				.update(meetings)
				.set({ meetingNumber: 70 })
				.where(eq(meetings.id, anchorId));

			const after = await plan(testDb, club, args);
			expect(after.meetingNumbers[0]).toBe(71);
			const hash = (p: typeof before.plan) =>
				agendaPlanHash({
					clubId: club.clubId,
					userId: seed.adminUserId,
					plan: p,
				});
			expect(hash(after.plan)).toBe(hash(before.plan));
		});
	});

	describe("blocking branches", () => {
		it("blocks AMBIGUOUS_DATE when a date names two meetings", async () => {
			// The unique index covers the exact instant, not the date.
			await seedMeeting(TUESDAY, "07:30");
			await seedMeeting(TUESDAY, "19:00");
			const { plan: p, blocking } = await plan(testDb, club, [
				{ date: TUESDAY, theme: "Harvest" },
			]);
			expect(p.lines).toStrictEqual([]);
			expect(blocking).toHaveLength(1);
			expect(blocking[0]?.code).toBe("AMBIGUOUS_DATE");
			expect(blocking[0]?.entryIndex).toBe(0);
		});

		it("blocks MEETING_LOCKED for a completed meeting", async () => {
			await seedMeeting(TUESDAY, "19:00", { status: "completed" });
			const { blocking } = await plan(testDb, club, [
				{ date: TUESDAY, theme: "Harvest" },
			]);
			expect(blocking).toHaveLength(1);
			expect(blocking[0]?.code).toBe("MEETING_LOCKED");
		});

		it("blocks one date without stopping the others", async () => {
			// A per-date decision. Apply still refuses while anything blocks, but
			// the PLAN shows the reader what would have happened to the rest.
			await seedRule();
			await seedMeeting(TUESDAY, "07:30");
			await seedMeeting(TUESDAY, "19:00");
			const { plan: p, blocking } = await plan(testDb, club, [
				{ date: TUESDAY, theme: "Harvest" },
				{ date: NEXT_TUESDAY, theme: "Autumn" },
			]);
			expect(blocking.map((b) => b.entryIndex)).toStrictEqual([0]);
			expect(p.lines.map((l) => l.index)).toStrictEqual([1]);
		});
	});

	describe("the weekday check", () => {
		it("warns, and does NOT block, a date off the club's usual weekday", async () => {
			await seedRule();
			const { plan: p, blocking } = await plan(testDb, club, [
				{ date: WEDNESDAY, theme: "Special" },
			]);
			expect(blocking).toStrictEqual([]);
			expect(p.lines[0]?.warnings).toContain("weekday_mismatch");
			expect(p.lines[0]?.weekday).toBe("Wednesday");
		});

		it("says nothing when the date is on the rule's weekday", async () => {
			await seedRule();
			const { plan: p } = await plan(testDb, club, [{ date: TUESDAY }]);
			expect(p.lines[0]?.warnings).toStrictEqual([]);
		});

		it("cannot warn when the club has no rule", async () => {
			const { plan: p } = await plan(testDb, club, [
				{ date: WEDNESDAY, time: "19:00" },
			]);
			expect(p.lines[0]?.warnings).toStrictEqual([]);
		});
	});

	describe("the plan hash", () => {
		it("is stable across two identical plans", async () => {
			await seedMeeting(TUESDAY, "19:00", { theme: "Old" });
			const args = [{ date: TUESDAY, theme: "Harvest" }];
			const a = await plan(testDb, club, args);
			const b = await plan(testDb, club, args);
			const hash = (p: typeof a.plan) =>
				agendaPlanHash({
					clubId: club.clubId,
					userId: seed.adminUserId,
					plan: p,
				});
			expect(hash(a.plan)).toBe(hash(b.plan));
		});

		it("moves when the stored value the diff rests on moves", async () => {
			// THE basis of AC9. A concurrent edit to the very field being set
			// changes the `from` side of the diff, so the hash no longer matches.
			const meetingId = await seedMeeting(TUESDAY, "19:00", { theme: "Old" });
			const args = [{ date: TUESDAY, theme: "Harvest" }];
			const before = await plan(testDb, club, args);
			await testDb
				.update(meetings)
				.set({ theme: "Someone else's" })
				.where(eq(meetings.id, meetingId));
			const after = await plan(testDb, club, args);
			const hash = (p: typeof before.plan) =>
				agendaPlanHash({
					clubId: club.clubId,
					userId: seed.adminUserId,
					plan: p,
				});
			expect(hash(after.plan)).not.toBe(hash(before.plan));
		});

		it("is not portable to another user", async () => {
			await seedMeeting(TUESDAY, "19:00");
			const { plan: p } = await plan(testDb, club, [
				{ date: TUESDAY, theme: "Harvest" },
			]);
			expect(
				agendaPlanHash({
					clubId: club.clubId,
					userId: seed.adminUserId,
					plan: p,
				}),
			).not.toBe(
				agendaPlanHash({
					clubId: club.clubId,
					userId: seed.memberUserId,
					plan: p,
				}),
			);
		});
	});
});
