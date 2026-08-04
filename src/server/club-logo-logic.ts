/**
 * DB logic for the club-logo feature (#495). Kept out of the `club-logo.ts`
 * createServerFn module (client-imported) so `#/db` → `pg` → `Buffer` never
 * leaks into the client bundle — see `members-logic.ts` for the split
 * rationale, enforced by `server-modules.guard.test.ts`.
 *
 * `club_logos` is a separate 1:1 table (NOT columns on `clubs`) so the ~35
 * call sites that read a club row with no column list — including the
 * authorization path in `guards.ts` — never drag a 256 KB blob along. That
 * invariant is only real if the read paths here respect it too:
 * {@link loadClubLogoMeta} MUST NOT select `bytes`, ever.
 */
import { eq } from "drizzle-orm";
import { db } from "#/db";
import { clubLogos, clubs } from "#/db/schema";
import { isClubArchived } from "#/lib/club-archive";
import { logActivity } from "./activity";

/** Matches `clubs-logic.ts`'s `UUID_RE` — comparing a non-UUID string against
 *  a `uuid` column makes Postgres throw ("invalid input syntax for type
 *  uuid") instead of returning zero rows, which would surface as a 500
 *  instead of the 404 an unknown/malformed club id should produce. */
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 256 KiB — the decoded-bytes cap (separate from the encoded-string cap
 *  below; base64 inflates size ~33%, so the two numbers differ on purpose). */
const MAX_LOGO_BYTES = 256 * 1024;

/** Matches the zod `.max(350_000)` on `club-logo.ts`'s `uploadSchema`. That
 *  schema is the primary enforcement (rejects before this function even
 *  runs), but `createServerFn` wrappers can't be invoked directly in this
 *  repo's tests (they need the Start runtime — see
 *  `bulk-import.integration.test.ts`), so this repeats the check here: both
 *  makes it independently testable, and means `applyClubLogoUpload` doesn't
 *  rely on a caller-side check for a load-bearing size limit. */
const MAX_ENCODED_LENGTH = 350_000;

const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg"] as const;
type AllowedMime = (typeof ALLOWED_MIME_TYPES)[number];

// Magic-byte signatures. The declared `mime` is client-supplied and cannot be
// trusted on its own (constraint from the trademark/security review: an SVG
// renamed to `logo.png` must still be rejected) — this checks what the bytes
// actually are.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

function matchesMagicBytes(bytes: Buffer, mime: AllowedMime): boolean {
	if (mime === "image/png") {
		return bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
	}
	return bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE);
}

function isAllowedMime(mime: string): mime is AllowedMime {
	return (ALLOWED_MIME_TYPES as readonly string[]).includes(mime);
}

/**
 * Pixel-dimension cap, enforced ALONGSIDE `MAX_LOGO_BYTES` rather than instead
 * of it. The two bound different costs and neither implies the other.
 *
 * A byte cap bounds storage and transfer. It does NOT bound the cost of
 * DECODING, because compression ratio is unbounded: an 8000x8000 RGBA PNG of a
 * mostly-transparent logo compresses to ~243 KB — comfortably under the 256 KiB
 * cap, correct magic bytes, entirely well-formed — and decodes to ~256 MB of
 * raw bitmap.
 *
 * That became reachable in #496. Before it, uploaded bytes were only ever
 * served verbatim to a browser (the GET route) — the decode happened on the
 * visitor's machine. #496 is the first path that decodes them INSIDE the Node
 * process: `@react-pdf/renderer` decodes the data URI server-side while
 * rendering the role-sheet PDF, and that endpoint is public, unauthenticated
 * and `no-store`, so every request re-renders. Measured on this code: the
 * 8000x8000 case drives the process from 151 MB to 1.1 GB RSS at 1.3 s CPU per
 * request, and an ordinary 4000x4000 transparent-PNG club logo weighing 61 KB
 * already costs +240 MB. A handful of concurrent anonymous GETs would OOM the
 * container for every club, so this is an availability bug, not a hardening
 * nicety — and it needs no malice to trigger.
 *
 * 2000px is far above what any surface asks for (the largest consumers are a
 * 26pt PDF header and a 4in PPTX frame) and far below where decode cost bites.
 */
const MAX_LOGO_DIMENSION = 2000;

/**
 * Intrinsic pixel size, established by STRUCTURALLY VALIDATING the file — not by
 * peeking at fixed offsets.
 *
 * The distinction is the whole point, and getting it wrong shipped a worse bug
 * than the one the cap was added to fix. The first version of this read bytes
 * 16-24 of a PNG and returned them. That is not validation: the decoder that
 * actually runs is `png-js` (reached via `@react-pdf/image`, which dispatches on
 * the DECLARED mime and never sniffs), and it walks the whole chunk list with
 * three behaviours a fixed-offset peek cannot see:
 *
 *   · `readUInt32` composes with `|`, so a declared chunk length >= 0x80000000
 *     is NEGATIVE. Its skip is `pos += chunkSize` and its only bound is
 *     `if (pos > data.length) throw`, so a negative length walks `pos` BACKWARDS
 *     and the bound never trips. A 45-byte file built this way makes the
 *     constructor loop forever — synchronously, on a public unauthenticated
 *     endpoint, in a single-process server. Verified: it never returns.
 *   · `case 'IDAT'` copies `chunkSize` bytes one push at a time BEFORE that
 *     bound is checked.
 *   · `case 'IHDR'` assigns width/height on EVERY IHDR chunk, so a trailing
 *     second IHDR wins. The old peek read the first and certified 1x1 for a file
 *     the decoder saw as 20000x20000.
 *
 * So the rule this now enforces is not "find the dimensions" but "prove the
 * structure is one the decoder will read the same way we did". Every chunk
 * length is read UNSIGNED and must fit inside the file. That single invariant
 * removes the negative-length class entirely: a length that fits in a <=256 KB
 * upload is necessarily far below 0x80000000, so `png-js`'s signed read and ours
 * cannot disagree.
 *
 * Returns null whenever the structure is anything other than plainly sound.
 * Callers treat null as rejection: a file we cannot parse confidently is exactly
 * the file not to hand to a decoder.
 */
const PNG_SIGNATURE_FULL = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export function readImageDimensions(
	bytes: Buffer,
	mime: AllowedMime,
): { width: number; height: number } | null {
	return mime === "image/png"
		? readPngDimensions(bytes)
		: readJpegDimensions(bytes);
}

function readPngDimensions(
	bytes: Buffer,
): { width: number; height: number } | null {
	// The FULL 8-byte signature. `matchesMagicBytes` checks only the first four,
	// which is looser than every real decoder.
	if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE_FULL)) return null;

	let pos = 8;
	let dimensions: { width: number; height: number } | null = null;

	// Chunk: length(4) + type(4) + data(length) + crc(4).
	while (pos + 8 <= bytes.length) {
		const length = bytes.readUInt32BE(pos); // UNSIGNED — see the doc comment
		const type = bytes.subarray(pos + 4, pos + 8).toString("ascii");
		const next = pos + 8 + length + 4;
		// Every chunk must fit. This is the invariant that makes our read and the
		// decoder's agree, so it must reject rather than clamp.
		if (next > bytes.length) return null;

		if (dimensions === null) {
			// The spec requires IHDR first, and exactly 13 bytes of it.
			if (type !== "IHDR" || length !== 13) return null;
			const width = bytes.readUInt32BE(pos + 8);
			const height = bytes.readUInt32BE(pos + 12);
			if (width === 0 || height === 0) return null;
			dimensions = { width, height };
		} else if (type === "IHDR") {
			// A second IHDR: the decoder would keep THIS one while we returned the
			// first, so the two would disagree by construction. Refuse.
			return null;
		}

		if (type === "IEND") return dimensions;
		pos = next;
	}
	// Ran off the end without an IEND.
	return null;
}

/**
 * JPEG frame size, walked under the SAME rule the decoder uses.
 *
 * react-pdf decodes JPEG with `jay-peg`, whose marker table assigns a length
 * field to every marker in 0xFFC0-0xFFFE. An earlier version of this walker
 * special-cased RST/TEM as standalone and collapsed 0xFF fill runs; both are
 * legal JPEG, but `jay-peg` does neither, so the two parsers could land on
 * different frame headers and the cap would be measuring an image nobody
 * decodes. Matching the decoder matters more than accepting every legal file:
 * a shape we read differently is rejected at upload with a clear message rather
 * than accepted and rendered as nothing.
 */
function readJpegDimensions(
	bytes: Buffer,
): { width: number; height: number } | null {
	if (bytes.length < 4) return null;
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null; // SOI

	let pos = 2;
	while (pos + 4 <= bytes.length) {
		if (bytes[pos] !== 0xff) return null;
		const marker = bytes[pos + 1];
		if (marker === 0xd9) return null; // EOI before any frame
		const segmentLength = bytes.readUInt16BE(pos + 2);
		// The length counts itself, so under 2 cannot advance.
		if (segmentLength < 2) return null;
		if (pos + 2 + segmentLength > bytes.length) return null;

		// SOF0-SOF15 carry the frame size. DHT (0xc4), JPG (0xc8) and DAC (0xcc)
		// share the range but are not frame headers.
		const isFrameHeader =
			marker >= 0xc0 &&
			marker <= 0xcf &&
			marker !== 0xc4 &&
			marker !== 0xc8 &&
			marker !== 0xcc;
		if (isFrameHeader) {
			// length(2), precision(1), height(2), width(2)
			if (segmentLength < 7) return null;
			const height = bytes.readUInt16BE(pos + 5);
			const width = bytes.readUInt16BE(pos + 7);
			if (width === 0 || height === 0) return null;
			return { width, height };
		}
		pos += 2 + segmentLength;
	}
	return null;
}

/**
 * Is this image safe to hand to a server-side decoder?
 *
 * Shared by the upload gate and the PDF render path on purpose. The upload gate
 * stops NEW oversized images; this also lets the render path skip rows that
 * predate the cap, so an image already in the database cannot trigger the
 * blow-up described on `MAX_LOGO_DIMENSION`.
 */
export function isDecodeSafe(bytes: Buffer, mime: string): boolean {
	if (!isAllowedMime(mime)) return false;
	const dims = readImageDimensions(bytes, mime);
	if (!dims) return false;
	return dims.width <= MAX_LOGO_DIMENSION && dims.height <= MAX_LOGO_DIMENSION;
}

// ---------------------------------------------------------------------------
// Metadata read — the SSR agenda-header path. Selects `updatedAt` only.
// ---------------------------------------------------------------------------

export type ClubLogoMeta = { updatedAt: Date };

/**
 * Is this club id one a PUBLIC caller may read logo data for at all?
 *
 * Both logo read paths funnel through here, deliberately. `src/lib/club-archive.ts`
 * states the repo-wide invariant: "every public no-auth club loader must treat
 * [an archived club] as not-found... ANY new public club loader MUST call it
 * too." Both `loadClubLogoMeta` (public via `getClubLogoMeta`) and
 * `loadClubLogoForServing` (public via the GET route) are such loaders.
 *
 * This is ONE function rather than the same two lines in both, because they
 * previously disagreed: the serving path checked archived and the meta path
 * did not, so an archived club's logo 404'd from the route while
 * `getClubLogoMeta` still reported it existed — an anonymous metadata leak,
 * and a broken `<img>` on the admin page for an archived club (whose admin
 * can still reach `/admin/club-settings`, since `effectiveAdminClub` has no
 * archive check). Sharing the gate is what stops them drifting apart again.
 *
 * Archiving is also this feature's takedown lever (ADR-0024 constraint 4), so
 * a read path that ignores it defeats the mechanism the trademark posture
 * leans on.
 */
export async function isReadableClub(clubId: string): Promise<boolean> {
	if (!UUID_RE.test(clubId)) return false;
	const [club] = await db
		.select({ archivedAt: clubs.archivedAt })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	return Boolean(club) && !isClubArchived(club);
}

/**
 * Existence + version for a club's logo — enough to build the versioned
 * `<img src>` URL, nothing more. Deliberately does NOT select `bytes`: this
 * runs on every printed-agenda SSR render, and a 256 KB pull per render would
 * reintroduce, at the query layer, the exact cost the separate table exists
 * to avoid. See `club-logo-logic.integration.test.ts` for the regression
 * guard on this.
 */
export async function loadClubLogoMeta(
	clubId: string,
): Promise<ClubLogoMeta | null> {
	if (!(await isReadableClub(clubId))) return null;
	const [row] = await db
		.select({ updatedAt: clubLogos.updatedAt })
		.from(clubLogos)
		.where(eq(clubLogos.clubId, clubId))
		.limit(1);
	return row ?? null;
}

// ---------------------------------------------------------------------------
// Binary read — the public GET route. 404-shaped: null for unknown club,
// archived club, or no logo.
// ---------------------------------------------------------------------------

/**
 * The bytes + mime for the public logo GET route. Returns null when: the
 * club doesn't exist, the club is ARCHIVED (ADR-0016 — public no-auth
 * loaders return not-found for archived clubs; archiving also doubles as
 * this feature's takedown lever), or no logo has been uploaded. The route
 * turns null into a 404.
 */
export async function loadClubLogoForServing(
	clubId: string,
): Promise<{ bytes: Buffer; mime: string; updatedAt: Date } | null> {
	if (!(await isReadableClub(clubId))) return null;

	const [row] = await db
		.select({
			bytes: clubLogos.bytes,
			mime: clubLogos.mime,
			// Returned so the route can compare the caller's `?v=` against the
			// real version: only a matching one earns the 1-year `immutable`
			// directive. Without that, a bare or stale URL pins bytes in shared
			// caches for a year and a replacement never reaches them.
			updatedAt: clubLogos.updatedAt,
		})
		.from(clubLogos)
		.where(eq(clubLogos.clubId, clubId))
		.limit(1);
	return row ?? null;
}

// ---------------------------------------------------------------------------
// Writes — upload (validate + upsert) and remove.
// ---------------------------------------------------------------------------

export interface ApplyClubLogoUploadInput {
	clubId: string;
	/** Base64-encoded image bytes. Capped on the ENCODED string (mirrors the
	 *  zod validator in `club-logo.ts`) AND, after decoding, on the DECODED
	 *  bytes — see `MAX_ENCODED_LENGTH` / `MAX_LOGO_BYTES` above. */
	base64: string;
	/** Client-declared MIME. Verified against the actual bytes below — never
	 *  trusted on its own. */
	mime: string;
	/** Must be true — the required "I confirm my club is authorized to use
	 *  this image" checkbox, re-validated server-side (ADR-0024 constraint 3:
	 *  attestation is recorded, not just displayed). */
	attested: boolean;
	/** Session user id — persisted as `attestedBy`. */
	userId: string;
	/** The acting member row for the activity log. Null for a superadmin
	 *  acting via impersonation (memberless in the club) — `logActivity`
	 *  attributes that case to the real superadmin instead. */
	actorMemberId: string | null;
}

/**
 * Validate and upsert a club's logo (#495). Order: attestation (cheapest),
 * declared-MIME allow-list, encoded-length cap, decode, decoded-size cap,
 * magic-byte sniff — each independently testable by holding every other
 * input valid.
 *
 * Upsert via `onConflictDoUpdate` on the `club_id` primary key so a replace
 * and a double-submit both converge on exactly one row (real Postgres UPSERT
 * serializes concurrent writers on the row lock — no app-level locking
 * needed).
 */
export async function applyClubLogoUpload(
	input: ApplyClubLogoUploadInput,
): Promise<void> {
	if (!input.attested) {
		throw new Error(
			"You must confirm your club is authorized to use this image.",
		);
	}
	if (!isAllowedMime(input.mime)) {
		throw new Error("Only PNG or JPEG images are supported.");
	}
	if (input.base64.length > MAX_ENCODED_LENGTH) {
		throw new Error("That file is too large to upload.");
	}

	const bytes = Buffer.from(input.base64, "base64");
	if (bytes.length === 0) {
		throw new Error("That file could not be read.");
	}
	if (bytes.length > MAX_LOGO_BYTES) {
		throw new Error("Logo must be 256 KB or smaller.");
	}
	if (!matchesMagicBytes(bytes, input.mime)) {
		throw new Error("That file doesn't look like a valid PNG or JPEG image.");
	}
	// Bytes alone do not bound decode cost — see `MAX_LOGO_DIMENSION`. This is
	// the gate that keeps a 243 KB / 8000x8000 PNG out of a public, server-side
	// PDF render.
	const dimensions = readImageDimensions(bytes, input.mime);
	if (!dimensions) {
		throw new Error("That file doesn't look like a valid PNG or JPEG image.");
	}
	if (
		dimensions.width > MAX_LOGO_DIMENSION ||
		dimensions.height > MAX_LOGO_DIMENSION
	) {
		throw new Error(
			`Logo must be ${MAX_LOGO_DIMENSION}px or smaller on each side (this one is ${dimensions.width}x${dimensions.height}).`,
		);
	}

	const now = new Date();
	await db.transaction(async (tx) => {
		await tx
			.insert(clubLogos)
			.values({
				clubId: input.clubId,
				bytes,
				mime: input.mime,
				updatedAt: now,
				attestedBy: input.userId,
				attestedAt: now,
			})
			.onConflictDoUpdate({
				target: clubLogos.clubId,
				set: {
					bytes,
					mime: input.mime,
					updatedAt: now,
					attestedBy: input.userId,
					attestedAt: now,
				},
			});
		// Same transaction as the write: an audit entry that can disagree with
		// the row it describes is worse than none. `detail` carries shape only,
		// never the image bytes.
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: input.actorMemberId,
			action: "club_logo_set",
			targetType: "club",
			targetId: input.clubId,
			detail: { mime: input.mime, bytes: bytes.length },
		});
	});
}

/**
 * Delete a club's logo. A no-op (not an error) when none exists.
 *
 * Logged even though the row is gone: `club_logos.attested_by`/`attested_at`
 * are destroyed by this delete, so without an activity entry a removal leaves
 * no record of who did it — the one moment ADR-0024's "act on a complaint"
 * story most needs one.
 */
export async function removeClubLogo(
	clubId: string,
	actorMemberId: string | null,
): Promise<void> {
	await db.transaction(async (tx) => {
		const removed = await tx
			.delete(clubLogos)
			.where(eq(clubLogos.clubId, clubId))
			.returning({ clubId: clubLogos.clubId });
		// Only log a removal that actually removed something, so a repeated
		// no-op click doesn't pad the club's activity feed.
		if (removed.length === 0) return;
		await logActivity(tx, {
			clubId,
			actorMemberId,
			action: "club_logo_removed",
			targetType: "club",
			targetId: clubId,
		});
	});
}
