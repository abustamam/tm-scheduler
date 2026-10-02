// Minutes-email recipient resolution + draft text, split out from the
// createServerFn wrapper in `minutes-email.ts`. These are plain, directly
// unit-testable functions (the wrapper needs the Start runtime). They MUST live
// here, away from the server-fn module, because `minutes-email.ts` is imported
// by client route files: the Start compiler strips the createServerFn handler
// bodies (and their `db` imports) from the client bundle, but a plain
// db-touching export in that same module is NOT stripped and drags `pg` →
// `Buffer` into the browser. See `members-logic.ts` for the same split.
//
// This module has NO db access and no transport. GavelUp does not send the
// minutes (#903): the officer does, from a `mailto:` draft built client-side by
// `buildMinutesMailto` (`#/lib/minutes-mailto`), and the subject and body below
// are that draft's defaults. The data comes through the injected
// `MinutesEmailPort`.

import { formatMeetingDate } from "#/lib/format";

// ---------------------------------------------------------------------------
// Port — the seam to the roster + attendance data.
// ---------------------------------------------------------------------------

/**
 * The data the minutes draft needs, injected so resolution stays pure and
 * unit-testable with a mock. The concrete implementation lives in
 * `minutes-email-port-logic.ts` (queries the active roster and the present
 * guests in `meeting_attendance`).
 */
export interface MinutesEmailPort {
	/** Active members + guests marked present for the meeting, each with an
	 *  email that may be null (missing email → skipped, never an error). */
	loadRecipients(meetingId: string): Promise<{
		members: { name: string; email: string | null }[];
		presentGuests: { name: string; email: string | null }[];
	}>;
}

// ---------------------------------------------------------------------------
// Recipient resolution — a PURE function (no db, no port).
// ---------------------------------------------------------------------------

export interface RecipientEntry {
	name: string;
	email: string | null;
}

/** A recipient with a confirmed non-empty email (goes in the draft's bcc). */
export interface ResolvedRecipient {
	name: string;
	email: string;
}

export interface ResolvedRecipients {
	recipients: ResolvedRecipient[];
	skipped: { name: string }[];
}

/**
 * Split members + present guests into those with an email (recipients) and
 * those without (skipped, surfaced as "no email on file"). A missing/blank
 * email NEVER blocks the draft — it just moves the person to `skipped`. Pure and
 * order-preserving (members first, then guests).
 */
export function resolveMinutesRecipients(input: {
	members: RecipientEntry[];
	presentGuests: RecipientEntry[];
}): ResolvedRecipients {
	const recipients: ResolvedRecipient[] = [];
	const skipped: { name: string }[] = [];
	for (const entry of [...input.members, ...input.presentGuests]) {
		const email = entry.email?.trim();
		if (email) {
			recipients.push({ name: entry.name, email });
		} else {
			skipped.push({ name: entry.name });
		}
	}
	return { recipients, skipped };
}

// ---------------------------------------------------------------------------
// Subject / body builders — the draft's defaults. Pure helpers.
// ---------------------------------------------------------------------------

/** `"<Club name> — Minutes for <formatted date>"`.
 *
 * Both builders name the meeting's day in the CLUB's zone (#1017). They run in
 * the officer's browser, so with no zone an evening meeting in Los Angeles,
 * drafted from Tokyo, was the next day's minutes. */
export function buildMinutesSubject(
	clubName: string,
	meetingDate: Date,
	timeZone: string,
): string {
	return `${clubName} — Minutes for ${formatMeetingDate(meetingDate, timeZone)}`;
}

/** A short default body (plain text). The officer edits it in the dialog. */
export function buildMinutesBody(
	clubName: string,
	meetingDate: Date,
	timeZone: string,
): string {
	return (
		`Hi,\n\n` +
		`Attached are the minutes for ${clubName}'s meeting on ${formatMeetingDate(meetingDate, timeZone)}.\n\n` +
		`Thanks,\n${clubName}`
	);
}
