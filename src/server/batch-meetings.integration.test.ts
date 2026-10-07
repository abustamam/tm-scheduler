/**
 * DB-backed tests for batch meeting creation (#184): atomic multi-insert with
 * role slots, same-calendar-date duplicate skipping (idempotent re-run), and
 * transaction rollback on a forced in-transaction failure.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/batch-meetings.integration.test.ts
 */
import { and, eq, gte } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubMeetingRecurrence,
	clubs,
	meetings,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({
		validator: (parse: (input: unknown) => unknown) => ({
			handler:
				(handle: (input: { data: unknown }) => unknown) =>
				({ data }: { data: unknown }) =>
					handle({ data: parse(data) }),
		}),
	}),
}));

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { currentUser } = vi.hoisted(() => ({ currentUser: { id: "" } }));

vi.mock("./guards", async (importOriginal) => ({
	...(await importOriginal<typeof import("./guards")>()),
	requireUser: vi.fn(async () => ({ id: currentUser.id })),
}));

const agenda = await import("#/lib/agenda");
const {
	applyBatchCreateMeetings,
	getMeetingFormDefaultsLogic,
	listClubMeetingDates,
} = await import("./batch-meetings-logic");
const { getMeetingFormDefaults } = await import("./batch-meetings");

const TZ = "America/Chicago";

async function meetingsByLocation(clubId: string, location: string) {
	return testDb
		.select()
		.from(meetings)
		.where(and(eq(meetings.clubId, clubId), eq(meetings.location, location)));
}

async function slotCount(meetingId: string): Promise<number> {
	const rows = await testDb
		.select({ id: roleSlots.id })
		.from(roleSlots)
		.where(eq(roleSlots.meetingId, meetingId));
	return rows.length;
}

describe.skipIf(!hasTestDb)("batch meeting creation", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
		// Known timezone + a non-default length to prove copy-at-insert.
		await testDb
			.update(clubs)
			.set({ timezone: TZ, defaultMeetingMinutes: 60 })
			.where(eq(clubs.id, club.clubId));
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("creates every non-duplicate meeting + role slots in one batch", async () => {
		const res = await applyBatchCreateMeetings({
			clubId: club.clubId,
			wallTimes: ["2027-01-05T19:00", "2027-01-12T19:00", "2027-01-19T19:00"],
			location: "  Community Hall  ",
		});
		expect(res.createdCount).toBe(3);
		expect(res.skippedDates).toEqual([]);

		const created = await meetingsByLocation(club.clubId, "Community Hall");
		expect(created).toHaveLength(3);
		for (const m of created) {
			expect(m.lengthMinutes).toBe(60); // copied from club default
			expect(m.location).toBe("Community Hall"); // trimmed
			expect(m.theme).toBeNull();
			expect(m.wordOfTheDay).toBeNull();
			expect(m.notes).toBeNull();
			expect(await slotCount(m.id)).toBe(1); // one Timer slot from the template
		}
		// scheduledAt is the wall time converted DST-correct for the club tz.
		const jan5 = created.find(
			(m) => utcToZonedWallTime(m.scheduledAt, TZ) === "2027-01-05T19:00",
		);
		expect(jan5?.scheduledAt.toISOString()).toBe(
			zonedWallTimeToUtc("2027-01-05T19:00", TZ).toISOString(),
		);
	});

	it("generates no slots for a disabled role (#368)", async () => {
		// Disable the club's only seeded role definition ("Timer") before the
		// batch reads the template once and reuses it for every created meeting.
		await testDb
			.update(roleDefinitions)
			.set({ enabled: false })
			.where(eq(roleDefinitions.id, club.roleDefinitionId));

		const res = await applyBatchCreateMeetings({
			clubId: club.clubId,
			wallTimes: ["2027-04-06T19:00"],
			location: "Disabled Role Hall",
		});
		expect(res.createdCount).toBe(1);

		const created = await meetingsByLocation(club.clubId, "Disabled Role Hall");
		expect(created).toHaveLength(1);
		expect(await slotCount(created[0].id)).toBe(0);
	});

	it("skips a date that already has a meeting and re-runs idempotently", async () => {
		// The seed meeting sits 7 days out; its local calendar date is 'taken'.
		const [seed] = await testDb
			.select({ scheduledAt: meetings.scheduledAt })
			.from(meetings)
			.where(eq(meetings.id, club.meetingId));
		const takenDate = utcToZonedWallTime(seed.scheduledAt, TZ).slice(0, 10);

		expect(await listClubMeetingDates(club.clubId)).toContain(takenDate);

		const wallTimes = [`${takenDate}T19:00`, "2027-02-02T19:00"];
		const first = await applyBatchCreateMeetings({
			clubId: club.clubId,
			wallTimes,
		});
		expect(first.createdCount).toBe(1); // only the fresh date
		expect(first.skippedDates).toContain(takenDate);

		// Re-running the identical batch creates nothing new (both dates now exist).
		const second = await applyBatchCreateMeetings({
			clubId: club.clubId,
			wallTimes,
		});
		expect(second.createdCount).toBe(0);
		expect(second.skippedDates).toEqual(
			expect.arrayContaining([takenDate, "2027-02-02"]),
		);
	});

	it("rolls back the whole batch when an insert fails mid-transaction", async () => {
		// Force a failure AFTER the first meeting row is inserted (slot generation
		// runs inside the transaction) — the meeting insert must be rolled back.
		vi.spyOn(agenda, "generateSlotRows").mockImplementation(() => {
			throw new Error("forced failure");
		});

		await expect(
			applyBatchCreateMeetings({
				clubId: club.clubId,
				wallTimes: ["2027-03-02T19:00"],
				location: "Rollback Hall",
			}),
		).rejects.toThrow(/forced failure/);

		// Nothing persisted: no meeting at that date, no stray slots.
		const after = await testDb
			.select({ id: meetings.id })
			.from(meetings)
			.where(
				and(
					eq(meetings.clubId, club.clubId),
					gte(meetings.scheduledAt, zonedWallTimeToUtc("2027-03-01T00:00", TZ)),
				),
			);
		expect(after).toHaveLength(0);
	});
});

describe.skipIf(!hasTestDb)("getMeetingFormDefaults (#1086)", () => {
	let club: SeededClub;
	// Friday 2026-10-02 noon in Chicago.
	const NOW = new Date("2026-10-02T17:00:00Z");

	beforeEach(async () => {
		club = await seedClub();
		await testDb
			.update(clubs)
			.set({ timezone: TZ, defaultLocation: "Room 4" })
			.where(eq(clubs.id, club.clubId));
		await testDb.delete(meetings).where(eq(meetings.clubId, club.clubId));
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	async function seedMeeting(wall: string, status: "scheduled" | "cancelled") {
		await testDb.insert(meetings).values({
			clubId: club.clubId,
			scheduledAt: zonedWallTimeToUtc(wall, TZ),
			status,
		});
	}

	it("rule club: rule fields, first occurrence after the latest meeting of any status", async () => {
		await testDb.insert(clubMeetingRecurrence).values({
			clubId: club.clubId,
			mode: "monthly",
			weekday: 4,
			ordinals: ["2", "4"],
			timeOfDay: "18:45",
			location: "Library",
			enabled: false,
		});
		await seedMeeting("2026-12-10T18:45", "cancelled");
		expect(await getMeetingFormDefaultsLogic(club.clubId, NOW)).toEqual({
			mode: "monthly",
			weekday: 4,
			intervalWeeks: 1,
			ordinals: [2, 4],
			timeOfDay: "18:45",
			startDate: "2026-12-24",
			location: "Library",
		});
	});

	it("no rule: the latest meeting's weekday and time, in the club's timezone", async () => {
		// 00:30 UTC on the 5th is still Wednesday the 4th, 18:30 in Chicago.
		await seedMeeting("2026-11-04T18:30", "scheduled");
		expect(await getMeetingFormDefaultsLogic(club.clubId, NOW)).toEqual({
			mode: "interval",
			weekday: 3,
			intervalWeeks: 1,
			ordinals: [2, 4],
			timeOfDay: "18:30",
			startDate: "2026-11-11",
			location: "Room 4",
		});
	});

	it("no rule, no meetings: fallbacks, start date is today in the club's timezone", async () => {
		// 03:00 UTC on the 3rd is still the 2nd in Chicago.
		const late = new Date("2026-10-03T03:00:00Z");
		const d = await getMeetingFormDefaultsLogic(club.clubId, late);
		expect(d).toMatchObject({
			weekday: 2,
			timeOfDay: "19:00",
			startDate: "2026-10-02",
			location: "Room 4",
		});
	});

	it("refuses a user who is not an admin viewer of the club", async () => {
		currentUser.id = club.memberUserId;
		await expect(getMeetingFormDefaults({ data: club.clubId })).rejects.toThrow(
			"You don't have permission to view this club.",
		);
		currentUser.id = club.adminUserId;
		await expect(
			getMeetingFormDefaults({ data: club.clubId }),
		).resolves.toMatchObject({ location: "Room 4" });
	});
});
