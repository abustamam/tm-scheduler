/**
 * Pure builders for the VPE "tap-to-nudge" (spec §7, issue #37): turn a member's
 * contact info + the public sign-up-sheet link into ready-to-open WhatsApp
 * (`wa.me`) and email (`mailto:`) URLs, prefilled with a friendly message.
 *
 * These run entirely client-side in the signed-in VPE's browser, from contact
 * the VPE can already see — no PII crosses a network boundary here, and nothing
 * in this module is imported by any public/anonymous payload. Kept pure so the
 * message + URL encoding is unit-testable in isolation from React.
 */

export interface NudgeInput {
	/** The member being nudged — used to personalize the greeting. */
	memberName: string;
	/** The club name, for a friendlier message. Optional. */
	clubName?: string | null;
	/** Absolute URL to the public sign-up sheet / meeting page. */
	link: string;
	/** Member email, if on file. */
	email?: string | null;
	/** Member phone, if on file. */
	phone?: string | null;
}

export interface NudgeLinks {
	/** The prefilled message body (shared by WhatsApp + email). */
	message: string;
	/** The email subject line. */
	subject: string;
	/** `wa.me` deep link, or null when there's no usable phone number. */
	whatsappHref: string | null;
	/** `mailto:` link, or null when there's no email on file. */
	mailtoHref: string | null;
}

/** First name only, for the greeting. Falls back to "there". */
export function firstName(name: string): string {
	const first = name.trim().split(/\s+/)[0];
	return first ? first : "there";
}

/**
 * Reduce a phone number to the digits `wa.me` expects (international format, no
 * "+", spaces, or punctuation). Returns null when there aren't enough digits to
 * be a real number, so the caller can hide the WhatsApp option rather than emit
 * a broken link.
 */
export function toWhatsappNumber(
	phone: string | null | undefined,
): string | null {
	if (!phone) return null;
	// Drop the leading "+" and all punctuation (spaces, dashes, parens). We can't
	// infer a country code, so the stored number is trusted to already be
	// dialable — wa.me simply wants the bare digits.
	const digits = phone.replace(/\D/g, "");
	return digits.length >= 7 ? digits : null;
}

/** The friendly nudge body: greeting + open-roles ask + the shareable link. */
export function buildNudgeMessage(input: {
	memberName: string;
	clubName?: string | null;
	link: string;
}): string {
	const who = firstName(input.memberName);
	const club = input.clubName?.trim();
	const where = club ? ` at ${club}` : "";
	return `Hi ${who}! We've still got open roles${where} coming up — grab one here: ${input.link}`;
}

/** The email subject line for a nudge. */
export function buildNudgeSubject(clubName?: string | null): string {
	const club = clubName?.trim();
	return club ? `Open roles at ${club}` : "Open roles coming up";
}

/** A `wa.me` deep link with the message URL-encoded, or null with no phone. */
export function whatsappHref(
	phone: string | null | undefined,
	message: string,
): string | null {
	const num = toWhatsappNumber(phone);
	if (!num) return null;
	return `https://wa.me/${num}?text=${encodeURIComponent(message)}`;
}

/** A `mailto:` link, or null when there's no email on file. */
export function mailtoHref(
	email: string | null | undefined,
	subject: string,
	body: string,
): string | null {
	const addr = email?.trim();
	if (!addr) return null;
	// mailto query params must percent-encode spaces as %20 (encodeURIComponent),
	// NOT "+" (which URLSearchParams emits and many mail clients render literally,
	// per RFC 6068). The address itself is a valid addr-spec and is left as-is.
	const query = `subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
	return `mailto:${addr}?${query}`;
}

/**
 * Build both nudge deep links from a member's contact + the shareable link. Each
 * href is null when the corresponding channel isn't available, so the UI can
 * render only the options that will actually work.
 */
export function buildNudge(input: NudgeInput): NudgeLinks {
	const message = buildNudgeMessage(input);
	const subject = buildNudgeSubject(input.clubName);
	return {
		message,
		subject,
		whatsappHref: whatsappHref(input.phone, message),
		mailtoHref: mailtoHref(input.email, subject, message),
	};
}
