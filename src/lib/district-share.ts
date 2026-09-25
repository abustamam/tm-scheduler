// The "Share with your clubs" block on `/districts` (#868). Pure and
// client-safe: no `#/db`, no `window`.
//
// A district director forwards a short message to their club presidents. The
// link in it carries `?ref=district-<d>`, which `captureRef` (#866) stores on
// the first marketing page the president lands on and the request-access form
// sends along, so a lead from that district's push is recognisable.

/**
 * A district identifier: 1–4 letters or digits. Toastmasters districts are
 * numbered (`57`), and the handful of provisional/lettered ones (`F`, `U`) fit
 * the same shape. Anything else (spaces, punctuation) is refused so the ref it
 * mints always satisfies `marketing-ref`'s `REF_PATTERN`.
 */
export const DISTRICT_PATTERN = /^[0-9A-Za-z]{1,4}$/;

export function isValidDistrict(d: string): boolean {
	return DISTRICT_PATTERN.test(d);
}

/**
 * `${origin}/?ref=district-<d, lowercased>`. `origin` is
 * `window.location.origin` on the client; passing `""` yields the relative
 * path, which is what the block shows before mount (no origin during SSR).
 * Lowercased because `REF_PATTERN` is lowercase-only.
 */
export function buildDistrictShareLink(origin: string, d: string): string {
	return `${origin}/?ref=district-${d.toLowerCase()}`;
}

/** The message a director forwards, ending in the share link. */
export function DISTRICT_SHARE_BLURB(link: string): string {
	return `Worth a look for your club: GavelUp is a meeting tool built by a fellow Toastmaster. Members claim roles from one shared sheet with no account to create, and officers print or project the agenda in a click. It's free for clubs during the pilot. ${link}`;
}
