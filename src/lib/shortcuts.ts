import {
	type NavDestinationKey,
	type NavGrant,
	type NavGrants,
	navDestination,
} from "#/lib/nav-destinations";

/**
 * Officer keyboard shortcuts (#1426): one static registry the listener, the `?`
 * sheet and the sidebar titles all read. A destination is named by its
 * `NAV_DESTINATIONS` key, so the path, label and grant come from that registry
 * and are never retyped here. Pure data; no React, no DOM.
 */

export type ShortcutGroup = "Go to" | "Actions";

export interface Shortcut {
	/** Space-separated presses: `"g r"` is a sequence, `"n"` and `"?"` are single. */
	keys: string;
	label: string;
	/** The destination this shortcut navigates to; absent for `?`. */
	to?: NavDestinationKey;
	grant: NavGrant;
	group: ShortcutGroup;
}

/** A navigation shortcut: label and grant are the destination's own. */
function goTo(
	keys: string,
	to: NavDestinationKey,
	group: ShortcutGroup,
): Shortcut {
	const d = navDestination(to);
	return { keys, label: d.label, to, grant: d.grant, group };
}

export const SHORTCUTS: readonly Shortcut[] = [
	goTo("g d", "my-dashboard", "Go to"),
	goTo("g s", "sign-up-sheet", "Go to"),
	goTo("g n", "next-meeting", "Go to"),
	goTo("g r", "roster", "Go to"),
	goTo("g v", "vp-education", "Go to"),
	goTo("g m", "vp-membership", "Go to"),
	goTo("g a", "agendas", "Go to"),
	goTo("n", "new-meetings", "Actions"),
	{
		keys: "?",
		label: "Keyboard shortcuts",
		grant: "everyone",
		group: "Actions",
	},
];

/** The shortcut that opens the help sheet. */
export const HELP_KEYS = "?";

function holds(grant: NavGrant, grants: NavGrants): boolean {
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

/** The shortcuts this user holds the grant for: the only ones that run or are listed. */
export function activeShortcuts(grants: NavGrants): Shortcut[] {
	return SHORTCUTS.filter((s) => holds(s.grant, grants));
}

/** The keys that reach a destination, for its sidebar `title`, or undefined. */
export function shortcutKeysFor(to: NavDestinationKey): string | undefined {
	return SHORTCUTS.find((s) => s.to === to)?.keys;
}

/** The `title` attribute for a sidebar entry: `Roster (g r)`, or the bare label. */
export function sidebarTitle(destination: {
	key: NavDestinationKey;
	label: string;
}): string {
	const keys = shortcutKeysFor(destination.key);
	return keys ? `${destination.label} (${keys})` : destination.label;
}

/** True on the present-mode route, which owns its own keys. */
export function isPresentRoute(pathname: string): boolean {
	return /^\/club\/[^/]+\/(?:.+\/)?present\/?$/.test(pathname);
}
