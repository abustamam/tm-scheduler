// Member milestones (#1425): three moments worth a beat of recognition.
// Pure: the counts come from `getMyMilestones`, the "seen" set from
// localStorage (`readStoredSet`), and this file only decides what is due.

export type Milestone = "firstSpeech" | "tenthMeeting";

export interface MilestoneCounts {
	speechesDelivered: number;
	meetingsAttended: number;
}

/** Order matters: when two are due, the earlier one shows first. */
export const MILESTONE_ORDER: readonly Milestone[] = [
	"firstSpeech",
	"tenthMeeting",
];

export const MILESTONES_STORAGE_KEY = "gavelup:milestones";

export const milestoneKey = (memberId: string, milestone: Milestone) =>
	`${memberId}:${milestone}`;

function reached(milestone: Milestone, counts: MilestoneCounts): boolean {
	return milestone === "firstSpeech"
		? counts.speechesDelivered >= 1
		: counts.meetingsAttended >= 10;
}

/** The milestones reached and not yet seen, in `MILESTONE_ORDER`. */
export function dueMilestones(
	memberId: string,
	counts: MilestoneCounts,
	seen: Set<string>,
): Milestone[] {
	return MILESTONE_ORDER.filter(
		(m) => reached(m, counts) && !seen.has(milestoneKey(memberId, m)),
	);
}

export const MILESTONE_COPY: Record<
	Milestone,
	{ heading: string; body: string }
> = {
	firstSpeech: {
		heading: "Your first speech is done.",
		body: "The hardest one is behind you. Every speech after this builds on it.",
	},
	tenthMeeting: {
		heading: "10 meetings. You keep showing up.",
		body: "That steady presence is what makes a club a club. Thank you.",
	},
};
