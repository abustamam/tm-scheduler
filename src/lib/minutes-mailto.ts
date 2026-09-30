// Pure, client-safe construction of the minutes email DRAFT (#903).
//
// The minutes used to leave through GavelUp's own transport. Every message to a
// person is now sent by a human, so the app composes a `mailto:` the officer
// opens in their OWN mail app, reviews, attaches the guest copy to, and sends.
//
// Two properties this module exists to hold:
//
//   - Every recipient goes in `bcc`, and `to` is empty. The old send put the
//     whole list in `to:`, so every member and every self-registered guest saw
//     everyone else's address.
//   - Every address goes through `mailtoHref`'s escaping. Everything after the
//     first `?` of a `mailto:` URL is HEADERS, so a stored address carrying its
//     own `?bcc=…&body=…` would otherwise add a recipient or rewrite the message.
//     `mailto.guard.test.ts` confines the raw construction to `#/lib/mailto`;
//     this module never spells the scheme itself, it takes it from there.
import { mailtoHref } from "#/lib/mailto";

/**
 * Past this many characters, some mail apps open a `mailto:` draft with the
 * addresses (or the whole link) dropped. The dialog says so and points at
 * "Copy addresses" rather than pretending the draft is complete.
 */
export const MINUTES_MAILTO_WARN_LENGTH = 1900;

/** `mailto:` as `mailtoHref` spells it, so the scheme has one home. */
const SCHEME = mailtoHref("");

/** One address, escaped exactly as `mailtoHref` escapes it, minus the scheme. */
function escapeAddress(email: string): string {
	return mailtoHref(email).slice(SCHEME.length);
}

/** Trimmed, non-empty, first occurrence wins (case-insensitive). */
function uniqueAddresses(recipients: readonly { email: string }[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const r of recipients) {
		const email = r.email.trim();
		if (!email) continue;
		const key = email.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(email);
	}
	return out;
}

/**
 * The comma-separated address list "Copy addresses" puts on the clipboard, for
 * pasting into the BCC field of a mail app that ignored a long `mailto:`. Plain
 * text, not URL-escaped: it is pasted, never parsed as a URL.
 */
export function minutesBccList(
	recipients: readonly { email: string }[],
): string {
	return uniqueAddresses(recipients).join(", ");
}

/**
 * A `mailto:` draft of the minutes email: empty `to`, every recipient in `bcc`,
 * and the officer's subject and body. Line breaks in the body are sent as CRLF,
 * which is what RFC 6068 asks a `mailto:` body to use.
 */
export function buildMinutesMailto(input: {
	recipients: readonly { email: string }[];
	subject: string;
	body: string;
}): string {
	const headers: string[] = [];
	const bcc = uniqueAddresses(input.recipients).map(escapeAddress).join(",");
	if (bcc) headers.push(`bcc=${bcc}`);
	headers.push(`subject=${encodeURIComponent(input.subject)}`);
	headers.push(
		`body=${encodeURIComponent(input.body.replace(/\r?\n/g, "\r\n"))}`,
	);
	return `${SCHEME}?${headers.join("&")}`;
}
