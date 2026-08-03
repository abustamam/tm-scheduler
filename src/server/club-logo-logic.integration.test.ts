/**
 * DB-backed integration tests for the club-logo feature (#495):
 *   - `club-logo-logic.ts` — insert / update (replace) / remove /
 *     remove-when-absent / concurrent upsert, validation (encoded cap,
 *     decoded cap, MIME allow-list, magic-byte sniff, attestation), and the
 *     `loadClubLogoMeta` no-`bytes` contract.
 *   - `guards.ts`'s `requireClubRole` — authz rejection for a non-admin and
 *     for an admin of a DIFFERENT club, seeded through the real membership
 *     write path (`seedClub`'s `testDb.insert(members)`, the same
 *     person→membership shape `applyBulkImport`/`applySetMemberRole`
 *     produce) rather than a hand-rolled row shape a real signup could never
 *     create.
 *   - the public GET route (`club.$clubId.logo.ts`) — 404s (unknown club,
 *     archived club, no logo) and the happy-path response headers.
 *
 * `#/db` is redirected to the test database, mirroring
 * `archive-club.integration.test.ts`.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test_lane_a \
 *     bunx vitest run src/server/club-logo-logic.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityLog, clubLogos, clubs } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	applyClubLogoUpload,
	loadClubLogoForServing,
	loadClubLogoMeta,
	removeClubLogo,
} = await import("#/server/club-logo-logic");
const { requireClubRole } = await import("#/server/guards");
const { Route } = await import("#/routes/api/club.$clubId.logo");

// ---------------------------------------------------------------------------
// Fixture bytes — only the magic-byte PREFIX is load-bearing; the rest is
// filler so the buffer exercises a non-trivial size.
// ---------------------------------------------------------------------------

function pngBytes(size = 128): Buffer {
	const buf = Buffer.alloc(size, 0);
	buf[0] = 0x89;
	buf[1] = 0x50;
	buf[2] = 0x4e;
	buf[3] = 0x47;
	return buf;
}

function jpegBytes(size = 128): Buffer {
	const buf = Buffer.alloc(size, 0);
	buf[0] = 0xff;
	buf[1] = 0xd8;
	buf[2] = 0xff;
	return buf;
}

/** SVG's `<?xml` magic bytes (AC #4: "a file named logo.png whose bytes
 *  begin 3C 3F 78 6D 6C is rejected by the magic-byte check"), padded to a
 *  non-trivial size like the PNG/JPEG fixtures. */
function svgBytes(size = 128): Buffer {
	const header = Buffer.from('<?xml version="1.0"?><svg></svg>');
	const buf = Buffer.alloc(size, 0x20);
	header.copy(buf);
	return buf;
}

// ---------------------------------------------------------------------------
// Reach into the route's internal GET handler for a direct call. The public
// `AnyRoute` type from `@tanstack/react-router` doesn't expose `.options` —
// there's no existing precedent in this repo for unit-testing a
// `server.handlers` GET directly — so this asserts the runtime shape once via
// a narrow cast rather than re-deriving the 404-vs-200 decision a second time
// in the test.
// ---------------------------------------------------------------------------

type LogoGetHandler = (input: {
	params: { clubId: string };
	request: Request;
}) => Promise<Response>;

function logoRouteGet(): LogoGetHandler {
	return (
		Route as unknown as {
			options: { server: { handlers: { GET: LogoGetHandler } } };
		}
	).options.server.handlers.GET;
}

/**
 * Call the route the way a browser would. `v` is the `?v=` cache-buster:
 * pass the row's real `updatedAt.getTime()` for a current URL, anything else
 * (or omit it) for a stale/bare one — the two get DIFFERENT `Cache-Control`.
 */
function fetchLogo(clubId: string, v?: string | number) {
	const url =
		v === undefined
			? `https://gavelup.app/api/club/${clubId}/logo`
			: `https://gavelup.app/api/club/${clubId}/logo?v=${v}`;
	return logoRouteGet()({ params: { clubId }, request: new Request(url) });
}

describe.skipIf(!hasTestDb)("club logo (#495)", () => {
	const seededClubs: { clubId: string; userIds: string[] }[] = [];

	afterEach(async () => {
		for (const { clubId, userIds } of seededClubs) {
			await cleanup(clubId, userIds);
		}
		seededClubs.length = 0;
	});

	/** `seedClub` + track for cleanup. */
	async function seed(): Promise<SeededClub> {
		const s = await seedClub();
		seededClubs.push({
			clubId: s.clubId,
			userIds: [s.adminUserId, s.memberUserId],
		});
		return s;
	}

	async function activityRowsFor(clubId: string) {
		return testDb
			.select()
			.from(activityLog)
			.where(eq(activityLog.clubId, clubId));
	}

	async function rowFor(clubId: string) {
		return testDb.select().from(clubLogos).where(eq(clubLogos.clubId, clubId));
	}

	// -------------------------------------------------------------------------
	// Insert / update / remove
	// -------------------------------------------------------------------------

	describe("applyClubLogoUpload / removeClubLogo", () => {
		it("insert: a first upload creates exactly one row with the given bytes/mime/attestation", async () => {
			const s = await seed();
			const png = pngBytes(200);

			await applyClubLogoUpload({
				clubId: s.clubId,
				base64: png.toString("base64"),
				mime: "image/png",
				attested: true,
				userId: s.adminUserId,
				actorMemberId: s.adminMemberId,
			});

			const rows = await rowFor(s.clubId);
			expect(rows).toHaveLength(1);
			const row = rows[0];
			expect(row?.clubId).toBe(s.clubId);
			expect(row?.mime).toBe("image/png");
			expect(row?.bytes.equals(png)).toBe(true);
			expect(row?.attestedBy).toBe(s.adminUserId);
			expect(row?.attestedAt).toBeInstanceOf(Date);
			expect(row?.updatedAt).toBeInstanceOf(Date);
		});

		it("update: a second upload REPLACES the row (still exactly one row, new bytes/mime win)", async () => {
			const s = await seed();
			const png = pngBytes(150);
			const jpeg = jpegBytes(300);

			await applyClubLogoUpload({
				clubId: s.clubId,
				base64: png.toString("base64"),
				mime: "image/png",
				attested: true,
				userId: s.adminUserId,
				actorMemberId: s.adminMemberId,
			});
			await applyClubLogoUpload({
				clubId: s.clubId,
				base64: jpeg.toString("base64"),
				mime: "image/jpeg",
				attested: true,
				userId: s.adminUserId,
				actorMemberId: s.adminMemberId,
			});

			const rows = await rowFor(s.clubId);
			expect(rows).toHaveLength(1);
			const row = rows[0];
			expect(row?.mime).toBe("image/jpeg");
			expect(row?.bytes.equals(jpeg)).toBe(true);
			expect(row?.bytes.equals(png)).toBe(false);
		});

		it("remove: deletes the row", async () => {
			const s = await seed();
			await applyClubLogoUpload({
				clubId: s.clubId,
				base64: pngBytes().toString("base64"),
				mime: "image/png",
				attested: true,
				userId: s.adminUserId,
				actorMemberId: s.adminMemberId,
			});
			expect(await rowFor(s.clubId)).toHaveLength(1);

			await removeClubLogo(s.clubId, s.adminMemberId);
			expect(await rowFor(s.clubId)).toHaveLength(0);
		});

		it("remove-when-absent is a no-op (no error, still zero rows)", async () => {
			const s = await seed();
			expect(await rowFor(s.clubId)).toHaveLength(0);
			await expect(
				removeClubLogo(s.clubId, s.adminMemberId),
			).resolves.toBeUndefined();
			expect(await rowFor(s.clubId)).toHaveLength(0);
		});

		// CLAUDE.md's documented coverage trap: "an empty-list guard is invisible
		// to a result assertion." `removeClubLogo`'s `if (removed.length === 0)
		// return;` guards the `logActivity` call, but `removeClubLogo` always
		// returns `undefined` and the row count is 0 either way — so the test
		// above passes identically whether that guard runs or is deleted
		// outright (which would log a `club_logo_removed` entry for a club that
		// never had a logo). This asserts the actual observable the guard
		// controls: whether the activity round-trip happened at all.
		it("remove-when-absent logs NOTHING — the guard actually skips the activity write", async () => {
			const s = await seed();
			expect(await rowFor(s.clubId)).toHaveLength(0);

			await removeClubLogo(s.clubId, s.adminMemberId);

			const rows = await activityRowsFor(s.clubId);
			expect(rows.filter((r) => r.action === "club_logo_removed")).toEqual([]);
		});

		it("insert logs a club_logo_set activity entry, in the same transaction, with mime + byte length in detail", async () => {
			const s = await seed();
			const png = pngBytes(222);

			await applyClubLogoUpload({
				clubId: s.clubId,
				base64: png.toString("base64"),
				mime: "image/png",
				attested: true,
				userId: s.adminUserId,
				actorMemberId: s.adminMemberId,
			});

			const rows = await activityRowsFor(s.clubId);
			const logged = rows.filter((r) => r.action === "club_logo_set");
			expect(logged).toHaveLength(1);
			expect(logged[0]?.targetType).toBe("club");
			expect(logged[0]?.targetId).toBe(s.clubId);
			expect(logged[0]?.actorMemberId).toBe(s.adminMemberId);
			// Shape only, never the image bytes.
			expect(logged[0]?.detail).toEqual({ mime: "image/png", bytes: 222 });
		});

		it("remove (after an upload) logs exactly one club_logo_removed activity entry", async () => {
			const s = await seed();
			await applyClubLogoUpload({
				clubId: s.clubId,
				base64: pngBytes().toString("base64"),
				mime: "image/png",
				attested: true,
				userId: s.adminUserId,
				actorMemberId: s.adminMemberId,
			});

			await removeClubLogo(s.clubId, s.adminMemberId);

			const rows = await activityRowsFor(s.clubId);
			const logged = rows.filter((r) => r.action === "club_logo_removed");
			expect(logged).toHaveLength(1);
			expect(logged[0]?.targetType).toBe("club");
			expect(logged[0]?.targetId).toBe(s.clubId);
			expect(logged[0]?.actorMemberId).toBe(s.adminMemberId);
		});

		// Two clubs, both with logos. Every other test in this file seeds ONE
		// club, which means dropping the `WHERE clubId = …` from removeClubLogo
		// — an unconditional delete that would erase EVERY club's logo — left
		// the whole suite green. Mutation-verified: with the predicate removed,
		// this is the test that goes red.
		it("remove is scoped to ONE club — a second club's logo survives", async () => {
			const a = await seed();
			const b = await seed();
			for (const club of [a, b]) {
				await applyClubLogoUpload({
					clubId: club.clubId,
					base64: pngBytes().toString("base64"),
					mime: "image/png",
					attested: true,
					userId: club.adminUserId,
					actorMemberId: club.adminMemberId,
				});
			}
			expect(await rowFor(a.clubId)).toHaveLength(1);
			expect(await rowFor(b.clubId)).toHaveLength(1);

			await removeClubLogo(a.clubId, a.adminMemberId);

			expect(await rowFor(a.clubId)).toHaveLength(0);
			expect(await rowFor(b.clubId)).toHaveLength(1);
		});

		it("concurrent upsert: two simultaneous uploads leave exactly ONE row", async () => {
			const s = await seed();
			const a = pngBytes(100);
			const b = pngBytes(400); // different length so we can tell which "won"
			b[10] = 0xaa;

			const uploadA = applyClubLogoUpload({
				clubId: s.clubId,
				base64: a.toString("base64"),
				mime: "image/png",
				attested: true,
				userId: s.adminUserId,
				actorMemberId: s.adminMemberId,
			});
			const uploadB = applyClubLogoUpload({
				clubId: s.clubId,
				base64: b.toString("base64"),
				mime: "image/png",
				attested: true,
				userId: s.adminUserId,
				actorMemberId: s.adminMemberId,
			});

			await Promise.all([uploadA, uploadB]);

			const rows = await rowFor(s.clubId);
			expect(rows).toHaveLength(1);
			const row = rows[0];
			const wonA = row?.bytes.equals(a) ?? false;
			const wonB = row?.bytes.equals(b) ?? false;
			// Exactly one of the two payloads is the final state — never a mix,
			// never neither.
			expect(wonA !== wonB).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// Validation — every one of these throws BEFORE any db call, so a valid
	// club/user id isn't required; each test holds every other input valid so
	// the failure is attributable to the ONE check under test.
	// -------------------------------------------------------------------------

	describe("applyClubLogoUpload validation", () => {
		const clubId = randomUUID();
		const userId = randomUUID();
		const actorMemberId = randomUUID();

		it("rejects when attested is false, even with otherwise-valid PNG bytes", async () => {
			await expect(
				applyClubLogoUpload({
					clubId,
					base64: pngBytes().toString("base64"),
					mime: "image/png",
					attested: false,
					userId,
					actorMemberId,
				}),
			).rejects.toThrow(/authorized/i);
		});

		it("rejects a MIME type outside the PNG/JPEG allow-list", async () => {
			await expect(
				applyClubLogoUpload({
					clubId,
					base64: svgBytes().toString("base64"),
					mime: "image/svg+xml",
					attested: true,
					userId,
					actorMemberId,
				}),
			).rejects.toThrow(/PNG or JPEG/i);
		});

		it("rejects an over-cap ENCODED string (>350,000 chars) before decoding", async () => {
			// Content doesn't matter — this must reject on length alone, before
			// ever reaching the decode step.
			const encoded = "A".repeat(350_001);
			await expect(
				applyClubLogoUpload({
					clubId,
					base64: encoded,
					mime: "image/png",
					attested: true,
					userId,
					actorMemberId,
				}),
			).rejects.toThrow(/too large/i);
		});

		it("rejects over-cap DECODED bytes (>256 KB) even when the encoded string is under the encoded cap", async () => {
			// 262,200 decoded bytes (> 262,144 = 256 KiB) encodes to exactly
			// 349,600 base64 chars — under the 350,000 encoded cap, so this
			// specifically exercises the DECODED-bytes check, not the encoded one.
			const oversized = Buffer.alloc(262_200, 0);
			oversized[0] = 0x89;
			oversized[1] = 0x50;
			oversized[2] = 0x4e;
			oversized[3] = 0x47;
			const encoded = oversized.toString("base64");
			expect(encoded.length).toBeLessThanOrEqual(350_000);

			await expect(
				applyClubLogoUpload({
					clubId,
					base64: encoded,
					mime: "image/png",
					attested: true,
					userId,
					actorMemberId,
				}),
			).rejects.toThrow(/256 KB/);
		});

		it("rejects bytes whose magic-byte signature doesn't match the declared MIME (SVG content, .png-shaped declaration)", async () => {
			// Mirrors AC #4: a file named logo.png (so the client declares
			// image/png) whose actual bytes are SVG text starting `3C 3F 78 6D 6C`.
			await expect(
				applyClubLogoUpload({
					clubId,
					base64: svgBytes().toString("base64"),
					mime: "image/png",
					attested: true,
					userId,
					actorMemberId,
				}),
			).rejects.toThrow(/doesn't look like/i);
		});

		it("rejects zero-length decoded bytes", async () => {
			await expect(
				applyClubLogoUpload({
					clubId,
					base64: "",
					mime: "image/png",
					attested: true,
					userId,
					actorMemberId,
				}),
				// Message-specific on purpose. A bare `.rejects.toThrow()` passes
				// even with the `bytes.length === 0` guard deleted, because the
				// magic-byte check then throws its own (different) error on an
				// empty buffer — the guard becomes invisible to its own test.
			).rejects.toThrow(/could not be read/i);
		});
	});

	// -------------------------------------------------------------------------
	// loadClubLogoMeta — must select `updatedAt` only, never `bytes` (this is
	// the entire reason `club_logos` is a separate table: a `SELECT *` here
	// would pull the blob into every printed-agenda SSR render).
	// -------------------------------------------------------------------------

	describe("loadClubLogoMeta", () => {
		it("returns null when no logo exists", async () => {
			const s = await seed();
			expect(await loadClubLogoMeta(s.clubId)).toBeNull();
		});

		// `getClubLogoMeta` is a PUBLIC, unauthenticated server fn wrapping this.
		// `src/lib/club-archive.ts` states that ANY new public no-auth club
		// loader must treat an archived club as not-found, and this one didn't:
		// the binary route 404'd an archived club while this still reported the
		// logo's existence and version to anyone. Archiving is also this
		// feature's takedown lever (ADR-0024 constraint 4), so a read path that
		// ignores it defeats the mechanism. Both paths now share `isReadableClub`.
		it("returns null for an ARCHIVED club, matching loadClubLogoForServing", async () => {
			const s = await seed();
			await applyClubLogoUpload({
				clubId: s.clubId,
				base64: pngBytes().toString("base64"),
				mime: "image/png",
				attested: true,
				userId: s.adminUserId,
				actorMemberId: s.adminMemberId,
			});
			// Pin the pre-archive state first, so this can't pass just because
			// the logo was never there.
			expect(await loadClubLogoMeta(s.clubId)).not.toBeNull();

			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, s.clubId));

			expect(await loadClubLogoMeta(s.clubId)).toBeNull();
			expect(await loadClubLogoForServing(s.clubId)).toBeNull();
		});

		it("returns ONLY updatedAt — the returned object has no `bytes` key", async () => {
			const s = await seed();
			await applyClubLogoUpload({
				clubId: s.clubId,
				base64: pngBytes().toString("base64"),
				mime: "image/png",
				attested: true,
				userId: s.adminUserId,
				actorMemberId: s.adminMemberId,
			});

			const meta = await loadClubLogoMeta(s.clubId);
			expect(meta).not.toBeNull();
			// The load-bearing assertion: if the query regresses to `select()`
			// (no column list) or adds `bytes` to the column list, this object
			// would carry a `bytes` key and this assertion catches it.
			expect(Object.keys(meta as object)).toEqual(["updatedAt"]);
			expect(meta?.updatedAt).toBeInstanceOf(Date);
		});
	});

	// -------------------------------------------------------------------------
	// loadClubLogoForServing — the data-layer decision the GET route turns
	// into a 404 (below); tested directly here as well as through the route.
	// -------------------------------------------------------------------------

	describe("loadClubLogoForServing", () => {
		it("returns null for an unknown club", async () => {
			expect(await loadClubLogoForServing(randomUUID())).toBeNull();
		});

		it("returns null for an active club with no logo", async () => {
			const s = await seed();
			expect(await loadClubLogoForServing(s.clubId)).toBeNull();
		});

		it("returns null for an archived club, even with a logo uploaded", async () => {
			const s = await seed();
			await applyClubLogoUpload({
				clubId: s.clubId,
				base64: pngBytes().toString("base64"),
				mime: "image/png",
				attested: true,
				userId: s.adminUserId,
				actorMemberId: s.adminMemberId,
			});
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, s.clubId));

			expect(await loadClubLogoForServing(s.clubId)).toBeNull();
		});

		it("returns the bytes + mime for an active club with a logo", async () => {
			const s = await seed();
			const png = pngBytes(300);
			await applyClubLogoUpload({
				clubId: s.clubId,
				base64: png.toString("base64"),
				mime: "image/png",
				attested: true,
				userId: s.adminUserId,
				actorMemberId: s.adminMemberId,
			});

			const logo = await loadClubLogoForServing(s.clubId);
			expect(logo).not.toBeNull();
			expect(logo?.mime).toBe("image/png");
			expect(logo?.bytes.equals(png)).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// Authorization — `requireClubRole`, exercised against members seeded
	// through the real membership write path (`seedClub`).
	// -------------------------------------------------------------------------

	describe("authorization (requireClubRole)", () => {
		it("the club's own admin passes (positive control for the two rejections below)", async () => {
			const s = await seed();
			await expect(
				requireClubRole(s.adminUserId, s.clubId, ["admin"]),
			).resolves.toMatchObject({ clubRole: "admin" });
		});

		it("a non-admin member of the club is rejected", async () => {
			const s = await seed();
			await expect(
				requireClubRole(s.memberUserId, s.clubId, ["admin"]),
			).rejects.toThrow(/permission/i);
		});

		it("an admin of a DIFFERENT club is rejected for this club's id", async () => {
			const clubA = await seed();
			const clubB = await seed();
			// clubB's admin has no membership row in clubA at all, so this rejects
			// one level earlier than the non-admin case above (`requireMembership`
			// itself, not the role check) — "not a member", not "no permission".
			// Either way, the write is denied; assert on that.
			await expect(
				requireClubRole(clubB.adminUserId, clubA.clubId, ["admin"]),
			).rejects.toThrow(/permission|not a member/i);
		});
	});

	// -------------------------------------------------------------------------
	// Public GET route — 404 shapes + happy-path headers.
	// -------------------------------------------------------------------------

	describe("GET /api/club/$clubId/logo", () => {
		it("404s for an unknown club", async () => {
			const res = await fetchLogo(randomUUID());
			expect(res.status).toBe(404);
		});

		it("404s for a malformed club id (never a 500 from a bad uuid literal)", async () => {
			const res = await fetchLogo("not-a-uuid");
			expect(res.status).toBe(404);
		});

		it("404s for an archived club, even with a logo uploaded", async () => {
			const s = await seed();
			await applyClubLogoUpload({
				clubId: s.clubId,
				base64: pngBytes().toString("base64"),
				mime: "image/png",
				attested: true,
				userId: s.adminUserId,
				actorMemberId: s.adminMemberId,
			});
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, s.clubId));

			const res = await fetchLogo(s.clubId);
			expect(res.status).toBe(404);
		});

		it("404s for an active club with no logo uploaded", async () => {
			const s = await seed();
			const res = await fetchLogo(s.clubId);
			expect(res.status).toBe(404);
		});

		// `immutable` is only sound for a URL that names the CURRENT version.
		// A bare or stale URL still serves (a cached agenda holding an older
		// ?v= must keep rendering — that is the offline print flow) but must
		// not be pinned for a year, or a replaced logo never reaches whoever
		// holds it and an archive-takedown can't reach already-cached copies.
		it.each([
			["no ?v= at all", undefined],
			["a stale ?v=", 1],
			["a garbage ?v=", "not-a-number"],
		])("serves the bytes but WITHOUT the year-long immutable directive for %s", async (_label, v) => {
			const s = await seed();
			await applyClubLogoUpload({
				clubId: s.clubId,
				base64: pngBytes().toString("base64"),
				mime: "image/png",
				attested: true,
				userId: s.adminUserId,
				actorMemberId: s.adminMemberId,
			});

			const res = await fetchLogo(s.clubId, v);
			expect(res.status).toBe(200);
			const cacheControl = res.headers.get("cache-control");
			expect(cacheControl).not.toContain("immutable");
			expect(cacheControl).toBe("public, max-age=300, must-revalidate");
		});

		it("happy path: 200 with the stored bytes, Content-Type, and an immutable Cache-Control", async () => {
			const s = await seed();
			const jpeg = jpegBytes(500);
			await applyClubLogoUpload({
				clubId: s.clubId,
				base64: jpeg.toString("base64"),
				mime: "image/jpeg",
				attested: true,
				userId: s.adminUserId,
				actorMemberId: s.adminMemberId,
			});
			const meta = await loadClubLogoMeta(s.clubId);

			const res = await fetchLogo(s.clubId, meta?.updatedAt.getTime());
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("image/jpeg");
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
			expect(res.headers.get("cache-control")).toBe(
				"public, max-age=31536000, immutable",
			);
			const body = Buffer.from(await res.arrayBuffer());
			expect(body.equals(jpeg)).toBe(true);
		});
	});
});
