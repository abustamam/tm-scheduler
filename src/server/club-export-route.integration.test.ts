/**
 * GET /api/clubs/$clubId/export/zip (#915 AC2), against real Postgres with the
 * route's real guards: anonymous 401; a member who isn't an admin 403; an admin
 * of ANOTHER club 403; an archived club 404; an admin gets a zip whose entries
 * are README.txt plus the listed filenames, each parsing back as CSV.
 *
 * The session is faked at the LIBRARY boundary, like
 * `availability.integration.test.ts`: `getSessionUser`, `requireClubRole`,
 * `isReadableClub` and the officer-term fallback all run for real against the
 * seeded rows. Only the cookie → session lookup better-auth would do is stubbed,
 * which is the one piece a test process cannot have. Without that stub every
 * case here would be an anonymous one and the 403s would prove nothing.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { clubs, members, officerTerms } from "#/db/schema";
import { clubExportUrl } from "#/lib/club-export-url";
import { parseCsv } from "#/lib/members-csv";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

let sessionUserId: string | null = null;
const request = { headers: new Headers() };
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => request,
}));
vi.mock("#/lib/auth", () => ({
	auth: {
		api: {
			getSession: async () =>
				sessionUserId ? { user: { id: sessionUserId } } : null,
		},
	},
}));
vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
// `requireClubRole` stays REAL (it delegates to the original); wrapping it only
// lets one test make it fail the way a dropped connection would.
vi.mock("#/server/guards", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/server/guards")>();
	return { ...actual, requireClubRole: vi.fn(actual.requireClubRole) };
});

const { Route } = await import("#/routes/api/clubs.$clubId.export.zip");
const { beginClubExport, CLUB_EXPORT_FILENAMES } = await import(
	"./club-export-logic"
);
const { requireClubRole } = await import("#/server/guards");

type Get = (input: { params: { clubId: string } }) => Promise<Response>;
const GET = (
	Route as unknown as { options: { server: { handlers: { GET: Get } } } }
).options.server.handlers.GET;

async function download(clubId: string, as: string | null): Promise<Response> {
	sessionUserId = as;
	return GET({ params: { clubId } });
}

describe.skipIf(!hasTestDb)("GET /api/clubs/$clubId/export/zip (#915)", () => {
	let club: SeededClub;
	let other: SeededClub;
	let archived: SeededClub;

	beforeAll(async () => {
		[club, other, archived] = await Promise.all([
			seedClub(),
			seedClub(),
			seedClub(),
		]);
		await testDb
			.update(clubs)
			.set({ slug: `export-test-${randomUUID().slice(0, 8)}` })
			.where(eq(clubs.id, club.clubId));
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, archived.clubId));
	});

	afterAll(async () => {
		for (const c of [club, other, archived]) {
			if (c) await cleanup(c.clubId, [c.adminUserId, c.memberUserId]);
		}
		sessionUserId = null;
	});

	// The links are built by `clubExportUrl`; the route's path is declared in
	// its file. Read the declaration rather than restating it, so renaming the
	// file breaks this instead of leaving both links on a 404.
	it("is the route clubExportUrl links to", () => {
		const source = readFileSync(
			resolve(process.cwd(), "src/routes/api/clubs.$clubId.export.zip.ts"),
			"utf8",
		);
		const declared = source.match(/createFileRoute\("([^"]+)"\)/)?.[1];
		const id = randomUUID();
		expect(declared?.replace("$clubId", id)).toBe(clubExportUrl(id));
	});

	it("401s without a session", async () => {
		const res = await download(club.clubId, null);
		expect(res.status).toBe(401);
	});

	it("403s a member of the club who isn't an admin", async () => {
		const res = await download(club.clubId, club.memberUserId);
		expect(res.status).toBe(403);
		expect(res.headers.get("content-type")).not.toBe("application/zip");
	});

	it("403s an admin of ANOTHER club", async () => {
		const res = await download(club.clubId, other.adminUserId);
		expect(res.status).toBe(403);
	});

	it("403s a lapsed admin", async () => {
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, club.adminMemberId));
		try {
			const res = await download(club.clubId, club.adminUserId);
			expect(res.status).toBe(403);
		} finally {
			await testDb
				.update(members)
				.set({ status: "active" })
				.where(eq(members.id, club.adminMemberId));
		}
	});

	it("404s an archived club, even for its own admin", async () => {
		const res = await download(archived.clubId, archived.adminUserId);
		expect(res.status).toBe(404);
	});

	it("404s an unknown or malformed club id", async () => {
		expect((await download(randomUUID(), club.adminUserId)).status).toBe(404);
		expect((await download("not-a-uuid", club.adminUserId)).status).toBe(404);
	});

	it("429s a second export of the same club while one is running, then serves again", async () => {
		const release = beginClubExport(club.clubId);
		expect(release).not.toBeNull();
		try {
			const res = await download(club.clubId, club.adminUserId);
			expect(res.status).toBe(429);
			expect(await res.text()).toMatch(/already being prepared/);
			// Another club is unaffected.
			const other_ = await download(other.clubId, other.adminUserId);
			expect(other_.status).toBe(200);
		} finally {
			release?.();
		}
		expect((await download(club.clubId, club.adminUserId)).status).toBe(200);
		// And the slot was released after that success, too.
		const again = beginClubExport(club.clubId);
		expect(again).not.toBeNull();
		again?.();
	});

	it("releases the slot when the request is refused, so a 403 does not lock the club", async () => {
		expect((await download(club.clubId, club.memberUserId)).status).toBe(403);
		const slot = beginClubExport(club.clubId);
		expect(slot).not.toBeNull();
		slot?.();
	});

	it("lets a non-authorization failure propagate instead of answering 403", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.mocked(requireClubRole).mockRejectedValueOnce(
			new Error("Connection terminated unexpectedly"),
		);
		try {
			await expect(download(club.clubId, club.adminUserId)).rejects.toThrow(
				"Connection terminated unexpectedly",
			);
			expect(error).toHaveBeenCalled();
		} finally {
			error.mockRestore();
		}
	});

	it("serves the zip to an elected officer whose stored role is member", async () => {
		const [term] = await testDb
			.insert(officerTerms)
			.values({
				membershipId: club.memberId,
				position: "secretary",
				termStart: new Date(Date.now() - 86_400_000),
			})
			.returning({ id: officerTerms.id });
		try {
			const res = await download(club.clubId, club.memberUserId);
			expect(res.status).toBe(200);
		} finally {
			await testDb.delete(officerTerms).where(eq(officerTerms.id, term.id));
		}
	});

	it("serves an admin a zip of the listed CSVs, each parsing back", async () => {
		const res = await download(club.clubId, club.adminUserId);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/zip");
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("content-disposition")).toMatch(
			/^attachment; filename="export-test-[0-9a-f]{8}-export-\d{4}-\d{2}-\d{2}\.zip"$/,
		);

		const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
		expect(Object.keys(entries)).toEqual([
			"README.txt",
			...CLUB_EXPORT_FILENAMES,
		]);
		const readme = strFromU8(entries["README.txt"]);
		for (const f of CLUB_EXPORT_FILENAMES) expect(readme).toContain(f);

		for (const f of CLUB_EXPORT_FILENAMES) {
			const bytes = entries[f];
			expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
			const text = strFromU8(bytes);
			expect(text.endsWith("\r\n")).toBe(true);
			const [header] = text.split("\r\n");
			expect(header.length).toBeGreaterThan(0);
			const rows = parseCsv(text);
			for (const row of rows) {
				expect(Object.keys(row)).toEqual(header.split(","));
			}
		}
		const members_ = parseCsv(strFromU8(entries["members.csv"]));
		expect(members_.map((m) => m.member_id).sort()).toEqual(
			[club.memberId, club.adminMemberId].sort(),
		);
	});
});
