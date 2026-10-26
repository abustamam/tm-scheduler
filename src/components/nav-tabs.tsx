import { Link, useRouterState } from "@tanstack/react-router";
import type { NavRoute } from "#/lib/nav-destinations";

/**
 * A row of sibling-page links at the top of a pair of pages that share one nav
 * entry (#911): the sidebar shows the pair once, so this is how you move
 * between its two halves. Both pages render the same tab set, so each links to
 * the other.
 */
export interface NavTab {
	to: NavRoute;
	label: string;
}

/** `/admin/meetings/new` and `/admin/meetings/batch` — the New meetings entry. */
export const NEW_MEETINGS_TABS: readonly NavTab[] = [
	{ to: "/admin/meetings/new", label: "One meeting" },
	{ to: "/admin/meetings/batch", label: "Several at once" },
];

/** `/admin/sync-tokens` and `/admin/pathways-sync` — the Pathways sync entry. */
export const PATHWAYS_SYNC_TABS: readonly NavTab[] = [
	{ to: "/admin/sync-tokens", label: "Base Camp extension" },
	{ to: "/admin/pathways-sync", label: "Paste manually" },
];

export function NavTabs({
	tabs,
	label,
}: {
	tabs: readonly NavTab[];
	/** Accessible name for the tab row's `<nav>`. */
	label: string;
}) {
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const current = pathname.replace(/\/+$/, "");
	return (
		<nav
			aria-label={label}
			className="inline-flex gap-1 rounded-lg border border-border bg-surface-soft p-1"
		>
			{tabs.map((tab) => {
				const active = tab.to === current;
				return (
					<Link
						key={tab.to}
						to={tab.to}
						aria-current={active ? "page" : undefined}
						className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
							active
								? "bg-surface-raised font-bold text-foreground shadow-sm"
								: "font-semibold text-muted-foreground hover:text-foreground"
						}`}
					>
						{tab.label}
					</Link>
				);
			})}
		</nav>
	);
}
