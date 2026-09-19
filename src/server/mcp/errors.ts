/**
 * The MCP tool layer's error vocabulary (#773, design D11).
 *
 * Every tool failure a caller is meant to act on is an `McpError` carrying a
 * CODE. Anything else — a dropped connection, a constraint nobody predicted, a
 * bug — becomes `INTERNAL` with a fixed generic message, logged server-side and
 * never echoed. Tool results end up in an LLM provider's transcript, so an
 * unhandled error's message is a leak: the shared `*-logic.ts` functions throw
 * prose that names people ("Guest not found in this club.", "Member not found
 * in this club."), and a 500's stack names file paths.
 *
 * **Nothing maps by message text.** The shared logic modules throw plain
 * `Error`s with sentences (`guests-logic.ts:68`, `meetings-logic.ts`), and
 * a reworded sentence would silently turn a handled case into an unhandled one
 * with no test able to see it. So a tool makes its OWN check and throws the
 * code; it never inspects a message to decide what happened. The one sanctioned
 * exception is the archive and lock messages, which are exported constants
 * precisely so a caller can compare against THEM rather than a copy — and even
 * those are compared by identity with the export, never by substring.
 *
 * Follows `IngestError` (`pathways-ingest-logic.ts:28-36`), which carries an
 * HTTP status beside its message for the same reason.
 */

/**
 * Codes a tool returns in an `isError: true` result. Distinct from the HTTP 401
 * a missing, unknown or revoked token gets, which happens before any tool runs.
 */
export type McpErrorCode =
	/** No admin membership (or open officer term) in that club. */
	| "FORBIDDEN"
	| "NOT_FOUND"
	/** Zod issues, or a bad value; carries the entry index where there is one. */
	| "VALIDATION"
	| "ARCHIVED"
	| "LOCKED"
	/** Attendance before the meeting's club-local day has arrived. */
	| "NOT_RECORDABLE"
	/** Apply was called while blocking items remain. */
	| "BLOCKED"
	/** The state moved between preview and apply; carries the fresh plan. */
	| "PLAN_STALE"
	| "INTERNAL";

/**
 * Codes that appear in a PREVIEW's `blocking` list. These are not errors — the
 * preview succeeded and is telling the caller what it cannot do yet. Apply
 * returns `BLOCKED` while any remain. Each item carries its entry index.
 *
 * **Every code here is emitted by a tool, and `blocking-codes.guard.test.ts`
 * holds that.** This union shipped with two that nothing raised —
 * `MEETING_LOCKED` and `FIELD_TOO_LONG` — and a declared code nothing emits is
 * worse than an absent one: the next reader assumes the case is handled.
 *
 * `MEETING_LOCKED` was checked before it was dropped, and its absence is
 * PARITY rather than a gap: `record_guest_book` gates attendance on
 * `meetingDateReached` and `minutes-logic.ts` gates the browser path on exactly
 * the same condition, so neither surface consults the meeting lock here.
 * `FIELD_TOO_LONG` had no call site either — the entry schema's `.max()` bounds
 * reject an over-long field as a zod `VALIDATION` error before any plan is
 * built, which is the right shape for a length the caller can see itself.
 * Re-add either the day a tool actually raises it.
 */
export type McpBlockingCode =
	| "NO_MEETING_ON_DATE"
	| "AMBIGUOUS_DATE"
	| "AMBIGUOUS_GUEST"
	| "INVALID_PHONE"
	/**
	 * The address on the line is not a valid email.
	 *
	 * Blocking rather than a zod rejection, and that choice is the point: a hard
	 * schema failure would reject a 60-line page because one address was misread,
	 * which on a TRANSCRIPTION path is the wrong trade. It has to be caught
	 * somewhere, though — a guest marked present becomes a default recipient of
	 * the club's minutes email (`minutes-email-port-logic.ts:54`), and
	 * `resolveMinutesRecipients` only checks that the string is non-empty.
	 */
	| "INVALID_EMAIL";

export interface McpBlockingItem {
	code: McpBlockingCode;
	/**
	 * Index into the call's `entries` array, so a caller can point at the line.
	 *
	 * ABSENT when the problem is the call as a whole rather than one line —
	 * "there is no meeting on that date" belongs to no entry. An index of `-1`
	 * would be a lie a caller could render as "line -1"; omitting the field makes
	 * the distinction something they have to handle.
	 */
	entryIndex?: number;
	/** One sentence for a human. Carries no contact details. */
	message: string;
	/** Code-specific context, e.g. the candidate guests for an ambiguous match. */
	detail?: unknown;
}

export class McpError extends Error {
	constructor(
		public readonly code: McpErrorCode,
		message: string,
		/** Extra structured context for the caller, e.g. a fresh plan. */
		public readonly detail?: unknown,
	) {
		super(message);
		this.name = "McpError";
	}
}

/** The message an unexpected error is replaced with. Deliberately says nothing. */
export const INTERNAL_MESSAGE =
	"Something went wrong handling that request. The details were logged.";

/**
 * Normalize anything thrown inside a tool into an `McpError`.
 *
 * An `McpError` passes through. Everything else is logged with its real cause
 * and replaced by a generic `INTERNAL` — the caller learns that it failed and
 * nothing about how.
 */
export function toMcpError(err: unknown, tool: string): McpError {
	if (err instanceof McpError) return err;
	// Real cause to the server log (Railway keeps the timestamp and stack), never
	// to the result.
	console.error(`[mcp:${tool}] unhandled error:`, err);
	return new McpError("INTERNAL", INTERNAL_MESSAGE);
}
