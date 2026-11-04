import type { CharterStatus } from "#/lib/club-charter";
import type { OnboardingChecklistStatus } from "#/server/onboarding-checklist-logic";

// Client-safe (no `#/db`) piece of the setup checklist (#265): the threshold,
// the item→route table, and the localStorage dismiss key. Lives in `#/lib` so
// both the server logic (`onboarding-checklist-logic.ts`) and the client
// component can import it as a plain VALUE without pulling `db`/`pg` into the
// browser — see the server-bundle rule in members-logic.ts.

/**
 * Whether "Confirm your club details" is done: a name and a meeting schedule,
 * and a club number for a CHARTERED club only. A chartering club may have no
 * number yet (#944), so requiring one would leave the item unfinishable until
 * the club charters. Same rule as `charterInvariantError`, read the other way.
 */
export function clubDetailsComplete(club: {
	name: string | null;
	clubNumber: string | null;
	charterStatus: CharterStatus;
	meetingSchedule: string | null;
}): boolean {
	const numberDone =
		club.charterStatus === "chartering" || Boolean(club.clubNumber?.trim());
	return Boolean(
		club.name?.trim() && club.meetingSchedule?.trim() && numberDone,
	);
}

/** Below this many active members, a club still counts as "new" — drives both
 *  the "Import your roster" checklist item and the show/dismiss gate. */
export const CHECKLIST_MEMBER_THRESHOLD = 5;

/** The routes a checklist item deep-links to — all static, param-free admin
 *  paths that already exist as routes. */
export type OnboardingChecklistTarget =
	| "/admin/club-settings"
	| "/roster"
	| "/admin/schedule"
	| "/admin/meetings/batch"
	| "/admin/import-history";

export interface OnboardingChecklistItem {
	key: string;
	label: string;
	description: string;
	to: OnboardingChecklistTarget;
	complete: boolean;
	/** Set when the viewer cannot do this step: the row renders as plain text with this in place of the description (#1498). */
	locked?: string;
}

export type OnboardingPath = "fresh" | "easy-speak";

/**
 * Whether the official-roster row is done: active members carrying a
 * Toastmasters Customer ID reach `min(threshold, active)`, never on an empty
 * roster (0 >= min(5, 0) would clear vacuously). Same shape as the invite rule.
 */
export function officialRosterComplete(
	officialCount: number,
	memberCount: number,
): boolean {
	return (
		memberCount > 0 &&
		officialCount >= Math.min(CHECKLIST_MEMBER_THRESHOLD, memberCount)
	);
}

/** The per-club localStorage key for the Easy-Speak path choice (#1498). The only stored value is "easy-speak". */
export function onboardingPathKey(clubId: string): string {
	return `gavelup:onboarding-path:${clubId}`;
}

/** Data beats storage: any import puts every admin on the Easy-Speak path; the stored choice only counts before the first upload. */
export function resolveOnboardingPath(
	status: Pick<OnboardingChecklistStatus, "hasImport">,
	storedChoice: string | null,
): OnboardingPath {
	if (status.hasImport) return "easy-speak";
	return storedChoice === "easy-speak" ? "easy-speak" : "fresh";
}

/** Whether the checklist still shows on this path. */
export function isNewClubFor(
	status: Pick<OnboardingChecklistStatus, "isNewClub" | "isNewClubEasySpeak">,
	path: OnboardingPath,
): boolean {
	return path === "easy-speak" ? status.isNewClubEasySpeak : status.isNewClub;
}

/**
 * The setup checklist's six data-backed rows, in order, each deep-linking to
 * the real screen that completes it and auto-checked from the club's actual
 * data (#265) — never a stored step flag. "Share your sign-up link" isn't
 * included here: copying a link leaves no data trace, so it's rendered by the
 * component as a always-available action rather than a checkable item.
 */
export function buildOnboardingChecklistItems(
	status: OnboardingChecklistStatus,
	path: OnboardingPath = "fresh",
): OnboardingChecklistItem[] {
	if (path === "easy-speak") return buildEasySpeakItems(status);
	return [
		{
			key: "club-details",
			label: "Confirm your club details",
			description:
				"Name, club number (once chartered), time zone, and meeting day/time.",
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
			key: "invite",
			label: "Invite your members",
			description: "Send sign-in links so members can claim roles.",
			to: "/roster",
			complete: status.hasInvitedMembers,
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

const LOCKED_TEXT = "A club admin does this step.";

function buildEasySpeakItems(
	status: OnboardingChecklistStatus,
): OnboardingChecklistItem[] {
	const locked = status.canRunImport ? undefined : LOCKED_TEXT;
	return [
		{
			key: "club-details",
			label: "Confirm your club details",
			description:
				"Name, club number (once chartered), time zone, and meeting day/time.",
			to: "/admin/club-settings",
			complete: status.clubDetailsComplete,
		},
		{
			key: "official-roster",
			label: "Load your official roster",
			description:
				"Upload the membership CSV from Toastmasters Club Central, so the import matches people to your members.",
			to: "/roster",
			complete: status.hasOfficialRoster,
		},
		{
			key: "history",
			label: "Import your Easy-Speak history",
			description:
				"Export it with the GavelUp browser extension, then upload it here. Re-run it later to pick up meetings held since.",
			to: "/admin/import-history",
			complete: status.hasAppliedImport,
			locked,
		},
		{
			key: "upcoming",
			label: "Bring over your upcoming meetings",
			description:
				'Tick "include upcoming meetings" when you import, so role holders come with them.',
			to: "/admin/import-history",
			complete: status.hasUpcomingMeeting,
			locked,
		},
		{
			key: "recurrence",
			label: "Set your recurring meeting schedule",
			description: "How often and when your club meets.",
			to: "/admin/schedule",
			complete: status.hasRecurrence,
		},
		{
			key: "invite",
			label: "Invite your members",
			description: "Send sign-in links so members can claim roles.",
			to: "/roster",
			complete: status.hasInvitedMembers,
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
