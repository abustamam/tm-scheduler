/**
 * DB-backed tests for the club default video-call link (#1534): copy-at-insert
 * on every creation path, the pristine classifier, and "Apply to upcoming".
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubMeetingRecurrence, clubs, meetings } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { ensureScheduleToppedUp } = await import("./schedule-topup-logic");
const { applyBatchCreateMeetings } = await import("./batch-meetings-logic");
const { applyCreateMeeting } = await import("./meetings-logic");
const { classifyMeetings } = await import("./recurrence-rule-logic");
const {
	applyClubProfileUpdate,
	applyDefaultJoinUrlToUpcoming,
	clubProfileSchema,
	countUpcomingMeetingsWithoutJoinUrl,
	getClubProfile,
} = await import("./clubs-logic");

const DEFAULT = "https://zoom.example/j/club-default";
const NOW = new Date("2026-06-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

async function joinUrlsOf(clubId: string) {
	const rows = await testDb
		.select({ joinUrl: meetings.joinUrl })
		.from(meetings)
		.where(eq(meetings.clubId, clubId));
	return rows.map((r) => r.joinUrl);
}

async function addMeeting(
	clubId: string,
	daysOut: number,
	extra: Partial<typeof meetings.$inferInsert> = {},
) {
	const [m] = await testDb
		.insert(meetings)
		.values({
			clubId,
			scheduledAt: new Date(NOW.getTime() + daysOut * DAY),
			status: "scheduled",
			...extra,
		})
		.returning({ id: meetings.id });
	return m.id;
}

describe("club profile schema (#1534)", () => {
	const base = { clubId: "11111111-1111-4111-8111-111111111111" };

	it("normalizes a bare host, clears on blank, leaves omitted undefined", () => {
		expect(
			clubProfileSchema.parse({ ...base, defaultJoinUrl: "zoom.us/j/123" })
				.defaultJoinUrl,
		).toBe("https://zoom.us/j/123");
		expect(
			clubProfileSchema.parse({ ...base, defaultJoinUrl: "  " }).defaultJoinUrl,
		).toBeNull();
		expect(clubProfileSchema.parse(base).defaultJoinUrl).toBeUndefined();
	});

	it("refuses text that is not a link rather than storing null", () => {
		expect(() =>
			clubProfileSchema.parse({ ...base, defaultJoinUrl: "tbd" }),
		).toThrow();
		expect(() =>
			clubProfileSchema.parse({
				...base,
				defaultJoinUrl: "javascript:alert(1)",
			}),
		).toThrow();
	});
});

describe.skipIf(!hasTestDb)("club default video-call link (#1534)", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
		await testDb
			.update(clubs)
			.set({ timezone: "America/Chicago", defaultJoinUrl: DEFAULT })
			.where(eq(clubs.id, club.clubId));
		await testDb.delete(meetings).where(eq(meetings.clubId, club.clubId));
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("profile update stores it, omitted leaves it, blank clears it", async () => {
		await applyClubProfileUpdate(
			clubProfileSchema.parse({
				clubId: club.clubId,
				defaultJoinUrl: "zoom.us/j/9",
			}),
		);
		expect((await getClubProfile(club.clubId))?.defaultJoinUrl).toBe(
			"https://zoom.us/j/9",
		);
		await applyClubProfileUpdate(
			clubProfileSchema.parse({ clubId: club.clubId }),
		);
		expect((await getClubProfile(club.clubId))?.defaultJoinUrl).toBe(
			"https://zoom.us/j/9",
		);
		await applyClubProfileUpdate(
			clubProfileSchema.parse({ clubId: club.clubId, defaultJoinUrl: "" }),
		);
		expect((await getClubProfile(club.clubId))?.defaultJoinUrl).toBeNull();
	});

	it("top-up copies the default onto meetings it creates", async () => {
		await testDb.insert(clubMeetingRecurrence).values({
			clubId: club.clubId,
			mode: "interval",
			weekday: 4,
			intervalWeeks: 1,
			anchorDate: "2026-01-01",
			timeOfDay: "18:45",
			keepAhead: 3,
			enabled: true,
		});
		const { created } = await ensureScheduleToppedUp(club.clubId, NOW);
		expect(created).toBe(3);
		expect(await joinUrlsOf(club.clubId)).toEqual([DEFAULT, DEFAULT, DEFAULT]);
	});

	it("top-up writes null when the club has no default", async () => {
		await testDb
			.update(clubs)
			.set({ defaultJoinUrl: null })
			.where(eq(clubs.id, club.clubId));
		await testDb.insert(clubMeetingRecurrence).values({
			clubId: club.clubId,
			mode: "interval",
			weekday: 4,
			intervalWeeks: 1,
			anchorDate: "2026-01-01",
			timeOfDay: "18:45",
			keepAhead: 2,
			enabled: true,
		});
		await ensureScheduleToppedUp(club.clubId, NOW);
		expect(await joinUrlsOf(club.clubId)).toEqual([null, null]);
	});

	it("batch create copies the default", async () => {
		await applyBatchCreateMeetings({
			clubId: club.clubId,
			wallTimes: ["2027-01-05T19:00", "2027-01-12T19:00"],
			location: "Hall",
		});
		expect(await joinUrlsOf(club.clubId)).toEqual([DEFAULT, DEFAULT]);
	});

	it("single create: omitted gets the default, explicit blank stays null, explicit value wins", async () => {
		await applyCreateMeeting({
			clubId: club.clubId,
			scheduledAt: "2027-02-02T19:00",
		});
		await applyCreateMeeting({
			clubId: club.clubId,
			scheduledAt: "2027-02-09T19:00",
			joinUrl: "",
		});
		await applyCreateMeeting({
			clubId: club.clubId,
			scheduledAt: "2027-02-16T19:00",
			joinUrl: "https://meet.example/own",
		});
		const rows = await testDb
			.select({ at: meetings.scheduledAt, joinUrl: meetings.joinUrl })
			.from(meetings)
			.where(eq(meetings.clubId, club.clubId))
			.orderBy(meetings.scheduledAt);
		expect(rows.map((r) => r.joinUrl)).toEqual([
			DEFAULT,
			null,
			"https://meet.example/own",
		]);
	});

	describe("classifyMeetings", () => {
		it("a meeting carrying the club default is untouched (the state top-up leaves)", async () => {
			const id = await addMeeting(club.clubId, 30, {
				lengthMinutes: 60,
				joinUrl: DEFAULT,
			});
			await testDb
				.update(clubs)
				.set({ defaultMeetingMinutes: 60 })
				.where(eq(clubs.id, club.clubId));
			const result = await classifyMeetings([id]);
			expect(result.get(id)).toBeNull();
		});

		it("a meeting with a link of its own is kept as defaults_differ", async () => {
			await testDb
				.update(clubs)
				.set({ defaultMeetingMinutes: 60 })
				.where(eq(clubs.id, club.clubId));
			const id = await addMeeting(club.clubId, 31, {
				lengthMinutes: 60,
				joinUrl: "https://meet.example/own",
			});
			expect((await classifyMeetings([id])).get(id)).toBe("defaults_differ");
		});

		it("a meeting with a NULL link, from before the default was set, is untouched (#1534 review)", async () => {
			// The state the bug left behind: the meeting was auto-created while the
			// club had no default, THEN the admin saved one. The meeting never
			// carried the default, but nobody touched it either.
			await testDb
				.update(clubs)
				.set({ defaultMeetingMinutes: 60 })
				.where(eq(clubs.id, club.clubId));
			const id = await addMeeting(club.clubId, 33, {
				lengthMinutes: 60,
				joinUrl: null,
			});
			expect((await classifyMeetings([id])).get(id)).toBeNull();
		});

		it("with no club default, any link is still a per-meeting override", async () => {
			await testDb
				.update(clubs)
				.set({ defaultMeetingMinutes: 60, defaultJoinUrl: null })
				.where(eq(clubs.id, club.clubId));
			const id = await addMeeting(club.clubId, 32, {
				lengthMinutes: 60,
				joinUrl: DEFAULT,
			});
			expect((await classifyMeetings([id])).get(id)).toBe("defaults_differ");
		});
	});

	describe("apply to upcoming meetings", () => {
		it("counts and writes only future, non-cancelled meetings with no link, and never overwrites", async () => {
			const real = new Date();
			const at = (days: number) => new Date(real.getTime() + days * DAY);
			const mk = async (
				days: number,
				extra: Partial<typeof meetings.$inferInsert> = {},
			) => {
				const [m] = await testDb
					.insert(meetings)
					.values({
						clubId: club.clubId,
						scheduledAt: at(days),
						status: "scheduled",
						...extra,
					})
					.returning({ id: meetings.id });
				return m.id;
			};
			const target = await mk(10);
			const target2 = await mk(11);
			const hasLink = await mk(12, { joinUrl: "https://meet.example/own" });
			const cancelled = await mk(13, { status: "cancelled" });
			const past = await mk(-10);

			expect(await countUpcomingMeetingsWithoutJoinUrl(club.clubId)).toBe(2);
			const { updated } = await applyDefaultJoinUrlToUpcoming(club.clubId);
			expect(updated).toBe(2);
			expect(await countUpcomingMeetingsWithoutJoinUrl(club.clubId)).toBe(0);

			const link = async (id: string) =>
				(
					await testDb
						.select({ j: meetings.joinUrl })
						.from(meetings)
						.where(eq(meetings.id, id))
				)[0].j;
			expect(await link(target)).toBe(DEFAULT);
			expect(await link(target2)).toBe(DEFAULT);
			expect(await link(hasLink)).toBe("https://meet.example/own");
			expect(await link(cancelled)).toBeNull();
			expect(await link(past)).toBeNull();
		});

		it("writes nothing when the club has no default", async () => {
			await testDb
				.update(clubs)
				.set({ defaultJoinUrl: null })
				.where(eq(clubs.id, club.clubId));
			await testDb.insert(meetings).values({
				clubId: club.clubId,
				scheduledAt: new Date(Date.now() + 5 * DAY),
				status: "scheduled",
			});
			expect(await applyDefaultJoinUrlToUpcoming(club.clubId)).toEqual({
				updated: 0,
			});
		});
	});
});
