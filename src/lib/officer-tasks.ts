import { type NavRoute, navLabel } from "./nav-destinations";
import {
	type OfficerPosition,
	officerPositionLabel,
	officerRank,
} from "./officers";

/** A route the officer home links to: a registered nav destination or one of
 *  its `alsoActiveOn` siblings (static, param-free). */
export type OfficerTaskTarget = NavRoute;

/**
 * One "job → destination" card on the officer home (#202). It has no label of
 * its own: the card's title is the destination's nav label ({@link
 * officerTaskTitle}), so the card cannot name a page differently from the
 * sidebar (#911). The per-office wording lives in the description.
 */
export interface OfficerTask {
	description: string;
	to: OfficerTaskTarget;
}

/** The card title: the registry label of the task's destination. */
export function officerTaskTitle(task: OfficerTask): string {
	return navLabel(task.to);
}

/** Shown to every officer regardless of office. */
export const COMMON_TASKS: OfficerTask[] = [
	{ description: "See the season and fill roles.", to: "/schedule" },
	{ description: "Everyone in the club.", to: "/roster" },
	{ description: "The upcoming agenda.", to: "/next" },
	{ description: "Every recent change.", to: "/activity" },
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
			description:
				"Track the 10 Distinguished Club Program goals for the year.",
			to: "/admin/dcp",
		},
		{
			description: "Name, number, meeting details.",
			to: "/admin/club-settings",
		},
		{
			description: "Members and officer roles: promote, demote, edit.",
			to: "/roster",
		},
		{
			description: "The season at a glance: is every meeting filling up?",
			to: "/schedule",
		},
	],
	vp_education: [
		{
			description: "Who's overdue, who's up to speak.",
			to: "/admin/vpe-dashboard",
		},
		{ description: "Add one meeting.", to: "/admin/meetings/new" },
		{
			description: "Create several meetings at once.",
			to: "/admin/meetings/batch",
		},
		{ description: "The roles on the agenda.", to: "/admin/roles" },
		{
			description: "Keep Pathways progress current from Base Camp.",
			to: "/admin/sync-tokens",
		},
	],
	vp_public_relations: [
		{
			description: "Share a full agenda when you publicize meetings.",
			to: "/schedule",
		},
		{
			description: "Members to celebrate: feature wins and milestones.",
			to: "/roster",
		},
		{
			description: "Keep the public club details current.",
			to: "/admin/club-settings",
		},
	],
	secretary: [
		{
			description: "Record attendance and minutes on the agenda.",
			to: "/next",
		},
		{ description: "The record of what changed.", to: "/activity" },
	],
	vp_membership: [
		{ description: "Add and assign guests on a meeting.", to: "/next" },
		{ description: "Add members and grow the roster.", to: "/roster" },
	],
	treasurer: [
		{ description: "Who has paid, who owes, by period.", to: "/admin/dues" },
		{
			description: "Members and contacts to follow up with.",
			to: "/roster",
		},
	],
	sergeant_at_arms: [
		{
			description: "Prep the room and agenda for what's coming up.",
			to: "/next",
		},
		{
			description: "The roles that keep a meeting running.",
			to: "/admin/roles",
		},
		{
			description: "Know who's who to greet members and guests.",
			to: "/roster",
		},
	],
	immediate_past_president: [
		{
			description: "Advise the President on the year's DCP goals.",
			to: "/admin/dcp",
		},
		{
			description: "Keep an eye on how meetings are filling.",
			to: "/schedule",
		},
		{ description: "Recent changes across the club.", to: "/activity" },
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
