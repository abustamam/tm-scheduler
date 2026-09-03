/**
 * The club-logo upload limits — the ONE declaration of every number and type
 * the client and the server both have to agree about (#504).
 *
 * No `#/db` import, so client code can import this without dragging `pg` →
 * `Buffer` into the browser bundle. Same precedent this feature already set
 * twice: `club-archive.ts` and `club-logo-url.ts`.
 *
 * ## Why this module exists rather than four `const`s
 *
 * These limits were declared independently in four places — the byte cap in
 * `club-logo-logic.ts` AND in `club-settings.tsx`, the encoded cap in
 * `club-logo-logic.ts` AND inline in `club-logo.ts`'s zod schema, the MIME
 * allow-list in two of those, and the pixel cap in exactly one. Nothing
 * enforced agreement except a comment saying "keep these in sync" and
 * identifier names that LOOK shared but resolve to different symbols.
 *
 * That is not a hypothetical hazard: it had already drifted. #496 added
 * `MAX_LOGO_DIMENSION` server-side and the client never learned it, so a club
 * admin could pick a 4000px logo, watch the client accept it, base64 the whole
 * thing, and get a rejection only after the upload round-trip.
 *
 * So the rule is: a limit lives here, and every consumer IMPORTS it.
 * `club-logo-limits.guard.test.ts` fails on any file that re-declares one of
 * these names, because a matching identifier in four files is precisely what
 * failed the first time.
 *
 * User-visible copy is derived from these too (`CLUB_LOGO_COPY` in
 * `club-settings.tsx`, and the server's rejection messages), so a raised cap
 * cannot leave "up to 256KB" behind as a lie.
 */

/**
 * 256 KiB — the DECODED-bytes cap.
 *
 * Separate from {@link MAX_ENCODED_LENGTH} on purpose: base64 inflates size
 * ~33%, so the two numbers are not the same number expressed twice.
 */
export const MAX_LOGO_BYTES = 256 * 1024;

/**
 * {@link MAX_LOGO_BYTES} in whole KiB. A FORMATTING helper, not a fourth limit:
 * nothing enforces it and no caller compares against it — it exists so the three
 * user-facing messages that name the cap interpolate one value instead of three
 * hand-written ones. Keep the byte cap a whole multiple of 1024 or the copy
 * grows a decimal; `club-logo-limits.test.ts` asserts that.
 */
export const MAX_LOGO_KB = MAX_LOGO_BYTES / 1024;

/**
 * The cap on the base64 STRING, checked before anything is decoded — by the
 * zod validator in `club-logo.ts` and again in `applyClubLogoUpload` (which
 * must not depend on a caller-side check for a load-bearing limit, since a
 * `createServerFn` wrapper cannot be invoked from this repo's tests).
 *
 * Deliberately SLACK rather than derived. {@link MAX_LOGO_BYTES} of data
 * encodes to exactly `Math.ceil(262144 / 3) * 4` = 349,528 chars, and setting
 * this to that exact value would make the decoded check unreachable — the
 * encoded cap would reject first, every time, with the vaguer "too large to
 * upload" message instead of "Logo must be 256 KB or smaller." The two checks
 * are a deliberate outer/inner pair, so this one has to sit above the exact
 * encoding of the inner one. `club-logo-limits.test.ts` asserts that ordering
 * rather than trusting whoever next edits either number.
 */
export const MAX_ENCODED_LENGTH = 350_000;

/**
 * The declared-MIME allow-list. The server additionally sniffs magic bytes
 * (`club-logo-logic.ts`) — a client-declared MIME is never trusted on its own,
 * so an SVG renamed `logo.png` is still rejected there.
 */
export const ALLOWED_LOGO_MIME_TYPES = ["image/png", "image/jpeg"] as const;

export type AllowedLogoMime = (typeof ALLOWED_LOGO_MIME_TYPES)[number];

export function isAllowedLogoMime(mime: string): mime is AllowedLogoMime {
	return (ALLOWED_LOGO_MIME_TYPES as readonly string[]).includes(mime);
}

/**
 * Pixel-dimension cap, enforced ALONGSIDE {@link MAX_LOGO_BYTES} rather than
 * instead of it. The two bound different costs and neither implies the other.
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
 * `club-logo-limits.test.ts` pins it as an ABSOLUTE ceiling, because a test
 * written relative to this constant passes for every value of it — including
 * one that reintroduces the OOM.
 */
export const MAX_LOGO_DIMENSION = 2000;
