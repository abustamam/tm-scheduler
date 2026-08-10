// The WhatsApp entry point for a platform (#485). `wa.me` is a DEVICE
// redirector: on a phone it hands off to the installed app, but on a desktop it
// lands on an "open in app" interstitial that is a dead end without the desktop
// client. Desktop therefore goes straight to WhatsApp Web.
//
// Pure and client-safe (no `#/db`, no React) so `#/lib/nudge` and the
// `WhatsAppPhoneLink` component both import it. This is the ONLY copy of that
// rule — it was private to `nudge.ts` until every rendered phone became a
// WhatsApp link and a second copy would have been the obvious next step.

import type { Platform } from "#/lib/platform";

/**
 * WhatsApp needs full international digits (country code, no `+`).
 *
 * Strips to digits VERBATIM — it does not repair a missing country code or a
 * `00` international prefix. Producing a dialable number is the caller's job
 * (`toE164` + `loadClubDefaultCountryCode`, server-side; see the spec's
 * "Normalize server-side" decision). A national number reaching here yields a
 * link WhatsApp rejects VISIBLY, which is why the test fixtures include the
 * un-normalized shapes this database still holds.
 */
function digitsOf(phone: string): string {
	return phone.replace(/\D/g, "");
}

/**
 * A link that opens a WhatsApp conversation with `phone`, or `null` when there
 * is no number to open one with (empty, or no digits at all).
 *
 * `message` prefills the compose box; OMIT it to open a blank chat. The nudge
 * drafts (#37) pass one; the roster/sign-up-sheet/profile links deliberately do
 * not — they have no role or meeting context, so a prefill would be filler.
 */
export function whatsappHref(
	phone: string | null | undefined,
	platform: Platform,
	message?: string,
): string | null {
	const digits = phone ? digitsOf(phone) : "";
	if (!digits) return null;

	// Query-parameter ORDER is preserved exactly as `nudge.ts` built it, so the
	// golden assertions in `nudge.test.ts` still pin the same strings across this
	// extraction.
	const text = message ? `text=${encodeURIComponent(message)}` : "";
	if (platform === "desktop") {
		return `https://web.whatsapp.com/send/?phone=${digits}${
			text ? `&${text}` : ""
		}&type=phone_number&app_absent=0`;
	}
	return `https://wa.me/${digits}${text ? `?${text}` : ""}`;
}
