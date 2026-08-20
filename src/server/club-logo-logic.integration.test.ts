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
const { loadRoleSheetLogo } = await import("#/server/role-sheets-pdf-logic");
const { Route } = await import("#/routes/api/club.$clubId.logo");

// ---------------------------------------------------------------------------
// Fixture bytes — only the magic-byte PREFIX is load-bearing; the rest is
// filler so the buffer exercises a non-trivial size.
// ---------------------------------------------------------------------------

/**
 * A PNG whose header is REAL: the 8-byte signature plus a well-formed IHDR
 * carrying the requested pixel dimensions. The pixel data stays filler —
 * nothing here decodes it — but the IHDR must parse, because the upload gate
 * now reads it to enforce `MAX_LOGO_DIMENSION`. Byte size does not bound
 * decode cost: an 8000x8000 PNG fits in 243 KB and expands to ~256 MB of
 * bitmap inside the PDF renderer.
 */
function pngBytes(size = 128, width = 64, height = 64): Buffer {
	// A REAL png: full signature, a 13-byte IHDR, a padding IDAT sized to reach
	// the requested byte length, and an IEND. The validator walks the whole chunk
	// list now (a fixed-offset peek let a 45-byte file hang the decoder), so a
	// fixture that is only a magic prefix would be rejected — correctly.
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const mkChunk = (type: string, data: Buffer): Buffer => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		return Buffer.concat([
			len,
			Buffer.from(type, "ascii"),
			data,
			Buffer.alloc(4),
		]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const fixed = sig.length + 25 + 12; // signature + IHDR chunk + IEND chunk
	const padBytes = Math.max(0, size - fixed - 12); // 12 = IDAT chunk overhead
	return Buffer.concat([
		sig,
		mkChunk("IHDR", ihdr),
		...(padBytes > 0 ? [mkChunk("IDAT", Buffer.alloc(padBytes))] : []),
		mkChunk("IEND", Buffer.alloc(0)),
	]);
}

/** A JPEG whose SOF0 frame header carries the dimensions, same reason. */
function jpegBytes(size = 128, width = 64, height = 64): Buffer {
	const buf = Buffer.alloc(Math.max(size, 32), 0);
	buf[0] = 0xff; // SOI
	buf[1] = 0xd8;
	buf[2] = 0xff; // SOF0
	buf[3] = 0xc0;
	buf.writeUInt16BE(17, 4); // segment length
	buf[6] = 8; // sample precision
	buf.writeUInt16BE(height, 7);
	buf.writeUInt16BE(width, 9);
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
function fetchLogo(
	clubId: string,
	v?: string | number,
	headers?: Record<string, string>,
) {
	const url =
		v === undefined
			? `https://gavelup.app/api/club/${clubId}/logo`
			: `https://gavelup.app/api/club/${clubId}/logo?v=${v}`;
	return logoRouteGet()({
		params: { clubId },
		request: new Request(url, headers ? { headers } : undefined),
	});
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
			// Byte 50 is inside the IDAT payload. NOT byte 10: that is the IHDR
			// chunk's length field, and the validator now walks the chunk list, so
			// corrupting a declared length makes the whole upload (correctly) fail.
			b[50] = 0xaa;

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

		// A bare, stale or garbage `?v=` still SERVES — a cached agenda holding an
		// older `?v=` must keep rendering, which is the offline print flow.
		//
		// This case used to also assert the ASYMMETRY: only a current-version URL
		// earned `immutable`, and these got a short max-age instead. #517 removed
		// `immutable` from the current-version branch too, and with it the reason
		// for two numbers — a client does not learn about a replaced logo by
		// revalidating the old URL, it learns by re-rendering the page. So what is
		// left to pin here is that a non-current URL still serves at all, and that
		// nothing anywhere gets `immutable` back.
		it.each([
			["no ?v= at all", undefined],
			["a stale ?v=", 1],
			["a garbage ?v=", "not-a-number"],
		])("still serves the bytes, un-pinned, for %s", async (_label, v) => {
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

		it("happy path: 200 with the stored bytes, Content-Type, ETag and a revalidating Cache-Control", async () => {
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
			// #517: `immutable` is gone. It bought bytes, not correctness — the `?v=`
			// cache-buster already handled replacement — and it cost the takedown,
			// because a cache told never to revalidate keeps serving for up to a year
			// after the origin starts 404ing.
			expect(res.headers.get("cache-control")).toBe(
				"public, max-age=300, must-revalidate",
			);
			expect(res.headers.get("cache-control")).not.toContain("immutable");
			expect(res.headers.get("etag")).toBe(`"${meta?.updatedAt.getTime()}"`);
			const body = Buffer.from(await res.arrayBuffer());
			expect(body.equals(jpeg)).toBe(true);
		});
	});

	/**
	 * The takedown reaching already-cached copies (#517).
	 *
	 * ADR-0024 constraint 4 makes archiving the lever for an infringing logo, and
	 * before this the lever stopped at the origin: `immutable` told browsers and
	 * intermediaries not to revalidate, so a copy fetched the day before an
	 * archive kept rendering for up to a year. Revalidation is what makes the
	 * takedown reachable; the ETag is what makes revalidation cheap.
	 *
	 * The 304 path is gated by the SAME archive check as the byte path — through
	 * `loadClubLogoMeta`, which cannot select `bytes` — so the cheap request is
	 * not the unguarded one. That is the property most worth pinning here: a
	 * conditional request answered 304 without the check would hand a taken-down
	 * club's crest a fresh lease forever, one round trip at a time.
	 */
	describe("conditional requests and the takedown (#517)", () => {
		async function seedWithLogo() {
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
			if (!meta) throw new Error("no logo meta after upload");
			return { s, meta, etag: `"${meta.updatedAt.getTime()}"` };
		}

		it("answers 304 with no body when the ETag still matches", async () => {
			const { s, meta, etag } = await seedWithLogo();
			const res = await fetchLogo(s.clubId, meta.updatedAt.getTime(), {
				"if-none-match": etag,
			});
			expect(res.status).toBe(304);
			expect(res.headers.get("etag")).toBe(etag);
			// No bytes on the wire — the whole point of the ETag.
			expect((await res.arrayBuffer()).byteLength).toBe(0);
		});

		it("404s a conditional request once the club is archived", async () => {
			const { s, meta, etag } = await seedWithLogo();
			// BEFORE: the same request 304s, so the AFTER cannot pass by accident.
			expect(
				(
					await fetchLogo(s.clubId, meta.updatedAt.getTime(), {
						"if-none-match": etag,
					})
				).status,
			).toBe(304);

			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, s.clubId));

			const res = await fetchLogo(s.clubId, meta.updatedAt.getTime(), {
				"if-none-match": etag,
			});
			// NOT 304. A 304 here renews the cached copy's lease indefinitely, which
			// is exactly how the takedown failed to land before #517.
			expect(res.status).toBe(404);
		});

		it("serves the bytes when the ETag does not match", async () => {
			const { s, meta } = await seedWithLogo();
			const res = await fetchLogo(s.clubId, meta.updatedAt.getTime(), {
				"if-none-match": '"999"',
			});
			expect(res.status).toBe(200);
			expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
		});

		// A strong validator must not be satisfied by its weak form, nor by a
		// prefix — which an `includes()` compare would have allowed.
		it.each([
			['W/"', "the weak form"],
			['", "other', "a list"],
		])("does not 304 on %s (%s)", async (mangle) => {
			const { s, meta } = await seedWithLogo();
			const stamp = String(meta.updatedAt.getTime());
			const header = mangle.startsWith("W/")
				? `W/"${stamp}"`
				: `"${stamp}", "other"`;
			const res = await fetchLogo(s.clubId, meta.updatedAt.getTime(), {
				"if-none-match": header,
			});
			expect(res.status).toBe(200);
		});
	});

	// -------------------------------------------------------------------------
	// Pixel-dimension cap (#496).
	//
	// The byte caps above do NOT bound decode cost. #496 made that reachable
	// from a public endpoint by decoding uploaded bytes inside the Node process
	// (react-pdf renders the role-sheet PDF server-side), where an 8000x8000
	// PNG that compresses to 243 KB expands to ~1.1 GB RSS.
	// -------------------------------------------------------------------------

	describe("applyClubLogoUpload dimension cap (#496)", () => {
		async function upload(s: SeededClub, bytes: Buffer, mime = "image/png") {
			return applyClubLogoUpload({
				clubId: s.clubId,
				base64: bytes.toString("base64"),
				mime,
				attested: true,
				userId: s.adminUserId,
				actorMemberId: s.adminMemberId,
			});
		}

		it("accepts an image at the limit on both axes", async () => {
			const s = await seed();
			await upload(s, pngBytes(128, 2000, 2000));
			expect(await rowFor(s.clubId)).toHaveLength(1);
		});

		it("rejects a small-BYTE image with huge pixel dimensions", async () => {
			const s = await seed();
			// 243 KB on disk, a quarter-gigabyte decoded — passes every byte check.
			const huge = pngBytes(128, 8000, 8000);
			expect(huge.length).toBeLessThan(256 * 1024);
			await expect(upload(s, huge)).rejects.toThrow(/2000px or smaller/);
			expect(await rowFor(s.clubId)).toHaveLength(0);
		});

		it("rejects an over-wide image even when its height is fine", async () => {
			const s = await seed();
			await expect(upload(s, pngBytes(128, 4000, 10))).rejects.toThrow(
				/2000px or smaller/,
			);
		});

		it("applies the same cap to JPEG, read from its SOF0 header", async () => {
			const s = await seed();
			await expect(
				upload(s, jpegBytes(128, 5000, 5000), "image/jpeg"),
			).rejects.toThrow(/2000px or smaller/);
			await upload(s, jpegBytes(128, 400, 300), "image/jpeg");
			expect(await rowFor(s.clubId)).toHaveLength(1);
		});

		it("rejects a file whose header cannot be parsed at all", async () => {
			const s = await seed();
			// Correct PNG magic bytes, no IHDR — passes the sniff, but we cannot
			// establish what it would decode to, so it must not be stored.
			const noHeader = Buffer.alloc(128, 0);
			noHeader[0] = 0x89;
			noHeader[1] = 0x50;
			noHeader[2] = 0x4e;
			noHeader[3] = 0x47;
			await expect(upload(s, noHeader)).rejects.toThrow(/valid PNG or JPEG/);
			expect(await rowFor(s.clubId)).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// The role-sheet PDF logo read (#496).
	//
	// This path shipped with NO coverage, and that is exactly where the archive
	// bypass came back: `loadRoleSheetLogo` was written fresh and did not call
	// the shared `isReadableClub` gate, so archiving a club — this feature's
	// takedown lever (ADR-0024 constraint 4) — stopped removing its logo from a
	// PUBLIC, downloadable PDF.
	//
	// The cross-club case below is here rather than left to
	// `club-logo-scope.guard.test.ts` because that guard structurally cannot see
	// it: this query's per-club scoping is `eq(meetings.id, …)`, and the guard
	// only inspects `eq(clubLogos.clubId, …)` — which here is a column-to-column
	// JOIN CONDITION that scopes nothing. Deleting the `.where` would leak an
	// arbitrary club's logo with the guard still green.
	// -------------------------------------------------------------------------

	describe("loadRoleSheetLogo (#496)", () => {
		async function seedWithLogo(bytes = pngBytes(128, 100, 50)) {
			const s = await seed();
			await applyClubLogoUpload({
				clubId: s.clubId,
				base64: bytes.toString("base64"),
				mime: "image/png",
				attested: true,
				userId: s.adminUserId,
				actorMemberId: s.adminMemberId,
			});
			return s;
		}

		it("returns the club's own logo as a data URI for its meeting", async () => {
			const s = await seedWithLogo();
			const uri = await loadRoleSheetLogo(s.meetingId);
			expect(uri).toMatch(/^data:image\/png;base64,/);
		});

		it("returns null when the club has no logo", async () => {
			const s = await seed();
			expect(await loadRoleSheetLogo(s.meetingId)).toBeNull();
		});

		it("returns null for an unknown meeting", async () => {
			expect(await loadRoleSheetLogo(randomUUID())).toBeNull();
		});

		it("returns null once the club is archived (the takedown lever)", async () => {
			const s = await seedWithLogo();
			expect(await loadRoleSheetLogo(s.meetingId)).not.toBeNull();

			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, s.clubId));

			expect(await loadRoleSheetLogo(s.meetingId)).toBeNull();
		});

		it("never serves another club's logo for this club's meeting", async () => {
			// A has a logo, B does not. B's meeting must resolve to nothing —
			// not to A's bytes.
			const a = await seedWithLogo();
			const b = await seed();
			expect(await loadRoleSheetLogo(a.meetingId)).not.toBeNull();
			expect(await loadRoleSheetLogo(b.meetingId)).toBeNull();
		});

		it("gives each club its own distinct logo, never the other's", async () => {
			const a = await seedWithLogo(pngBytes(128, 100, 50));
			const b = await seedWithLogo(pngBytes(256, 100, 50));
			const [uriA, uriB] = await Promise.all([
				loadRoleSheetLogo(a.meetingId),
				loadRoleSheetLogo(b.meetingId),
			]);
			expect(uriA).not.toBeNull();
			expect(uriB).not.toBeNull();
			// Different byte lengths in, different payloads out.
			expect(uriA).not.toBe(uriB);
		});

		it("drops a logo too large to decode safely, rather than rendering it", async () => {
			const s = await seedWithLogo();
			// Write an over-dimension row directly: the upload gate rejects these
			// now, but rows predating the cap can still exist in a live database.
			await testDb
				.update(clubLogos)
				.set({ bytes: pngBytes(128, 9000, 9000) })
				.where(eq(clubLogos.clubId, s.clubId));

			expect(await loadRoleSheetLogo(s.meetingId)).toBeNull();
		});
	});
});
