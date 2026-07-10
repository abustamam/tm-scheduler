// Minutes-email orchestration + recipient resolution, split out from the
// createServerFn wrappers in `minutes-email.ts`. These are plain, directly
// unit-testable functions (the wrappers need the Start runtime). They MUST live
// here, away from the server-fn module, because `minutes-email.ts` is imported
// by client route/component files: the Start compiler strips the createServerFn
// handler bodies (and their `db` imports) from the client bundle, but a plain
// db-touching export in that same module is NOT stripped and drags `pg` →
// `Buffer` into the browser. See `members-logic.ts` for the same split.
//
// This module has NO direct db access of its own — all data comes through the
// injected `MinutesEmailPort`, so it stays parallel-safe against #152 (whose
// `meeting_attendance` table + PDF renderer supply the port at integration).

import type { SendEmailParams } from "#/lib/email";
import { formatMeetingDate } from "#/lib/format";

// ---------------------------------------------------------------------------
// Port — the seam to #152's minutes data + PDF renderer. Wired at integration.
// ---------------------------------------------------------------------------

/**
 * The data/rendering the minutes-email flow needs from #152, injected so the
 * orchestration stays pure and unit-testable with a mock. The concrete
 * implementation lives in `minutes-email-port-logic.ts` (reuses #152's
 * `renderMinutesPdf` and queries the `meeting_attendance` roster/guests).
 */
export interface MinutesEmailPort {
	/** #152's server-side PDF generator — the SAME one the download uses, so the
	 *  emailed file is byte-identical. Returns the raw PDF bytes. */
	renderMinutesPdf(meetingId: string): Promise<Uint8Array>;
	/** Active members + guests marked present for the meeting, each with an
	 *  email that may be null (missing email → skipped, never an error). */
	loadRecipients(meetingId: string): Promise<{
		members: { name: string; email: string | null }[];
		presentGuests: { name: string; email: string | null }[];
	}>;
	/** Club name + meeting date, for the subject line and PDF filename. */
	loadHeader(
		meetingId: string,
	): Promise<{ clubName: string; meetingDate: Date }>;
}

/** Injected side-effecting deps (the email transport), so `sendMinutesEmail` is
 *  unit-testable by passing a mock instead of reaching for the real transport. */
export interface MinutesEmailDeps {
	sendEmail(params: SendEmailParams): Promise<void>;
}

// ---------------------------------------------------------------------------
// Recipient resolution — a PURE function (no db, no port).
// ---------------------------------------------------------------------------

export interface RecipientEntry {
	name: string;
	email: string | null;
}

/** A recipient with a confirmed non-empty email (safe to send to). */
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
 * email NEVER blocks the send — it just moves the person to `skipped`. Pure and
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
// Subject / body / filename builders — pure helpers.
// ---------------------------------------------------------------------------

/** `"<Club name> — Minutes for <formatted date>"`. */
export function buildMinutesSubject(
	clubName: string,
	meetingDate: Date,
): string {
	return `${clubName} — Minutes for ${formatMeetingDate(meetingDate)}`;
}

/** A short default body (plain text). The UI lets an admin override it. */
export function buildMinutesBody(clubName: string, meetingDate: Date): string {
	return (
		`Hi,\n\n` +
		`Attached are the minutes for ${clubName}'s meeting on ${formatMeetingDate(meetingDate)}.\n\n` +
		`Thanks,\n${clubName}`
	);
}

/** `minutes-YYYY-MM-DD.pdf` (UTC date — stable across the reader's timezone). */
export function buildMinutesFilename(meetingDate: Date): string {
	const iso = meetingDate.toISOString().slice(0, 10);
	return `minutes-${iso}.pdf`;
}

/** Wrap a plain-text body in minimal HTML (Resend wants both html + text). */
function textToHtml(text: string): string {
	const escaped = text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
	return `<div>${escaped.replace(/\n/g, "<br>")}</div>`;
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

export interface SendMinutesEmailInput {
	meetingId: string;
	/** Admin-curated recipient list from the UI (edited to-list). When omitted,
	 *  the default list is loaded via the port and resolved. Entries without an
	 *  email are still moved to `skipped` (never error). */
	recipients?: RecipientEntry[];
	/** Optional subject override (defaults to `buildMinutesSubject`). */
	subject?: string;
	/** Optional plain-text body override (defaults to `buildMinutesBody`). */
	body?: string;
}

export interface SendMinutesEmailResult {
	sent: ResolvedRecipient[];
	skipped: { name: string }[];
}

/**
 * Load the header + recipients through the port, resolve who has an email,
 * render the minutes PDF (#152's renderer, via the port), base64-encode it, and
 * send ONE email to all resolved recipients with the PDF attached. Returns who
 * was sent to and who was skipped (no email on file).
 *
 * When no resolved recipient has an email, no email is sent (Resend rejects an
 * empty recipient list) — the call still succeeds and reports everyone skipped.
 */
export async function sendMinutesEmail(
	port: MinutesEmailPort,
	deps: MinutesEmailDeps,
	input: SendMinutesEmailInput,
): Promise<SendMinutesEmailResult> {
	const header = await port.loadHeader(input.meetingId);

	const resolved = input.recipients
		? resolveMinutesRecipients({
				members: input.recipients,
				presentGuests: [],
			})
		: resolveMinutesRecipients(await port.loadRecipients(input.meetingId));

	// Nobody has an email — nothing to send, but report the skips.
	if (resolved.recipients.length === 0) {
		return { sent: [], skipped: resolved.skipped };
	}

	const pdf = await port.renderMinutesPdf(input.meetingId);
	const content = Buffer.from(pdf).toString("base64");

	const subject =
		input.subject ?? buildMinutesSubject(header.clubName, header.meetingDate);
	const text =
		input.body ?? buildMinutesBody(header.clubName, header.meetingDate);

	await deps.sendEmail({
		to: resolved.recipients.map((r) => r.email),
		subject,
		html: textToHtml(text),
		text,
		attachments: [
			{ filename: buildMinutesFilename(header.meetingDate), content },
		],
	});

	return { sent: resolved.recipients, skipped: resolved.skipped };
}
