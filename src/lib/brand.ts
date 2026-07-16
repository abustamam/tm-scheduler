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
 * The "Request access" mailto used by the invite-only front door (`index.tsx`)
 * and the signed-in "you're not in a club yet" screen (#267). Single source of
 * truth so the support address can't drift between surfaces.
 */
export const ACCESS_REQUEST_MAILTO =
	"mailto:rasheed.bustamam@gmail.com?subject=GavelUp%20access%20request";
