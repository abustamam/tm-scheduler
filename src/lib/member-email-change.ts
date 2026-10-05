/**
 * The client-safe half of a member changing their own sign-in address (#1091,
 * ADR-0030): the endpoint paths, the limits, and the words. The server half is
 * `#/lib/change-email-plugin`, which imports these; it cannot be imported from
 * a component, since it reaches `#/db`.
 *
 * ONE home for every number and every sentence two places show, so the copy
 * cannot drift from the behaviour.
 */

/** Under Better Auth's base path, `/api/auth`. Deliberately NOT `/change-email…`
 *  or `/sign-in…`, which Better Auth's built-in limiter rules match by prefix. */
export const MEMBER_EMAIL_REQUEST_PATH = "/member-email/request";
/** GET: the confirm PAGE. Changes nothing (link scanners prefetch GETs). */
export const MEMBER_EMAIL_CONFIRM_PATH = "/member-email/confirm";
/** POST: the page's button. The only path that applies a change. */
export const MEMBER_EMAIL_APPLY_PATH = "/member-email/apply";

/** How long a change-of-address link lives (decision 7). */
export const EMAIL_CHANGE_LINK_LIFETIME_SECONDS = 60 * 60;
/** The window both request caps count over. */
export const EMAIL_CHANGE_REQUEST_WINDOW_SECONDS = 60 * 60;
/** Requests allowed per window, per account AND per client address. */
export const EMAIL_CHANGE_REQUESTS_PER_WINDOW = 3;

/** The words a refused-for-volume request shows (decision 7). */
export const RATE_LIMITED_MESSAGE = "Too many requests, try again later.";

/** Said to the NEW inbox, and on `/account`, when an address is taken. */
export const ADDRESS_IN_USE_SENTENCE =
	"This address is already in use on GavelUp, so it can't be added to another account. Ask your club officer or GavelUp support to merge them.";

/** An account bound to two or more Persons must be merged first (#1091 review). */
export const NEEDS_MERGE_MESSAGE =
	"Your account is linked to more than one member record, so its address can't be changed until they are merged. Ask your club officer or GavelUp support to merge your records.";

/** The `?emailChange=` values an applied (or refused) link lands `/account` with. */
export type EmailChangeOutcome =
	| "changed"
	| "stale"
	| "in_use"
	| "unbound"
	| "needs_merge"
	| "expired";

type OutcomeMessage = { tone: "success" | "error"; text: string };

/** Every outcome has words; a new kind without them fails typecheck. */
const OUTCOME_MESSAGES: Record<EmailChangeOutcome, OutcomeMessage> = {
	changed: {
		tone: "success",
		text: "Your sign-in address was changed. Use the new one next time you sign in.",
	},
	stale: {
		tone: "error",
		text: "That link no longer applies: your sign-in address has changed since it was sent. Request a new one.",
	},
	in_use: { tone: "error", text: ADDRESS_IN_USE_SENTENCE },
	unbound: {
		tone: "error",
		text: "This account isn't linked to a club member, so its address can't be changed here.",
	},
	needs_merge: { tone: "error", text: NEEDS_MERGE_MESSAGE },
	expired: {
		tone: "error",
		text: "That link has expired or isn't valid. Request a new one.",
	},
};

/** What `/account` says about a clicked link, or null for an unknown value. */
export function emailChangeOutcomeMessage(
	outcome: string | undefined,
): OutcomeMessage | null {
	if (outcome === undefined || !Object.hasOwn(OUTCOME_MESSAGES, outcome)) {
		return null;
	}
	return OUTCOME_MESSAGES[outcome as EmailChangeOutcome];
}
