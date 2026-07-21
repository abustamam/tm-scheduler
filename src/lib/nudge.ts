// Pure, client-safe helper (#37) that composes a person-to-person nudge for a
// role — a `wa.me` and/or `mailto:` draft a VPE opens in their OWN app and then
// edits and sends. NO `#/db` here so the meeting-detail client route can call it.
// The app only ever DRAFTS; the human sends.

export type NudgeMode = "confirm" | "recruit";

export interface NudgeInput {
	name: string;
	/** E.164-ish free text; may be null/absent. */
	phone?: string | null;
	email?: string | null;
	roleName: string;
	/** Already formatted friendly, in the club's timezone (footerDate). */
	meetingDate: string;
	/** Absolute public meeting URL (caller prepends window.location.origin). */
	shareUrl: string;
	mode: NudgeMode;
}

export interface Nudge {
	message: string;
	/** Omitted when the target has no phone. */
	whatsappUrl?: string;
	/** Omitted when the target has no email. */
	mailtoUrl?: string;
}

function messageFor(i: NudgeInput): string {
	return i.mode === "confirm"
		? `Hi ${i.name}, just confirming you're our ${i.roleName} for the ${i.meetingDate} meeting. Details: ${i.shareUrl}`
		: `Hi ${i.name}, would you be open to taking ${i.roleName} at our ${i.meetingDate} meeting? Info here: ${i.shareUrl}`;
}

function subjectFor(i: NudgeInput): string {
	return i.mode === "confirm"
		? `Confirming your ${i.roleName} role — ${i.meetingDate}`
		: `Open ${i.roleName} role — ${i.meetingDate} meeting?`;
}

/**
 * `wa.me` needs full international digits (country code, no `+`). We strip to
 * digits best-effort — a number stored without a country code produces a link
 * WhatsApp rejects VISIBLY, and the caller always offers Email as a fallback.
 * Reliable normalization is tracked as a follow-up (club default country code
 * + E.164 input standardization).
 */
function waDigits(phone: string): string {
	return phone.replace(/\D/g, "");
}

export function buildNudge(input: NudgeInput): Nudge {
	const message = messageFor(input);
	const nudge: Nudge = { message };

	const digits = input.phone ? waDigits(input.phone) : "";
	if (digits) {
		nudge.whatsappUrl = `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
	}

	if (input.email) {
		nudge.mailtoUrl = `mailto:${input.email}?subject=${encodeURIComponent(
			subjectFor(input),
		)}&body=${encodeURIComponent(message)}`;
	}

	return nudge;
}
