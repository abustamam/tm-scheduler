// GavelUp brand + trademark strings. Client-safe (NO `#/db`) so every surface —
// web footers, signin, and the present/print/PPTX outputs — can import the one
// canonical copy.

/**
 * The canonical Toastmasters International non-affiliation disclaimer (#256).
 *
 * This is the single source of truth for the wording — every surface that shows
 * Toastmasters branding imports this constant rather than copy-pasting the text,
 * so the legal wording can never drift between the web app and the meeting
 * outputs. Wording is maintainer-approved; do not edit without sign-off.
 *
 * Whether GavelUp may reproduce TI's *official logo* at all is a separate,
 * unresolved legal decision (#257) — this string does not settle it.
 */
export const TOASTMASTERS_DISCLAIMER =
	'GavelUp is an independent product and is not affiliated with, endorsed by, or sponsored by Toastmasters International. "Toastmasters International," "Toastmasters," and related trademarks are the property of Toastmasters International.';

/**
 * The inbox access requests (#866) and support contact both land in. Bare
 * address, so the server can send to it. {@link CONTACT_MAILTO} spells the same
 * address as a static literal (`mailto.guard.test.ts` forbids gluing a value
 * onto the scheme outside `mailto.ts`), and `request-access.test.tsx` pins that
 * the two still name one inbox.
 */
export const ACCESS_REQUEST_NOTIFY_EMAIL = "rasheed.bustamam@gmail.com";

/**
 * A plain "contact us" mailto, for support questions (the club-logo
 * attestation note, the request form's "busy" fallback). NOT the way to ask
 * for access: that is the `/request-access` form (#866), which saves a row and
 * emails {@link ACCESS_REQUEST_NOTIFY_EMAIL}.
 */
export const CONTACT_MAILTO =
	"mailto:rasheed.bustamam@gmail.com?subject=GavelUp";

/** Short founder line for marketing pages. Only facts the maintainer has confirmed. */
export const FOUNDER_BLURB =
	"GavelUp is built by Rasheed Bustamam, a Toastmaster since 2012 and a Distinguished Toastmaster (DTM).";

/** The pilot cost line for marketing pages. Shown today on `/`, under the hero. */
export const PILOT_PRICING_LINE =
	"Free for clubs during the pilot. Running a district? Ask us about it.";
