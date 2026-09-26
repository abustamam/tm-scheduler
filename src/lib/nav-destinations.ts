import {
	BookOpen,
	CalendarDays,
	CalendarPlus,
	ClipboardCheck,
	Compass,
	GraduationCap,
	Grid3x3,
	History,
	LayoutGrid,
	List,
	ListChecks,
	type LucideIcon,
	Mic,
	RefreshCw,
	ScrollText,
	Settings,
	ShieldCheck,
	Trophy,
	UserCog,
	UserPlus,
	Users,
	Wallet,
} from "lucide-react";

/**
 * The workspace's navigation destinations, and the ONLY place a destination's
 * label is written (#911).
 *
 * Four surfaces name these pages — the sidebar, the page-title crumb, global
 * search and the Officer home cards — and until this file each wrote its own
 * string, so the same page was "New meeting" in one and "Schedule a meeting" in
 * another. All four now read from here, and `nav-destinations.guard.test.ts`
 * fails if any of them writes a registered label as a literal again.
 *
 * Pure data plus its lookups; no React, so a server module or a test can import
 * it without a DOM.
 */

/** Who may see a destination. `office` is "holds an elected office"; `officer`
 *  is the effective-admin test (a stored admin OR anyone holding an office). */
export type NavGrant = "everyone" | "office" | "officer" | "superadmin";

export type NavGroupKey = "meetings" | "officers" | "setup" | "me" | "platform";

export interface NavDestination {
	/** Stable id, e.g. `"new-meetings"`. */
	key: string;
	/** The entry's route. */
	to: string;
	/** THE label, everywhere. */
	label: string;
	group: NavGroupKey;
	grant: NavGrant;
	icon: LucideIcon;
	/** Sibling routes that highlight this entry and share its crumb. */
	alsoActiveOn?: readonly string[];
	/** Match `to` exactly only, never as a prefix. */
	exact?: boolean;
}

export interface NavGroup {
	key: NavGroupKey;
	label: string;
	/** Rendered collapsed by default behind a toggle. */
	collapsible?: true;
}

/** Groups, in display order: by how often an officer reaches for them. */
export const NAV_GROUPS: readonly NavGroup[] = [
	{ key: "meetings", label: "Meetings" },
	{ key: "officers", label: "Officers" },
	{ key: "setup", label: "Setup", collapsible: true },
	{ key: "me", label: "Me" },
	{ key: "platform", label: "Platform" },
];

/** Every destination, in display order within its group. */
export const NAV_DESTINATIONS = [
	// Meetings — every week, everyone.
	{
		key: "sign-up-sheet",
		to: "/schedule",
		label: "Sign-up sheet",
		group: "meetings",
		grant: "everyone",
		icon: Grid3x3,
	},
	{
		key: "next-meeting",
		to: "/next",
		label: "Next meeting",
		group: "meetings",
		grant: "everyone",
		icon: CalendarDays,
	},
	{
		key: "past-meetings",
		to: "/meetings",
		label: "Past meetings",
		group: "meetings",
		grant: "everyone",
		icon: History,
	},
	{
		key: "roster",
		to: "/roster",
		label: "Roster",
		group: "meetings",
		grant: "everyone",
		icon: List,
	},
	{
		key: "activity",
		to: "/activity",
		label: "Activity",
		group: "meetings",
		grant: "everyone",
		icon: ScrollText,
	},

	// Officers — the jobs an office does through the season.
	{
		key: "officer-home",
		to: "/officers",
		label: "Officer home",
		group: "officers",
		grant: "office",
		icon: Compass,
	},
	{
		key: "vp-education",
		to: "/admin/vpe-dashboard",
		label: "VP Education",
		group: "officers",
		grant: "officer",
		icon: GraduationCap,
	},
	{
		key: "vp-membership",
		to: "/admin/vp-membership",
		label: "VP Membership",
		group: "officers",
		grant: "officer",
		icon: UserPlus,
	},
	{
		key: "dcp",
		to: "/admin/dcp",
		label: "DCP scoreboard",
		group: "officers",
		grant: "officer",
		icon: Trophy,
	},
	{
		key: "dues",
		to: "/admin/dues",
		label: "Dues",
		group: "officers",
		grant: "officer",
		icon: Wallet,
	},
	{
		key: "action-items",
		to: "/admin/action-items",
		label: "Action items",
		group: "officers",
		grant: "officer",
		icon: ClipboardCheck,
	},

	// Setup — touched a few times a season, collapsed by default.
	{
		key: "new-meetings",
		to: "/admin/meetings/new",
		label: "New meetings",
		group: "setup",
		grant: "officer",
		icon: CalendarPlus,
		alsoActiveOn: ["/admin/meetings/batch"],
	},
	{
		key: "recurring-schedule",
		to: "/admin/schedule",
		label: "Recurring schedule",
		group: "setup",
		grant: "officer",
		icon: CalendarDays,
	},
	{
		key: "meeting-roles",
		to: "/admin/roles",
		label: "Meeting roles",
		group: "setup",
		grant: "officer",
		icon: ListChecks,
	},
	{
		key: "club-settings",
		to: "/admin/club-settings",
		label: "Club settings",
		group: "setup",
		grant: "officer",
		icon: Settings,
	},
	{
		key: "pathways-sync",
		to: "/admin/sync-tokens",
		label: "Pathways sync",
		group: "setup",
		grant: "officer",
		icon: RefreshCw,
		alsoActiveOn: ["/admin/pathways-sync"],
	},

	// Me
	{
		key: "my-dashboard",
		to: "/dashboard",
		label: "My dashboard",
		group: "me",
		grant: "everyone",
		icon: LayoutGrid,
	},
	{
		key: "my-roles",
		to: "/me",
		label: "My roles",
		group: "me",
		grant: "everyone",
		icon: Mic,
	},
	{
		key: "account",
		to: "/account",
		label: "Account settings",
		group: "me",
		grant: "everyone",
		icon: UserCog,
	},
	{
		key: "resources",
		to: "/resources",
		label: "Resources",
		group: "me",
		grant: "everyone",
		icon: BookOpen,
	},

	// Platform
	{
		key: "superadmin",
		to: "/superadmin",
		label: "Superadmin",
		group: "platform",
		grant: "superadmin",
		icon: ShieldCheck,
		exact: true,
	},
	{
		key: "duplicate-people",
		to: "/superadmin/duplicate-people",
		label: "Duplicate people",
		group: "platform",
		grant: "superadmin",
		icon: Users,
	},
] as const satisfies readonly NavDestination[];

type Registered = (typeof NAV_DESTINATIONS)[number];

/** A registered destination, with its `to` narrowed to the literal route. */
export type RegisteredDestination = Registered;

/** Every route the registry names: each entry's `to` and its `alsoActiveOn`
 *  siblings. A literal union, so a `Link` typed with it stays route-checked. */
export type NavRoute =
	| Registered["to"]
	| Extract<
			Registered,
			{ alsoActiveOn: readonly string[] }
	  >["alsoActiveOn"][number];

export type NavDestinationKey = Registered["key"];

export interface NavGrants {
	hasOffice: boolean;
	isOfficer: boolean;
	isSuperadmin: boolean;
}

function allowed(grant: NavGrant, grants: NavGrants): boolean {
	switch (grant) {
		case "everyone":
			return true;
		case "office":
			return grants.hasOffice;
		case "officer":
			return grants.isOfficer;
		case "superadmin":
			return grants.isSuperadmin;
	}
}

/** The destinations this user may see, in display order. */
export function visibleDestinations(
	grants: NavGrants,
): RegisteredDestination[] {
	return NAV_DESTINATIONS.filter((d) => allowed(d.grant, grants));
}

function normalise(pathname: string): string {
	return pathname.length > 1 ? pathname.replace(/\/+$/, "") || "/" : pathname;
}

/** Length of the path `route` matches `pathname` on, or -1 when it does not. */
function matchLength(route: string, pathname: string, exact: boolean): number {
	if (pathname === route) return route.length;
	if (!exact && pathname.startsWith(`${route}/`)) return route.length;
	return -1;
}

/**
 * The destination a pathname belongs to: its `to` or an `alsoActiveOn` sibling,
 * exactly or as a prefix followed by `/` (exactly only with `exact`). A trailing
 * slash is ignored, and the longest match wins, so
 * `/superadmin/duplicate-people` is Duplicate people rather than Superadmin.
 */
export function destinationFor(
	pathname: string,
): RegisteredDestination | undefined {
	const path = normalise(pathname);
	let best: RegisteredDestination | undefined;
	let bestLength = -1;
	for (const d of NAV_DESTINATIONS) {
		const siblings: readonly string[] =
			"alsoActiveOn" in d ? d.alsoActiveOn : [];
		const exact = "exact" in d && d.exact;
		for (const route of [d.to, ...siblings]) {
			const length = matchLength(route, path, exact);
			if (length > bestLength) {
				best = d;
				bestLength = length;
			}
		}
	}
	return best;
}

/** The label a registered route is shown under — its own entry's, or for an
 *  `alsoActiveOn` sibling, the entry it belongs to. */
export function navLabel(to: NavRoute): string {
	const d = destinationFor(to);
	if (!d) throw new Error(`No nav destination registered for ${to}`);
	return d.label;
}

export function navGroup(key: NavGroupKey): NavGroup {
	const group = NAV_GROUPS.find((g) => g.key === key);
	if (!group) throw new Error(`Unknown nav group ${key}`);
	return group;
}

export function navDestination(key: NavDestinationKey): RegisteredDestination {
	const d = NAV_DESTINATIONS.find((x) => x.key === key);
	if (!d) throw new Error(`Unknown nav destination ${key}`);
	return d;
}

/** The page-title crumb for a destination: `${group} · ${label}`. */
export function crumbOf(d: NavDestination): string {
	return `${navGroup(d.group).label} · ${d.label}`;
}
