import type { OnboardingChecklistStatus } from "#/server/onboarding-checklist-logic";

// Client-safe (no `#/db`) piece of the setup checklist (#265): the threshold,
// the item→route table, and the localStorage dismiss key. Lives in `#/lib` so
// both the server logic (`onboarding-checklist-logic.ts`) and the client
// component can import it as a plain VALUE without pulling `db`/`pg` into the
// browser — see the server-bundle rule in members-logic.ts.

/** Below this many active members, a club still counts as "new" — drives both
 *  the "Import your roster" checklist item and the show/dismiss gate. */
export const CHECKLIST_MEMBER_THRESHOLD = 5;

/** The routes a checklist item deep-links to (a subset of `OfficerTaskTarget`,
 *  src/lib/officer-tasks.ts — all static, param-free paths). */
export type OnboardingChecklistTarget =
	| "/admin/club-settings"
	| "/roster"
	| "/admin/schedule"
	| "/admin/meetings/batch";

export interface OnboardingChecklistItem {
	key: string;
	label: string;
	description: string;
	to: OnboardingChecklistTarget;
	complete: boolean;
}

/**
 * The setup checklist's five data-backed rows, in order, each deep-linking to
 * the real screen that completes it and auto-checked from the club's actual
 * data (#265) — never a stored step flag. "Share your sign-up link" isn't
 * included here: copying a link leaves no data trace, so it's rendered by the
 * component as a always-available action rather than a checkable item.
 */
export function buildOnboardingChecklistItems(
	status: OnboardingChecklistStatus,
): OnboardingChecklistItem[] {
	return [
		{
			key: "club-details",
			label: "Confirm your club details",
			description: "Name, club number, and meeting day/time.",
			to: "/admin/club-settings",
			complete: status.clubDetailsComplete,
		},
		{
			key: "roster",
			label: "Import your roster",
			description: `Add your members (at least ${CHECKLIST_MEMBER_THRESHOLD}).`,
			to: "/roster",
			complete: status.hasEnoughMembers,
		},
		{
			key: "recurrence",
			label: "Set your recurring meeting schedule",
			description: "How often and when your club meets.",
			to: "/admin/schedule",
			complete: status.hasRecurrence,
		},
		{
			key: "meetings",
			label: "Generate this season's meetings",
			description: "Create meetings from your schedule.",
			to: "/admin/meetings/batch",
			complete: status.hasMeeting,
		},
		{
			key: "officers",
			label: "Assign officer roles",
			description: "Open a member's profile to set their office.",
			to: "/roster",
			complete: status.hasOfficerTerm,
		},
	];
}

/** The per-club localStorage key a dismiss is recorded under (design doc
 *  #265): no schema change, so a dismissal is local to the browser/device. */
export function onboardingDismissKey(clubId: string): string {
	return `gavelup:onboarding-dismissed:${clubId}`;
}
