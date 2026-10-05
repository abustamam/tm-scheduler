/**
 * The client-safe half of a member changing their own sign-in address (#1091,
 * ADR-0030): the endpoint paths and the words Account settings shows. The
 * server half is `#/lib/change-email-plugin`, which imports these; it cannot be
 * imported from a component, since it reaches `#/db`.
 */

/** Under Better Auth's base path, `/api/auth`. Deliberately NOT `/change-email…`
 *  or `/sign-in…`, which Better Auth's built-in limiter rules match by prefix. */
export const MEMBER_EMAIL_REQUEST_PATH = "/member-email/request";
export const MEMBER_EMAIL_CONFIRM_PATH = "/member-email/confirm";

/** The `?emailChange=` values a clicked link lands on `/account` with. */
export type EmailChangeOutcome =
	| "changed"
	| "stale"
	| "in_use"
	| "unbound"
	| "expired";

/** What `/account` says about a clicked link, or null for an unknown value. */
export function emailChangeOutcomeMessage(
	outcome: string | undefined,
): { tone: "success" | "error"; text: string } | null {
	switch (outcome) {
		case "changed":
			return {
				tone: "success",
				text: "Your sign-in address was changed. Use the new one next time you sign in.",
			};
		case "stale":
			return {
				tone: "error",
				text: "That link no longer applies: your sign-in address has changed since it was sent. Request a new one.",
			};
		case "in_use":
			return {
				tone: "error",
				text: "That address is already in use on GavelUp, so it can't be added to this account. Ask your club officer or GavelUp support to merge them.",
			};
		case "unbound":
			return {
				tone: "error",
				text: "This account isn't linked to a club member, so its address can't be changed here.",
			};
		case "expired":
			return {
				tone: "error",
				text: "That link has expired or isn't valid. Request a new one.",
			};
		default:
			return null;
	}
}
