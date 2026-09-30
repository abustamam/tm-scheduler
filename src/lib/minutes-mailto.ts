// Pure, client-safe construction of the minutes email DRAFT (#903).
//
// The minutes used to leave through GavelUp's own transport. Every message to a
// person is now sent by a human, so the app composes a `mailto:` the officer
// opens in their OWN mail app, reviews, attaches the guest copy to, and sends.
//
// Three properties this module exists to hold:
//
//   - Every recipient goes in `bcc`, and `to` is empty. The old send put the
//     whole list in `to:`, so every member and every self-registered guest saw
//     everyone else's address.
//   - Every recipient is ONE mailbox. A stored `a@x.org,b@evil.example` is not
//     rescued by escaping: mail clients decode `%2C` BEFORE splitting the
//     address list, so it arrives as two recipients — and "Copy addresses"
//     pastes the comma raw. The same holds for `;` (Outlook's separator) and
//     for whitespace / CR / LF. The removed server send rejected these with
//     `z.string().email()`; nothing validates stored addresses on the way here
//     now, so {@link partitionMinutesRecipients} does, and anything it rejects
//     is shown to the officer as not included rather than dropped silently.
//   - Every address goes through `mailtoHref`'s escaping, as defence in depth:
//     an atext local part may legally carry `?`, `=` and `&`, and everything
//     after the first `?` of a `mailto:` URL is HEADERS.
//
// `mailto.guard.test.ts` confines the raw `mailto:` construction to
// `#/lib/mailto`. This module takes the scheme from `mailtoHref("")`, so that
// guard's pattern cannot see it at all — this file's own unit tests are the
// gate for it.
import { mailtoHref } from "#/lib/mailto";

/**
 * Past this many characters, some mail apps open a `mailto:` draft with the
 * addresses (or the whole link) dropped. The dialog says so and points at
 * "Copy addresses" rather than pretending the draft is complete.
 */
export const MINUTES_MAILTO_WARN_LENGTH = 1900;

/** `mailto:` as `mailtoHref` spells it, so the scheme has one home. */
const SCHEME = mailtoHref("");

/**
 * One mailbox, and nothing that could become a second one: an RFC 5322 atext
 * local part (no `,` `;` whitespace, quotes or angle brackets) and a dotted
 * hostname. Deliberately stricter than the RFC — a quoted local part or an IP
 * literal is not something a club roster holds, and a false rejection is shown
 * to the officer, who can add the address by hand.
 */
const SINGLE_MAILBOX =
	/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** Whether a stored address is exactly one mailbox (surrounding space trimmed). */
export function isSingleMailbox(email: string): boolean {
	return SINGLE_MAILBOX.test(email.trim());
}

/**
 * Split recipients into those that can go in the draft and those that cannot.
 * `invalid` is for DISPLAY: the officer must be told who is not on the draft.
 */
export function partitionMinutesRecipients<T extends { email: string }>(
	recipients: readonly T[],
): { valid: T[]; invalid: T[] } {
	const valid: T[] = [];
	const invalid: T[] = [];
	for (const r of recipients) {
		(isSingleMailbox(r.email) ? valid : invalid).push(r);
	}
	return { valid, invalid };
}

/** Valid only, trimmed, first occurrence wins (case-insensitive). */
function draftAddresses(recipients: readonly { email: string }[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const r of partitionMinutesRecipients(recipients).valid) {
		const email = r.email.trim();
		const key = email.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(email);
	}
	return out;
}

/** One address, escaped exactly as `mailtoHref` escapes it, minus the scheme. */
function escapeAddress(email: string): string {
	return mailtoHref(email).slice(SCHEME.length);
}

/**
 * The comma-separated address list "Copy addresses" puts on the clipboard, for
 * pasting into the BCC field of a mail app that ignored a long `mailto:`. Plain
 * text, not URL-escaped: it is pasted, never parsed as a URL — which is exactly
 * why an address carrying its own separator must never reach it.
 */
export function minutesBccList(
	recipients: readonly { email: string }[],
): string {
	return draftAddresses(recipients).join(", ");
}

/**
 * A `mailto:` draft of the minutes email: empty `to`, every valid recipient in
 * `bcc`, and the officer's subject and body. A blank subject falls back to
 * `defaultSubject`, as the removed server send did. Line breaks in the body are
 * sent as CRLF, which is what RFC 6068 asks a `mailto:` body to use.
 */
export function buildMinutesMailto(input: {
	recipients: readonly { email: string }[];
	subject: string;
	defaultSubject: string;
	body: string;
}): string {
	const headers: string[] = [];
	const bcc = draftAddresses(input.recipients).map(escapeAddress).join(",");
	if (bcc) headers.push(`bcc=${bcc}`);
	const subject = input.subject.trim() || input.defaultSubject;
	headers.push(`subject=${encodeURIComponent(subject)}`);
	headers.push(
		`body=${encodeURIComponent(input.body.replace(/\r?\n/g, "\r\n"))}`,
	);
	return `${SCHEME}?${headers.join("&")}`;
}
