import {
	type OfficerPosition,
	officerPositionLabel,
	officerRank,
} from "./officers";

/** A route the officer home links to (must be a static, param-free path). */
export type OfficerTaskTarget =
	| "/"
	| "/schedule"
	| "/next"
	| "/activity"
	| "/admin/vpe-dashboard"
	| "/admin/dues"
	| "/admin/meetings/new"
	| "/admin/meetings/batch"
	| "/admin/roles"
	| "/admin/club-settings"
	| "/admin/sync-tokens";

/** One "job → destination" card on the officer home (#202). */
export interface OfficerTask {
	label: string;
	description: string;
	to: OfficerTaskTarget;
}

/** Shown to every officer regardless of office. */
export const COMMON_TASKS: OfficerTask[] = [
	{
		label: "Sign-up sheet",
		description: "See the season and fill roles.",
		to: "/schedule",
	},
	{ label: "Roster", description: "Everyone in the club.", to: "/" },
	{
		label: "Next meeting",
		description: "The upcoming agenda.",
		to: "/next",
	},
	{
		label: "Activity log",
		description: "Every recent change.",
		to: "/activity",
	},
];

/**
 * Office-specific jobs → destinations. Only the offices that map to real
 * surfaces appear here; the rest (VP PR, Sergeant-at-Arms, Past President)
 * intentionally have no section — see #207 / #208 for their future features.
 */
export const OFFICER_TASKS: Partial<Record<OfficerPosition, OfficerTask[]>> = {
	president: [
		{
			label: "Club settings",
			description: "Name, number, meeting details.",
			to: "/admin/club-settings",
		},
		{
			label: "Members & officer roles",
			description: "Promote, demote, edit the roster.",
			to: "/",
		},
		{
			label: "Season at a glance",
			description: "Is every meeting filling up?",
			to: "/schedule",
		},
	],
	vp_education: [
		{
			label: "VP Education dashboard",
			description: "Who's overdue, who's up to speak.",
			to: "/admin/vpe-dashboard",
		},
		{
			label: "Schedule a meeting",
			description: "Add one meeting.",
			to: "/admin/meetings/new",
		},
		{
			label: "Batch-create meetings",
			description: "Generate a season at once.",
			to: "/admin/meetings/batch",
		},
		{
			label: "Meeting-role catalog",
			description: "The roles on the agenda.",
			to: "/admin/roles",
		},
		{
			label: "Base Camp / Pathways sync",
			description: "Keep Pathways progress current.",
			to: "/admin/sync-tokens",
		},
	],
	secretary: [
		{
			label: "Record attendance & minutes",
			description: "On the next meeting's agenda.",
			to: "/next",
		},
		{
			label: "Activity log",
			description: "The record of what changed.",
			to: "/activity",
		},
	],
	vp_membership: [
		{
			label: "Manage guests",
			description: "Add and assign guests on a meeting.",
			to: "/next",
		},
		{
			label: "Add members",
			description: "Grow the roster.",
			to: "/",
		},
	],
	treasurer: [
		{
			label: "Dues tracker",
			description: "Who has paid, who owes, by period.",
			to: "/admin/dues",
		},
		{
			label: "Members & contacts",
			description: "The roster to follow up with.",
			to: "/",
		},
	],
};

export interface OfficerHomeSection {
	position: OfficerPosition;
	label: string;
	tasks: OfficerTask[];
}

/**
 * Build the officer home for the positions a member holds: the common band plus
 * one section per office that has specific tasks, ordered President-first.
 */
export function buildOfficerHome(positions: OfficerPosition[]): {
	common: OfficerTask[];
	sections: OfficerHomeSection[];
} {
	const sections = positions
		.filter((p): p is OfficerPosition => !!OFFICER_TASKS[p])
		.sort((a, b) => officerRank(a) - officerRank(b))
		.map((position) => ({
			position,
			label: officerPositionLabel(position),
			tasks: OFFICER_TASKS[position] ?? [],
		}));
	return { common: COMMON_TASKS, sections };
}
