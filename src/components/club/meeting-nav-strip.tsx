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
	clubId: string;
	items: MeetingNavItem[];
	getLinkProps?: (meetingId: string) => LinkProps;
}) {
	const linkPropsFor =
		getLinkProps ??
		((meetingId: string) => defaultMeetingNavLinkProps(clubId, meetingId));
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
							{...linkPropsFor(item.meetingId)}
							aria-current={item.isCurrent ? "page" : undefined}
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
