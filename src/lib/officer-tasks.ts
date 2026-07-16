import {
	type OfficerPosition,
	officerPositionLabel,
	officerRank,
} from "./officers";

/** A route the officer home links to (must be a static, param-free path). */
export type OfficerTaskTarget =
	| "/roster"
	| "/schedule"
	| "/next"
	| "/activity"
	| "/admin/vpe-dashboard"
	| "/admin/dcp"
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
	{ label: "Roster", description: "Everyone in the club.", to: "/roster" },
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
 * Office-specific jobs → destinations. Every one of the 8 offices has a
 * non-empty section so no elected officer ever lands on an empty page (#269).
 * Offices without a bespoke workflow yet (VP PR, Sergeant-at-Arms, Immediate
 * Past President) point at the general tools most relevant to the role until
 * dedicated features land (see #207 / #208). Typed as a total `Record` (not
 * `Partial`) so adding a new office to the enum is a compile error until it has
 * a section here.
 */
export const OFFICER_TASKS: Record<OfficerPosition, OfficerTask[]> = {
	president: [
		{
			label: "Distinguished Club Program",
			description: "Track the 10 DCP goals for the year.",
			to: "/admin/dcp",
		},
		{
			label: "Club settings",
			description: "Name, number, meeting details.",
			to: "/admin/club-settings",
		},
		{
			label: "Members & officer roles",
			description: "Promote, demote, edit the roster.",
			to: "/roster",
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
	vp_public_relations: [
		{
			label: "Promote the season",
			description: "Share a full agenda when you publicize meetings.",
			to: "/schedule",
		},
		{
			label: "Members to celebrate",
			description: "Feature wins and milestones from the roster.",
			to: "/roster",
		},
		{
			label: "Club settings",
			description: "Keep the public club details current.",
			to: "/admin/club-settings",
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
			to: "/roster",
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
			to: "/roster",
		},
	],
	sergeant_at_arms: [
		{
			label: "Set up the next meeting",
			description: "Prep the room and agenda for what's coming up.",
			to: "/next",
		},
		{
			label: "Meeting-role catalog",
			description: "The roles that keep a meeting running.",
			to: "/admin/roles",
		},
		{
			label: "Roster",
			description: "Know who's who to greet members and guests.",
			to: "/roster",
		},
	],
	immediate_past_president: [
		{
			label: "Distinguished Club Program",
			description: "Advise the President on the year's DCP goals.",
			to: "/admin/dcp",
		},
		{
			label: "Season at a glance",
			description: "Keep an eye on how meetings are filling.",
			to: "/schedule",
		},
		{
			label: "Activity log",
			description: "Recent changes across the club.",
			to: "/activity",
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
 * one section per office, ordered President-first. Every office has a non-empty
 * task list (#269), so every held office yields a section.
 */
export function buildOfficerHome(positions: OfficerPosition[]): {
	common: OfficerTask[];
	sections: OfficerHomeSection[];
} {
	const sections = [...positions]
		.sort((a, b) => officerRank(a) - officerRank(b))
		.map((position) => ({
			position,
			label: officerPositionLabel(position),
			tasks: OFFICER_TASKS[position],
		}));
	return { common: COMMON_TASKS, sections };
}
