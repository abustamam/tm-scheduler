/**
 * Generated og:image cards (#1411): the version hash, the input builders, the
 * privacy allow-list and the renderer. Builders run against the real schema
 * (`TEST_DATABASE_URL`); the version, allow-list and render tests need none.
 */
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubLogos, clubs, meetings } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	CLUB_CARD_KEYS,
	MEETING_CARD_KEYS,
	loadClubCardInput,
	loadMeetingCardInput,
	ogCardVersion,
	renderOgCard,
} = await import("#/server/og-card-logic");
type MeetingCardInput = import("#/server/og-card-logic").MeetingCardInput;
type ClubCardInput = import("#/server/og-card-logic").ClubCardInput;

const CLUB_ID = "11111111-1111-4111-8111-111111111111";
const meetingInput: MeetingCardInput = {
	kind: "meeting",
	clubId: CLUB_ID,
	meetingId: "22222222-2222-4222-8222-222222222222",
	clubName: "Demo Club",
	logoVersion: null,
	scheduledAt: "2026-11-05T19:00:00.000Z",
	timezone: "America/Los_Angeles",
	theme: "Finding your voice",
	word: "resilient",
	location: "Room 12",
	online: false,
	status: "scheduled",
};
const clubInput: ClubCardInput = {
	kind: "club",
	clubId: CLUB_ID,
	clubName: "Demo Club",
	logoVersion: null,
	timezone: "America/Los_Angeles",
	nextScheduledAt: "2026-11-05T19:00:00.000Z",
	nextTheme: "Finding your voice",
};

function pngSize(png: Buffer): { w: number; h: number } {
	expect(png.subarray(1, 4).toString()).toBe("PNG");
	return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

describe("ogCardVersion", () => {
	// protects=the ?v= and ETag are stable for an unchanged card;
	// fails_when=the hash depends on key order or the clock;
	// no_claim=says nothing about which fields the builders include.
	it("gives equal versions for equal inputs, whatever the key order", () => {
		const reordered = Object.fromEntries(
			Object.entries(meetingInput).reverse(),
		) as MeetingCardInput;
		expect(ogCardVersion(reordered)).toBe(ogCardVersion({ ...meetingInput }));
		expect(ogCardVersion(meetingInput)).toMatch(/^[0-9a-f]{12}$/);
	});

	// protects=a share link's image refreshes when any displayed field changes,
	// and a meeting card never shares a version with a club card;
	// fails_when=a field (kind included) is dropped from the hash;
	// no_claim=does not show the endpoint serves the new bytes.
	it("changes when any one field changes, kind included", () => {
		const base = ogCardVersion(meetingInput);
		const changes: Partial<MeetingCardInput>[] = [
			{ clubId: "33333333-3333-4333-8333-333333333333" },
			{ meetingId: "44444444-4444-4444-8444-444444444444" },
			{ clubName: "Other" },
			{ logoVersion: "1" },
			{ scheduledAt: "2026-11-06T19:00:00.000Z" },
			{ timezone: "UTC" },
			{ theme: "Other theme" },
			{ word: "other" },
			{ location: "Room 13" },
			{ online: true },
			{ status: "cancelled" },
		];
		for (const change of changes) {
			expect(ogCardVersion({ ...meetingInput, ...change })).not.toBe(base);
		}
		const sameShape = { ...clubInput, clubName: "Demo Club" };
		expect(ogCardVersion(sameShape)).not.toBe(base);
		expect(
			ogCardVersion({
				...clubInput,
				kind: "meeting",
			} as unknown as MeetingCardInput),
		).not.toBe(ogCardVersion(clubInput));
	});
});

describe("privacy allow-list", () => {
	// protects=a card input can never carry a person, role or count;
	// fails_when=a key is added to either input type or builder output;
	// no_claim=does not read the PNG; the imports test covers the reads.
	it("pins the exact input keys", () => {
		expect(Object.keys(meetingInput).sort()).toEqual(
			[...MEETING_CARD_KEYS].sort(),
		);
		expect(Object.keys(clubInput).sort()).toEqual([...CLUB_CARD_KEYS].sort());
		expect([...MEETING_CARD_KEYS].sort()).toEqual([
			"clubId",
			"clubName",
			"kind",
			"location",
			"logoVersion",
			"meetingId",
			"online",
			"scheduledAt",
			"status",
			"theme",
			"timezone",
			"word",
		]);
		expect([...CLUB_CARD_KEYS].sort()).toEqual([
			"clubId",
			"clubName",
			"kind",
			"logoVersion",
			"nextScheduledAt",
			"nextTheme",
			"timezone",
		]);
	});

	// protects=the roll stays out of the card's reads: only clubs, meetings and
	// the club-logo table, and not the summary that names people;
	// fails_when=the module imports a people/slot/attendance table or
	// next-meeting-summary-logic;
	// no_claim=a static check of this module, not of the modules it calls.
	it("imports no people, slot or attendance source", () => {
		const src = readFileSync("src/server/og-card-logic.ts", "utf8");
		expect(src).not.toMatch(/from "[^"]*next-meeting-summary-logic"/);
		const schemaImports = [
			...src.matchAll(/import \{([^}]*)\} from "#\/db\/schema"/g),
		].flatMap((m) => m[1].split(",").map((s) => s.trim()));
		expect(schemaImports).toEqual(["clubs"]);
	});
});

describe.skipIf(!hasTestDb)("input builders", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	// protects=every key of the meeting input comes from the club and meeting;
	// fails_when=a key is missing or the status/theme are not the row's own;
	// no_claim=does not render.
	it("meeting: no theme reads as null, a blank theme too", async () => {
		await testDb
			.update(meetings)
			.set({ theme: "   " })
			.where(eq(meetings.id, seed.meetingId));
		const input = await loadMeetingCardInput(seed.clubId, seed.meetingId);
		expect(input?.theme).toBeNull();
		expect(Object.keys(input ?? {}).sort()).toEqual(
			[...MEETING_CARD_KEYS].sort(),
		);
	});

	// protects=a cancelled meeting's card can say so; fails_when=status lost.
	it("meeting: cancelled", async () => {
		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, seed.meetingId));
		expect(
			(await loadMeetingCardInput(seed.clubId, seed.meetingId))?.status,
		).toBe("cancelled");
	});

	// protects=no logo means the GavelUp mark; fails_when=a stale version leaks.
	it("meeting: no logo has a null logo version", async () => {
		expect(
			(await loadMeetingCardInput(seed.clubId, seed.meetingId))?.logoVersion,
		).toBeNull();
	});

	// protects=online is a boolean and the join link never enters the input;
	// fails_when=the link's value is in the input.
	it("meeting: online, without the join link", async () => {
		const room = "https://zoom.example/j/secret-room";
		await testDb
			.update(meetings)
			.set({ joinUrl: room })
			.where(eq(meetings.id, seed.meetingId));
		const input = await loadMeetingCardInput(seed.clubId, seed.meetingId);
		expect(input?.online).toBe(true);
		expect(JSON.stringify(input)).not.toContain(room);
	});

	// protects=a club with nothing scheduled still gets a card; with a logo the
	// version follows it; fails_when=nextScheduledAt is not null.
	it("club: no upcoming meeting, then a logo", async () => {
		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.clubId, seed.clubId));
		const none = await loadClubCardInput(seed.clubId);
		expect(none?.nextScheduledAt).toBeNull();
		expect(none?.nextTheme).toBeNull();
		expect(none?.logoVersion).toBeNull();
		await testDb.insert(clubLogos).values({
			clubId: seed.clubId,
			bytes: readFileSync("public/logo192.png"),
			mime: "image/png",
			updatedAt: new Date(1_700_000_000_000),
			attestedBy: seed.adminUserId,
			attestedAt: new Date(),
		});
		expect((await loadClubCardInput(seed.clubId))?.logoVersion).toBe(
			"1700000000000",
		);
		expect(
			Object.keys((await loadClubCardInput(seed.clubId)) ?? {}).sort(),
		).toEqual([...CLUB_CARD_KEYS].sort());
	});

	// protects=an archived or non-uuid club yields no card input;
	// fails_when=the gate is skipped.
	it("club and meeting: archived or malformed ids are null", async () => {
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));
		expect(await loadClubCardInput(seed.clubId)).toBeNull();
		expect(await loadMeetingCardInput(seed.clubId, seed.meetingId)).toBeNull();
		expect(await loadClubCardInput("not-a-uuid")).toBeNull();
	});
});

describe("renderOgCard", () => {
	// protects=an over-long theme still renders a 1200x630 card;
	// fails_when=satori throws or the canvas grows; no_claim=not the pixels.
	it("renders a 200-character theme at 1200x630", async () => {
		const png = await renderOgCard({ ...meetingInput, theme: "T".repeat(200) });
		expect(pngSize(png)).toEqual({ w: 1200, h: 630 });
	});

	// protects=no logo renders (the GavelUp mark); fails_when=the mark fails.
	it("renders with no logo, meeting and club", async () => {
		expect(pngSize(await renderOgCard(meetingInput))).toEqual({
			w: 1200,
			h: 630,
		});
		expect(pngSize(await renderOgCard(clubInput))).toEqual({ w: 1200, h: 630 });
		expect(
			pngSize(
				await renderOgCard({
					...clubInput,
					nextScheduledAt: null,
					nextTheme: null,
				}),
			),
		).toEqual({ w: 1200, h: 630 });
	});

	// protects=the cancelled card renders and differs from the live one;
	// fails_when=the stamp is not drawn; no_claim=not that it reads "Cancelled".
	it("renders a cancelled card that differs from the live card", async () => {
		const live = await renderOgCard(meetingInput);
		const cancelled = await renderOgCard({
			...meetingInput,
			status: "cancelled",
		});
		expect(pngSize(cancelled)).toEqual({ w: 1200, h: 630 });
		expect(cancelled.equals(live)).toBe(false);
	});
});
