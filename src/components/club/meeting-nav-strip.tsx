import type { LinkProps } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import {
	defaultMeetingNavLinkProps,
	type MeetingNavItem,
} from "#/lib/meeting-nav";
import { cn } from "#/lib/utils";

/**
 * Horizontal date strip for jumping between a club's meetings on the member
 * view. Presentational: all ordering/labeling is done by `buildMeetingNavItems`.
 */
export function MeetingNavStrip({
	clubId,
	items,
	getLinkProps,
}: {
	// Only consumed by the default builder (when `getLinkProps` is omitted);
	// callers passing their own `getLinkProps` ignore it.
	clubId: string;
	items: MeetingNavItem[];
	getLinkProps?: (item: MeetingNavItem) => LinkProps;
}) {
	const linkPropsFor =
		getLinkProps ??
		((item: MeetingNavItem) => defaultMeetingNavLinkProps(clubId, item));
	const activeRef = useRef<HTMLLIElement>(null);
	const activeId = items.find((i) => i.isCurrent)?.meetingId;

	// Re-center on active change (navigating between meetings re-renders rather
	// than remounts this strip). `nearest` avoids a jump when the active tab is
	// already fully visible.
	// biome-ignore lint/correctness/useExhaustiveDependencies: activeId is the trigger; activeRef is stable
	useEffect(() => {
		activeRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
	}, [activeId]);

	if (items.length <= 1) return null;

	return (
		<nav aria-label="Meetings" className="-mx-4 overflow-x-auto px-4">
			<ul className="flex gap-2 pb-1">
				{items.map((item) => (
					<li
						key={item.meetingId}
						ref={item.isCurrent ? activeRef : undefined}
						className="shrink-0"
					>
						<Link
							{...linkPropsFor(item)}
							aria-current={item.isCurrent ? "page" : undefined}
							// Opts this anchor out of the UNLAYERED global text-link rule
							// in styles.css, which otherwise beats BOTH branches of the
							// `cn()` below. On the active pill it repainted --lagoon-deep
							// onto a --primary fill: 1.19:1 in dark, 1.53:1 in light — the
							// date you were looking at was the one date you could not read.
							// The exclusion goes on BOTH selectors there (base and :hover,
							// which are separate); see the comment beside them, and
							// `meeting-nav-link-color.guard.test.ts`.
							//
							// In the opening TAG, not above the element: this is JSX
							// children position, where `//` is literal text, not a comment
							// (biome `noCommentText`, and the formatter mangles it).
							data-slot="meeting-nav-link"
							className={cn(
								"flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition-colors",
								item.isCurrent
									? "border-primary bg-primary text-primary-foreground"
									: "border-border bg-card text-muted-foreground hover:bg-accent",
							)}
						>
							{item.label}
							{item.hasOpenRoles ? (
								<span
									role="img"
									aria-label="has open roles"
									className={cn(
										"size-1.5 rounded-full",
										item.isCurrent ? "bg-primary-foreground" : "bg-primary",
									)}
								/>
							) : null}
						</Link>
					</li>
				))}
			</ul>
		</nav>
	);
}
