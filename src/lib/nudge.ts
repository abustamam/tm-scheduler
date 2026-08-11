// Pure, client-safe helper (#37) that composes a person-to-person nudge for a
// role — a `wa.me` and/or `mailto:` draft a VPE opens in their OWN app and then
// edits and sends. NO `#/db` here so the meeting-detail client route can call it.
// The app only ever DRAFTS; the human sends.

import { mailtoHref } from "#/lib/mailto";
import { greetingName } from "#/lib/person-name";
import type { Platform } from "#/lib/platform";
import { whatsappHref } from "#/lib/whatsapp";

export type NudgeMode = "confirm" | "recruit";

export interface NudgeInput {
	name: string;
	/**
	 * What this person is actually called, when it isn't the first token of
	 * `name` (#486). Absent/null/blank falls back to that first token.
	 */
	preferredName?: string | null;
	/** E.164-ish free text; may be null/absent. */
	phone?: string | null;
	email?: string | null;
	roleName: string;
	/** Already formatted friendly, in the club's timezone (footerDate). */
	meetingDate: string;
	/** Absolute public meeting URL (caller prepends window.location.origin). */
	shareUrl: string;
	mode: NudgeMode;
	/**
	 * Which WhatsApp entry point to link (#485). Defaults to `"mobile"` — the
	 * historical `wa.me` behavior — so a caller that cannot detect the platform
	 * is no worse off than before. `detectPlatform` (`#/lib/platform`) supplies
	 * it in the browser.
	 */
	platform?: Platform;
}

export interface Nudge {
	message: string;
	/** Omitted when the target has no phone. */
	whatsappUrl?: string;
	/** Omitted when the target has no email. */
	mailtoUrl?: string;
}

function messageFor(i: NudgeInput): string {
	// Greet by first/preferred name — "Hi Zabihullah Kogyani," reads like a mail
	// merge, which undercuts a draft whose whole point is that a human wrote it.
	const who = greetingName(i);
	return i.mode === "confirm"
		? `Hi ${who}, just confirming you're our ${i.roleName} for the ${i.meetingDate} meeting. Details: ${i.shareUrl}`
		: `Hi ${who}, would you be open to taking ${i.roleName} at our ${i.meetingDate} meeting? Info here: ${i.shareUrl}`;
}

function subjectFor(i: NudgeInput): string {
	return i.mode === "confirm"
		? `Confirming your ${i.roleName} role — ${i.meetingDate}`
		: `Open ${i.roleName} role — ${i.meetingDate} meeting?`;
}

export function buildNudge(input: NudgeInput): Nudge {
	const message = messageFor(input);
	const nudge: Nudge = { message };

	// `whatsappHref` returns null when there is no number, which is exactly when
	// `whatsappUrl` should be absent from the result.
	const whatsappUrl = whatsappHref(
		input.phone,
		input.platform ?? "mobile",
		message,
	);
	if (whatsappUrl) nudge.whatsappUrl = whatsappUrl;

	if (input.email) {
		// `mailtoHref` for the ADDRESS, then this module's own headers. Raw
		// interpolation here was the fourth and worst `mailto:` sink: the three
		// display links elsewhere are addresses a reader looks at, while this is a
		// pre-composed draft a VPE taps to SEND. A stored
		// `ada@club.org?bcc=attacker@evil.com` produced a live `bcc` header AND
		// swallowed this app's own `subject=` into the injected `body`, so the
		// message that opened was neither private nor the one it claimed to be.
		//
		// Reachable: `members.email` has a free-text writer (`bulkImportSchema` is
		// `z.string()`, no `.email()`), and `NudgeButtons` is fed that column via
		// `slot.holderEmail` on the meeting agenda and the recruit picker.
		//
		// `mailtoHref` escapes `?`, `&` and `#` and leaves `@` alone, so the `?`
		// that opens the header section below is the FIRST one in the URL — which
		// is the whole property this needs. `mailto.guard.test.ts` fails if a fifth
		// sink appears.
		nudge.mailtoUrl = `${mailtoHref(input.email)}?subject=${encodeURIComponent(
			subjectFor(input),
		)}&body=${encodeURIComponent(message)}`;
	}

	return nudge;
}
