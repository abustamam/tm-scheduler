/**
 * DB-backed tests for the club timezone setting (#547) — the writer, and what
 * changing it does to meetings that already exist.
 *
 * The second half is the part the issue asked for explicitly. A club's URL date
 * keys are not stored anywhere: `meetingUrlKey` derives them from the club's
 * CURRENT timezone on the way out, and `resolveMeetingKey` re-derives them on
 * the way back in. So changing the column silently re-labels every existing
 * meeting. These tests pin that as the chosen behaviour rather than leaving it
 * to be discovered in production — including the sharpest form, where a
 * bare-date key keeps resolving and starts pointing at a DIFFERENT meeting.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/club-timezone.integration.test.ts
 */

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meetings } from "#/db/schema";
import { DEFAULT_CLUB_TIMEZONE } from "#/lib/club-timezone";
import { zonedWallTimeToUtc } from "#/lib/datetime";
import { urlKeysForMeetings } from "#/lib/meeting-url";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";
import {
	applyClubTimezoneUpdate,
	clubTimezoneSchema,
	getClubAgendaSettings,
	getClubProfile,
	getClubTimezoneSettings,
} from "./clubs-logic";
import { resolveMeetingKey } from "./meeting-resolve-logic";
import { applyCreateMeeting } from "./meetings-logic";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

/** UTC-5 in March (CDT). */
const CHICAGO = "America/Chicago";
/** UTC+9, no DST — 14 hours ahead of CDT, so it crosses the date line for any
 *  evening Chicago meeting. */
const TOKYO = "Asia/Tokyo";

describe.skipIf(!hasTestDb)("club timezone setting (#547)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("reports the column default for a club nobody has set", async () => {
		const settings = await getClubTimezoneSettings(seed.clubId);
		expect(settings.timezone).toBe(DEFAULT_CLUB_TIMEZONE);
	});

	it("round-trips a saved zone", async () => {
		await applyClubTimezoneUpdate({ clubId: seed.clubId, timezone: TOKYO });
		expect((await getClubTimezoneSettings(seed.clubId)).timezone).toBe(TOKYO);

		await applyClubTimezoneUpdate({ clubId: seed.clubId, timezone: CHICAGO });
		expect((await getClubTimezoneSettings(seed.clubId)).timezone).toBe(CHICAGO);
	});

	it("ships a zone list that contains the club's own value, so the picker can display it", async () => {
		await applyClubTimezoneUpdate({ clubId: seed.clubId, timezone: TOKYO });
		const settings = await getClubTimezoneSettings(seed.clubId);
		// A select whose options omit the stored value silently renders its FIRST
		// option instead — the club would look like it were in Africa/Abidjan.
		expect(settings.zones).toContain(settings.timezone);
	});

	it("reads the default for a club that does not exist, rather than throwing", async () => {
		const settings = await getClubTimezoneSettings(
			"00000000-0000-0000-0000-000000000000",
		);
		expect(settings.timezone).toBe(DEFAULT_CLUB_TIMEZONE);
	});

	it("throws when updating a club that does not exist", async () => {
		await expect(
			applyClubTimezoneUpdate({
				clubId: "00000000-0000-0000-0000-000000000000",
				timezone: TOKYO,
			}),
		).rejects.toThrow("Club not found.");
	});

	it("does not disturb the profile or agenda settings", async () => {
		await applyClubTimezoneUpdate({ clubId: seed.clubId, timezone: TOKYO });
		const profile = await getClubProfile(seed.clubId);
		expect(profile).toMatchObject({ district: null, mission: null });
		expect(await getClubAgendaSettings(seed.clubId)).toEqual({
			geIntroducesFunctionaries: false,
		});
	});

	// -------------------------------------------------------------------------
	// Server-side validation. The server fn is addressable with no form, so the
	// picker constrains nobody — the schema is the only thing that does.
	// -------------------------------------------------------------------------

	it("rejects an unknown zone through the schema the server fn parses with", () => {
		for (const bad of ["", "Mars/Olympus_Mons", "america/chicago", "+05:30"]) {
			const parsed = clubTimezoneSchema.safeParse({
				clubId: seed.clubId,
				timezone: bad,
			});
			expect(
				parsed.success,
				`expected ${JSON.stringify(bad)} to be rejected`,
			).toBe(false);
		}
	});

	it("accepts a real zone through that same schema", () => {
		const parsed = clubTimezoneSchema.safeParse({
			clubId: seed.clubId,
			timezone: TOKYO,
		});
		expect(parsed.success).toBe(true);
	});

	it("never stores a rejected zone, so the datetime helpers cannot be poisoned", async () => {
		// Belt-and-braces on the criterion "rejected even if the client sends it
		// directly": prove the column still holds a resolvable zone afterwards.
		const parsed = clubTimezoneSchema.safeParse({
			clubId: seed.clubId,
			timezone: "Mars/Olympus_Mons",
		});
		expect(parsed.success).toBe(false);
		const after = await getClubTimezoneSettings(seed.clubId);
		expect(() =>
			zonedWallTimeToUtc("2026-06-15T19:00", after.timezone),
		).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// What the change does to meetings that already exist. THE ANSWER: their
	// instants do not move, their URL date keys DO.
	// -------------------------------------------------------------------------

	describe("existing meetings", () => {
		/** 2026-03-09 20:30 in Chicago (CDT, UTC-5) = 2026-03-10 10:30 in Tokyo. */
		const INSTANT = new Date("2026-03-10T01:30:00.000Z");
		let meetingId: string;

		beforeEach(async () => {
			await applyClubTimezoneUpdate({ clubId: seed.clubId, timezone: CHICAGO });
			const [row] = await testDb
				.insert(meetings)
				.values({
					clubId: seed.clubId,
					scheduledAt: INSTANT,
					status: "scheduled",
				})
				.returning({ id: meetings.id });
			if (!row) throw new Error("failed to insert meeting");
			meetingId = row.id;
		});

		it("does not move the stored instant", async () => {
			await applyClubTimezoneUpdate({ clubId: seed.clubId, timezone: TOKYO });
			const row = await testDb.query.meetings.findFirst({
				where: eq(meetings.id, meetingId),
				columns: { scheduledAt: true },
			});
			expect(row?.scheduledAt.toISOString()).toBe(INSTANT.toISOString());
		});

		it("SHIFTS the URL date key — this is the chosen behaviour, not a bug", async () => {
			const keyIn = (tz: string) =>
				urlKeysForMeetings([{ id: meetingId, scheduledAt: INSTANT }], tz).get(
					meetingId,
				);
			// Absolute, not relative: the point is which calendar day each zone
			// puts this instant on, and asserting "they differ" would also pass if
			// both were wrong.
			expect(keyIn(CHICAGO)).toBe("2026-03-09");
			expect(keyIn(TOKYO)).toBe("2026-03-10");
		});

		it("stops resolving the old dated link and starts resolving the new one", async () => {
			expect(await resolveMeetingKey(seed.clubId, "2026-03-09")).toBe(
				meetingId,
			);
			expect(await resolveMeetingKey(seed.clubId, "2026-03-10")).toBeNull();

			await applyClubTimezoneUpdate({ clubId: seed.clubId, timezone: TOKYO });

			// A link shared before the change is now a 404. Accepted: pinning it
			// would mean storing a key, and a club fixing a wrong zone WANTS its
			// dates corrected.
			expect(await resolveMeetingKey(seed.clubId, "2026-03-09")).toBeNull();
			expect(await resolveMeetingKey(seed.clubId, "2026-03-10")).toBe(
				meetingId,
			);
		});

		it("keeps the uuid form of the key stable across the change", async () => {
			expect(await resolveMeetingKey(seed.clubId, meetingId)).toBe(meetingId);
			await applyClubTimezoneUpdate({ clubId: seed.clubId, timezone: TOKYO });
			// The durable link. Worth pinning because it is the mitigation the
			// behaviour above rests on.
			expect(await resolveMeetingKey(seed.clubId, meetingId)).toBe(meetingId);
		});

		it("can point one unchanged dated link at a DIFFERENT meeting", async () => {
			// 2026-03-10 09:00 in Chicago; 2026-03-10 23:00 in Tokyo. So in Chicago
			// the two meetings sit on different local days and `2026-03-10` names
			// this one; in Tokyo they collide on one local day and the bare-date
			// key resolves to the EARLIEST, which is the other one.
			const [second] = await testDb
				.insert(meetings)
				.values({
					clubId: seed.clubId,
					scheduledAt: new Date("2026-03-10T14:00:00.000Z"),
					status: "scheduled",
				})
				.returning({ id: meetings.id });
			if (!second) throw new Error("failed to insert second meeting");

			expect(await resolveMeetingKey(seed.clubId, "2026-03-10")).toBe(
				second.id,
			);

			await applyClubTimezoneUpdate({ clubId: seed.clubId, timezone: TOKYO });

			// Same URL, still resolves, different meeting. This is the failure mode
			// the settings copy warns about and the reason the uuid form exists.
			expect(await resolveMeetingKey(seed.clubId, "2026-03-10")).toBe(
				meetingId,
			);
		});
	});

	// -------------------------------------------------------------------------
	// And what it does to meetings created AFTERWARDS.
	// -------------------------------------------------------------------------

	it("interprets a new meeting's wall-clock input in the newly-saved zone", async () => {
		await applyClubTimezoneUpdate({ clubId: seed.clubId, timezone: TOKYO });
		const { meetingId } = await applyCreateMeeting({
			clubId: seed.clubId,
			scheduledAt: "2026-06-15T19:00",
		});
		const row = await testDb.query.meetings.findFirst({
			where: eq(meetings.id, meetingId),
			columns: { scheduledAt: true },
		});
		// 19:00 in Tokyo is 10:00Z. Absolute, so a bug that ignored the column and
		// used the default would fail rather than agree with a relative check.
		expect(row?.scheduledAt.toISOString()).toBe("2026-06-15T10:00:00.000Z");
		expect(row?.scheduledAt.toISOString()).not.toBe(
			zonedWallTimeToUtc("2026-06-15T19:00", CHICAGO).toISOString(),
		);
	});
});
