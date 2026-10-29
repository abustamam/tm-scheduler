/**
 * Generated og:image cards (#1411): the version hash, the input builders, the
 * privacy allow-list and the renderer. Builders run against the real schema
 * (`TEST_DATABASE_URL`); the version, allow-list and render tests need none.
 */
import { createHash } from "node:crypto";
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
import { readSource } from "#/test/guard-source";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	CLUB_CARD_KEYS,
	FAILED_RENDER_TTL_MS,
	LRU_MAX,
	MEETING_CARD_KEYS,
	OG_RENDERER_REVISION,
	clearOgCardCache,
	ogCardCacheSize,
	respondOgCard,
	loadPublicClubCardInput,
	loadPublicMeetingCardInput,
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
		// Comment-blind: a comment naming a forbidden import neither fails nor
		// satisfies this.
		const src = readSource("src/server/og-card-logic.ts");
		const specifiers = [
			...src.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g),
		].map((m) => m[1]);
		expect(specifiers.some((f) => /next-meeting-summary-logic/.test(f))).toBe(
			false,
		);
		// The schema may be reached by alias OR relative path, named or `* as`.
		const schemaStmts = [
			...src.matchAll(
				/(?:import|export)\s[^;]*?from\s+["'](?:#\/db\/schema|(?:\.{1,2}\/)+db\/schema)["']/g,
			),
		].map((m) => m[0]);
		expect(schemaStmts.every((t) => !/\*\s*as\s/.test(t))).toBe(true);
		const named = schemaStmts
			.flatMap((t) => /\{([^}]*)\}/.exec(t)?.[1].split(",") ?? [])
			.map((n) => n.replace(/^\s*type\s+/, "").trim())
			.filter(Boolean);
		expect(named.sort()).toEqual(["clubs", "meetingStatusEnum"]);
		for (const forbidden of [
			"people",
			"attendance",
			"slot",
			"assign",
			"rsvp",
			"guest",
		]) {
			expect(specifiers.some((f) => f.includes(forbidden))).toBe(false);
		}
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
		const input = await loadPublicMeetingCardInput(seed.clubId, seed.meetingId);
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
			(await loadPublicMeetingCardInput(seed.clubId, seed.meetingId))?.status,
		).toBe("cancelled");
	});

	// protects=no logo means the GavelUp mark; fails_when=a stale version leaks.
	it("meeting: no logo has a null logo version", async () => {
		expect(
			(await loadPublicMeetingCardInput(seed.clubId, seed.meetingId))
				?.logoVersion,
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
		const input = await loadPublicMeetingCardInput(seed.clubId, seed.meetingId);
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
		const none = await loadPublicClubCardInput(seed.clubId);
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
		expect((await loadPublicClubCardInput(seed.clubId))?.logoVersion).toBe(
			"1700000000000",
		);
		expect(
			Object.keys((await loadPublicClubCardInput(seed.clubId)) ?? {}).sort(),
		).toEqual([...CLUB_CARD_KEYS].sort());
	});

	// protects=an archived or non-uuid club yields no card input;
	// fails_when=the gate is skipped.
	it("club and meeting: archived or malformed ids are null", async () => {
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));
		expect(await loadPublicClubCardInput(seed.clubId)).toBeNull();
		expect(
			await loadPublicMeetingCardInput(seed.clubId, seed.meetingId),
		).toBeNull();
		expect(await loadPublicClubCardInput("not-a-uuid")).toBeNull();
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

describe("ogCardVersion includes the renderer revision", () => {
	// protects=a layout/font/locale change invalidates every cached card and
	// ETag; fails_when=the revision is left out of the hash;
	// no_claim=does not prove anyone bumps it.
	it("hashes the revision, not just the input", () => {
		const keys = Object.entries(meetingInput).sort(([a], [b]) =>
			a < b ? -1 : 1,
		);
		const without = createHash("sha256")
			.update(JSON.stringify(Object.fromEntries(keys)))
			.digest("hex")
			.slice(0, 12);
		const withRev = createHash("sha256")
			.update(
				JSON.stringify(
					Object.fromEntries(
						Object.entries({
							rendererRevision: OG_RENDERER_REVISION,
							...meetingInput,
						}).sort(([a], [b]) => (a < b ? -1 : 1)),
					),
				),
			)
			.digest("hex")
			.slice(0, 12);
		expect(ogCardVersion(meetingInput)).toBe(withRev);
		expect(ogCardVersion(meetingInput)).not.toBe(without);
	});
});

describe("respondOgCard cache and single-flight", () => {
	const png = (n: number) => Buffer.from(`png-${n}`);
	const withName = (n: number | string): MeetingCardInput => ({
		...meetingInput,
		clubName: `Club ${n}`,
	});
	const get = (
		input: MeetingCardInput,
		render: (i: import("#/server/og-card-logic").OgCardInput) => Promise<{
			png: Buffer;
			version: string;
		}>,
	) =>
		respondOgCard(
			async () => input,
			new Request("http://x/api/og/meeting/a/b.png"),
			render,
		);
	beforeEach(() => clearOgCardCache());

	// protects=N concurrent requests for one cold card render it ONCE, and all
	// get the same bytes; fails_when=each request rasterises on its own, which
	// on one Node process is an event-loop exhaustion vector;
	// no_claim=says nothing about distinct cards.
	it("renders a cold card exactly once for 25 concurrent requests", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const render = vi.fn(async (i: { clubName: string }) => {
			await gate;
			return { png: png(1), version: `v-${i.clubName}` };
		});
		const inflight = Array.from({ length: 25 }, () =>
			get(withName("one"), render),
		);
		// Let every request reach the pending render before it resolves.
		await new Promise((r) => setTimeout(r, 20));
		release();
		const res = await Promise.all(inflight);
		expect(render).toHaveBeenCalledTimes(1);
		for (const r of res) {
			expect(r.status).toBe(200);
			expect(Buffer.from(await r.arrayBuffer()).equals(png(1))).toBe(true);
		}
		// And the next request is a cache hit.
		await get(withName("one"), render);
		expect(render).toHaveBeenCalledTimes(1);
	});

	// protects=the LRU holds at most LRU_MAX cards and evicts the OLDEST;
	// fails_when=the cap is lost (unbounded memory) or the newest is evicted;
	// no_claim=the constant's value is not pinned, only its meaning.
	it("never holds more than LRU_MAX cards and evicts the oldest", async () => {
		const render = vi.fn(async (i: { clubName: string }) => ({
			png: png(0),
			version: i.clubName,
		}));
		for (let n = 0; n < LRU_MAX + 1; n++) await get(withName(n), render);
		expect(render).toHaveBeenCalledTimes(LRU_MAX + 1);
		expect(ogCardCacheSize()).toBe(LRU_MAX);
		await get(withName(LRU_MAX), render); // newest: still cached
		expect(render).toHaveBeenCalledTimes(LRU_MAX + 1);
		await get(withName(0), render); // oldest: evicted, renders again
		expect(render).toHaveBeenCalledTimes(LRU_MAX + 2);
	});

	// protects=a card that fails to render is not retried on every hit for
	// FAILED_RENDER_TTL_MS, and recovers after it;
	// fails_when=every request re-runs the failing render;
	// no_claim=says nothing about what the fallback looks like.
	it("serves the fallback without re-rendering inside the failure window", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.useFakeTimers();
		try {
			const render = vi.fn(async () => {
				throw new Error("boom");
			});
			for (let i = 0; i < 3; i++) {
				const r = await get(withName("bad"), render);
				expect(r.status).toBe(200);
				expect(r.headers.get("etag")).toBeNull();
			}
			expect(render).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(FAILED_RENDER_TTL_MS + 1);
			await get(withName("bad"), render);
			expect(render).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
			spy.mockRestore();
		}
	});
});

describe("renderOgCard stress (every unbounded field long at once)", () => {
	// The caps: the club name's is `AREA_CLUB_NAME_MAX` (120); theme, word and
	// location have no server-side cap, so 500 characters stands in for "very
	// long". Bound: 8 s per render on a dev laptop (measured ~0.5 s).
	const BOUND_MS = 8000;
	const mixed = (n: number) =>
		"Wörld 世界の挨拶 😀🎤 ".repeat(Math.ceil(n / 14)).slice(0, n);

	// protects=no combination of long text, emoji and CJK makes satori throw or
	// grows the canvas; fails_when=a glyph or a long field breaks the layout
	// engine; no_claim=not how it looks: emoji and CJK are not in the woff
	// subset, so they draw as satori's missing-glyph box, never an error.
	it("renders 1200x630 within the bound, meeting and club", async () => {
		const meeting = {
			...meetingInput,
			clubName: mixed(120),
			theme: mixed(500),
			word: mixed(500),
			location: mixed(500),
		};
		const club = {
			...clubInput,
			clubName: mixed(120),
			nextTheme: mixed(500),
		};
		for (const input of [meeting, club]) {
			const t0 = performance.now();
			const png = await renderOgCard(input);
			const ms = performance.now() - t0;
			console.info(`[og stress] ${input.kind}: ${Math.round(ms)} ms`);
			expect(pngSize(png)).toEqual({ w: 1200, h: 630 });
			expect(ms).toBeLessThan(BOUND_MS);
		}
	});
});
