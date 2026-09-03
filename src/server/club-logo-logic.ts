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
import { clubLogos } from "#/db/schema";
import {
	type AllowedLogoMime,
	isAllowedLogoMime,
	MAX_ENCODED_LENGTH,
	MAX_LOGO_BYTES,
	MAX_LOGO_DIMENSION,
	MAX_LOGO_KB,
} from "#/lib/club-logo-limits";
import { readImageDimensions } from "#/lib/image-dimensions";
import { logActivity } from "./activity";
import { isReadableClub } from "./club-readable-logic";

// Limits come from `#/lib/club-logo-limits` and the header parser from
// `#/lib/image-dimensions`; neither is re-declared here. Both are shared with
// the client on purpose — see those modules for why.

// Magic-byte signatures. The declared `mime` is client-supplied and cannot be
// trusted on its own (constraint from the trademark/security review: an SVG
// renamed to `logo.png` must still be rejected) — this checks what the bytes
// actually are.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

function matchesMagicBytes(bytes: Buffer, mime: AllowedLogoMime): boolean {
	if (mime === "image/png") {
		return bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
	}
	return bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE);
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
	if (!isAllowedLogoMime(mime)) return false;
	const dims = readImageDimensions(bytes, mime);
	if (!dims) return false;
	return dims.width <= MAX_LOGO_DIMENSION && dims.height <= MAX_LOGO_DIMENSION;
}

// ---------------------------------------------------------------------------
// Metadata read — the SSR agenda-header path. Selects `updatedAt` only.
// ---------------------------------------------------------------------------

export type ClubLogoMeta = { updatedAt: Date };

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
	 *  bytes — see `MAX_ENCODED_LENGTH` / `MAX_LOGO_BYTES` in
	 *  `#/lib/club-logo-limits`. */
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
	if (!isAllowedLogoMime(input.mime)) {
		throw new Error("Only PNG or JPEG images are supported.");
	}
	// Repeats the zod `.max()` in `club-logo.ts` deliberately: that schema is the
	// primary enforcement, but a `createServerFn` wrapper can't be invoked from
	// this repo's tests (see `bulk-import.integration.test.ts`), so checking here
	// makes the limit independently testable and keeps this function from relying
	// on a caller-side check for a load-bearing bound.
	if (input.base64.length > MAX_ENCODED_LENGTH) {
		throw new Error("That file is too large to upload.");
	}

	const bytes = Buffer.from(input.base64, "base64");
	if (bytes.length === 0) {
		throw new Error("That file could not be read.");
	}
	if (bytes.length > MAX_LOGO_BYTES) {
		throw new Error(`Logo must be ${MAX_LOGO_KB} KB or smaller.`);
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
