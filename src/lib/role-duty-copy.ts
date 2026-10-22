/**
 * Every sentence a member sees when they give up their own role (#1280).
 *
 * GavelUp sends no message to anyone (humans send every message), so freeing a role does not
 * absolve the holder: it is still on them to find a replacement or tell the Toastmaster or VPE.
 * Client-safe: no server imports. Officer-on-behalf copy deliberately does not live here.
 */

const TELL_LEADERS = "tell the Toastmaster or VPE";

/** The duty a holder keeps after freeing a role; embed it in a sentence of your own. */
export const ROLE_DUTY_CLAUSE = `it's still on you to find a replacement or ${TELL_LEADERS}`;

const DUTY_SENTENCE =
	"Now tell the Toastmaster or VPE, or find someone to cover it.";

/** Shown BEFORE a holder frees their own role(s). `roles` is the listRoles() output. */
export function roleDutyConfirmText(roles: string, when: string): string {
	return `You're ${roles} on ${when}. This frees the role, but ${ROLE_DUTY_CLAUSE}. GavelUp doesn't tell anyone.`;
}

/** Shown AFTER a holder freed their own role(s). */
export function roleFreedDutyText(count: number): string {
	return `${count === 1 ? "Role freed." : "Roles freed."} ${DUTY_SENTENCE}`;
}

export const ROLE_FREED_DUTY_TEXT = roleFreedDutyText(1);

/** Shown when a holder declined but the role was NOT freed (signed-out decline). */
export const ROLE_KEPT_DUTY_TEXT =
	"Your role is still yours until someone covers it: find a replacement or tell the Toastmaster or VPE.";

/** Shown AFTER a decline by someone holding no role. */
export const NOT_COMING_NO_ROLE_TEXT = "Got it — you're marked as not coming.";

/** Shown BEFORE a signed-out decline by someone holding no role. */
export function notComingText(when: string): string {
	return `You'll be marked as not coming for the ${when} meeting.`;
}

/** Shown BEFORE a signed-in decline by someone holding no role (one may have been assigned since load). */
export function notComingMaybeRoleText(when: string): string {
	return `You'll be marked as not coming for the ${when} meeting. If a role has been assigned to you since this page loaded, it will be freed too, and it's on you to ${TELL_LEADERS}.`;
}

/** Duration for any toast carrying duty text: long enough to read and act on. */
export const DUTY_TOAST_MS = 10_000;

/**
 * The toast a member sees right after declining their own meeting: which sentence, and for how
 * long. Pure (no toast import) so server code can reuse the module. `released` is the server's
 * count of roles freed; `holdsRole` is the client's view and only matters when nothing was freed.
 */
export function notComingToast(
	released: number,
	holdsRole: boolean,
): { text: string; duration?: number } {
	if (released > 0) {
		return { text: roleFreedDutyText(released), duration: DUTY_TOAST_MS };
	}
	if (holdsRole) {
		return { text: ROLE_KEPT_DUTY_TEXT, duration: DUTY_TOAST_MS };
	}
	return { text: NOT_COMING_NO_ROLE_TEXT };
}

/** Phrases no surface may say: GavelUp notifies nobody. */
export const FORBIDDEN_NOTIFY_PHRASES = [
	"let the team know",
	"find cover",
	"will find cover",
] as const;
