/**
 * Mentorship (#939, CONTEXT.md "Mentorship"): the pure half.
 *
 * Member-to-member pairings inside ONE club. Not the charter "club mentor"
 * (`charter_helper_role = 'club_mentor'`, #1043), who is assigned to a
 * chartering club: that one is always spelled "club mentor (charter)" in copy,
 * and nothing here reads or labels it.
 *
 * db-free so the dashboard, the member page and the orientation checklist can
 * share the labels and the "active" rule without reaching `#/db`.
 */

/** Keep in lockstep with `mentorship_focus` in schema.ts (the test holds it). */
export const MENTORSHIP_FOCUSES = [
	"new_member",
	"contest",
	"leadership",
	"other",
] as const;

export type MentorshipFocus = (typeof MENTORSHIP_FOCUSES)[number];

export const MENTORSHIP_FOCUS_LABELS: Record<MentorshipFocus, string> = {
	new_member: "New member",
	contest: "Contest",
	leadership: "Leadership",
	other: "Other",
};

/** Longest free-text focus the write path accepts. */
export const MENTORSHIP_FOCUS_OTHER_MAX = 80;

/**
 * How a pairing's focus reads in a list: the free text for `other` when there
 * is some, the label otherwise, and null for a pairing with no focus.
 */
export function mentorshipFocusText(
	focus: MentorshipFocus | null,
	focusOther: string | null,
): string | null {
	if (focus === null) return null;
	if (focus === "other" && focusOther?.trim()) return focusOther.trim();
	return MENTORSHIP_FOCUS_LABELS[focus];
}

/**
 * Active ⇔ not ended: the CLIENT-SIDE statement of it. The server restates it
 * in SQL (`ended_at IS NULL`) in each reader, where a pairing must ALSO have
 * both parties active to count (`mentorship-logic.ts`).
 */
export function isActivePairing(p: { endedAt: Date | null }): boolean {
	return p.endedAt === null;
}

/**
 * The pairing that counts for orientation's "Get a mentor" item: ACTIVE and
 * focused on `new_member`. An ended new-member pairing and an active contest
 * pairing both count for nothing.
 */
export function isNewMemberMentorship(p: {
	focus: MentorshipFocus | null;
	endedAt: Date | null;
}): boolean {
	return isActivePairing(p) && p.focus === "new_member";
}

/** A member offered as a mentor, for the picker's ordering. */
export interface MentorCandidate {
	id: string;
	name: string;
	willingToMentor: boolean;
}

/**
 * The mentor picker's order: members who said they are willing first, then
 * everyone else, each group by name. Excludes the mentee themself.
 */
export function orderMentorCandidates<T extends MentorCandidate>(
	candidates: readonly T[],
	menteeId: string,
): T[] {
	return candidates
		.filter((c) => c.id !== menteeId)
		.sort((a, b) => {
			if (a.willingToMentor !== b.willingToMentor) {
				return a.willingToMentor ? -1 : 1;
			}
			return a.name.localeCompare(b.name);
		});
}
