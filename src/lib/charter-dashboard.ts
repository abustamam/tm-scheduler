// The charter dashboard's vocabulary (#943), stated once. Pure: no `#/db`, so
// the admin route and the server write paths share the same roles, bounds and
// copy. Nothing here encodes Toastmasters International's charter rules: the
// target and the checklist are club-editable, and the page says to check the
// district's own requirements.

/** Restated in `charterHelperRoleEnum` (`src/db/schema.ts`), which may not
 *  import this module; `charter-dashboard.test.ts` holds the two equal. */
export const CHARTER_HELPER_ROLES = ["sponsor", "club_mentor"] as const;
export type CharterHelperRole = (typeof CHARTER_HELPER_ROLES)[number];

export const CHARTER_HELPER_ROLE_LABEL: Record<CharterHelperRole, string> = {
	sponsor: "Sponsor",
	club_mentor: "Club mentor",
};

/** The target a new charter dashboard starts with. The column default
 *  (`club_charter.members_needed`) says the same. */
export const DEFAULT_MEMBERS_NEEDED = 20;
/** The bounds the column's CHECK enforces. */
export const MEMBERS_NEEDED_MIN = 1;
export const MEMBERS_NEEDED_MAX = 1000;

/** Most steps a checklist may hold (add refuses past it; reorder accepts at
 *  most this many ids), and most sponsors and club mentors a club may record. */
export const CHARTER_STEPS_MAX = 50;
export const CHARTER_HELPERS_MAX = 50;

/** Longest checklist step label, and longest free-text helper field. */
export const CHARTER_STEP_LABEL_MAX = 200;
export const CHARTER_HELPER_FIELD_MAX = 200;

/** The steps a chartering club's checklist starts with, in order. Common
 *  steps, not TI's list: the club can rename, reorder and remove every one. */
export const SEEDED_CHARTER_STEPS: readonly string[] = [
	"Officers elected or appointed",
	"Charter dues collected",
	"Charter paperwork submitted to district",
	"Charter confirmed",
];

/** Always shown on the dashboard: the numbers are the club's own, and the
 *  rules that count belong to Toastmasters International and the district. */
export const OFFICIAL_REQUIREMENTS_NOTE =
	"Charter requirements are set by Toastmasters International and your district. Check them before relying on these numbers.";
/** Checked 2026-09-28: answers 200. A link, never a copy of TI's forms
 *  (ADR-0024). */
export const OFFICIAL_REQUIREMENTS_URL =
	"https://www.toastmasters.org/start-a-club";
export const OFFICIAL_REQUIREMENTS_LINK_LABEL =
	"Toastmasters International: starting a new club";

/** The progress bar's fill, 0 to 100. A club past its target reads 100. */
export function charterProgressPercent(
	paid: number,
	membersNeeded: number,
): number {
	if (membersNeeded <= 0) return 0;
	return Math.min(100, Math.max(0, Math.round((paid / membersNeeded) * 100)));
}

/**
 * `ids` moved one place in `direction`, or the same order when it cannot move.
 * The checklist's up/down buttons send the whole resulting order to the server,
 * which accepts it only as a permutation of the club's steps.
 */
export function moveInOrder(
	ids: readonly string[],
	id: string,
	direction: "up" | "down",
): string[] {
	const next = [...ids];
	const at = next.indexOf(id);
	const to = direction === "up" ? at - 1 : at + 1;
	if (at < 0 || to < 0 || to >= next.length) return next;
	[next[at], next[to]] = [next[to] as string, next[at] as string];
	return next;
}
