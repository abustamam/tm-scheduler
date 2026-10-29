/**
 * GET /api/og/club/$clubId.png and /api/og/meeting/$clubId/$meetingKey.png
 * (#1411) against real Postgres: headers, 304, the archive gate, the 404s, and
 * the fallback when a render throws.
 */
import { readFileSync } from "node:fs";
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
// Real satori, wrapped so one test can make it throw.
vi.mock("satori", async (importOriginal) => {
	const actual = await importOriginal<typeof import("satori")>();
	return { default: vi.fn(actual.default) };
});

const satori = (await import("satori")).default as unknown as ReturnType<
	typeof vi.fn
>;
const { Route: MeetingRoute } = await import(
	"#/routes/api/og.meeting.$clubId.$meetingKey[.]png"
);
const { Route: ClubRoute } = await import("#/routes/api/og.club.$clubId[.]png");
const { clearOgCardCache } = await import("#/server/og-card-logic");

type Get = (input: { request: Request }) => Promise<Response>;
const handler = (r: unknown) =>
	(r as { options: { server: { handlers: { GET: Get } } } }).options.server
		.handlers.GET;
const getMeeting = handler(MeetingRoute);
const getClub = handler(ClubRoute);

const meetingUrl = (s: SeededClub, key = s.meetingId) =>
	`http://x/api/og/meeting/${s.clubId}/${key}.png`;
const clubUrl = (id: string) => `http://x/api/og/club/${id}.png`;
const req = (url: string, headers?: Record<string, string>) =>
	new Request(url, { headers });

function size(png: Buffer) {
	return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

describe.skipIf(!hasTestDb)("og card endpoints (#1411)", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		clearOgCardCache();
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	// protects=both cards are 1200x630 PNGs with the ETag and Cache-Control the
	// page's ?v= promises; fails_when=size, type or headers drift;
	// no_claim=not the layout.
	it("200 + headers for the meeting card and the club card", async () => {
		for (const res of [
			await getMeeting({ request: req(meetingUrl(seed)) }),
			await getClub({ request: req(clubUrl(seed.clubId)) }),
		]) {
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("image/png");
			expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
			expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{12}"$/);
			expect(size(Buffer.from(await res.arrayBuffer()))).toEqual({
				w: 1200,
				h: 630,
			});
		}
	});

	// protects=a stale ?v= still gets today's card and today's ETag;
	// fails_when=the query is read.
	it("ignores ?v=", async () => {
		const a = await getMeeting({ request: req(meetingUrl(seed)) });
		const b = await getMeeting({ request: req(`${meetingUrl(seed)}?v=stale`) });
		expect(b.headers.get("etag")).toBe(a.headers.get("etag"));
	});

	// protects=revalidation costs no render; fails_when=a match returns 200.
	it("304 on a matching If-None-Match, 200 on a stale one", async () => {
		const first = await getClub({ request: req(clubUrl(seed.clubId)) });
		const etag = first.headers.get("etag") as string;
		const hit = await getClub({
			request: req(clubUrl(seed.clubId), { "if-none-match": etag }),
		});
		expect(hit.status).toBe(304);
		expect(hit.headers.get("etag")).toBe(etag);
		const miss = await getClub({
			request: req(clubUrl(seed.clubId), { "if-none-match": '"nope"' }),
		});
		expect(miss.status).toBe(200);
	});

	// protects=a theme edit changes the ETag (and so the page's ?v=);
	// fails_when=the theme is not in the version.
	it("changes the ETag when the theme changes", async () => {
		const before = (
			await getMeeting({ request: req(meetingUrl(seed)) })
		).headers.get("etag");
		await testDb
			.update(meetings)
			.set({ theme: "A brand new theme" })
			.where(eq(meetings.id, seed.meetingId));
		const after = (
			await getMeeting({ request: req(meetingUrl(seed)) })
		).headers.get("etag");
		expect(after).not.toBe(before);
	});

	// protects=the archive takedown reaches the card; fails_when=an archived
	// club still renders.
	it("404 for an archived club, on both", async () => {
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));
		expect((await getMeeting({ request: req(meetingUrl(seed)) })).status).toBe(
			404,
		);
		expect((await getClub({ request: req(clubUrl(seed.clubId)) })).status).toBe(
			404,
		);
	});

	// protects=unknown club / malformed id / unknown key are 404, not a 500 or
	// the fallback; fails_when=a Postgres cast error is served as 200.
	it("404 for an unknown club, a malformed id and an unknown meeting key", async () => {
		const unknown = "99999999-9999-4999-8999-999999999999";
		expect((await getClub({ request: req(clubUrl(unknown)) })).status).toBe(
			404,
		);
		expect((await getClub({ request: req(clubUrl("nope")) })).status).toBe(404);
		expect(
			(
				await getMeeting({
					request: req(
						`http://x/api/og/meeting/${unknown}/${seed.meetingId}.png`,
					),
				})
			).status,
		).toBe(404);
		expect(
			(await getMeeting({ request: req(meetingUrl(seed, "1999-01-01")) }))
				.status,
		).toBe(404);
	});

	// protects=a link preview never breaks: a render error serves default.png
	// (200, short cache, NO etag); fails_when=a 500 or an ETag on the fallback.
	it("serves default.png with 200 and no ETag when rendering throws", async () => {
		satori.mockRejectedValueOnce(new Error("boom"));
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const res = await getMeeting({ request: req(meetingUrl(seed)) });
		spy.mockRestore();
		expect(res.status).toBe(200);
		expect(res.headers.get("etag")).toBeNull();
		expect(res.headers.get("cache-control")).toBe("public, max-age=300");
		const body = Buffer.from(await res.arrayBuffer());
		expect(body.equals(readFileSync("public/og/default.png"))).toBe(true);
		expect(size(body)).toEqual({ w: 1200, h: 630 });
	});
});
