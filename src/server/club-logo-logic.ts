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
async function isReadableClub(clubId: string): Promise<boolean> {
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
