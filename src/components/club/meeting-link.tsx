import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * Shared meeting link for the season grid (#214). TanStack Router's typed
 * `Link` requires a literal `to` string, so the public-vs-authed fork can't
 * be collapsed into one `<Link to={...}>` call — this component hides the
 * two-branch `if` behind a single call site instead.
 */
type MeetingLinkProps = {
	/** The club's slug, from the grid data (#1401). When set, the link is the
	 *  canonical `/club/$clubId/meeting/$meetingId`, signed in or not; null only
	 *  for the empty grid, which falls back to `/meetings/$id`. */
	clubSlug?: string | null;
	meetingId: string;
	/** The meeting's canonical URL key (`$meetingId` param of the public view).
	 *  Required (#1396): a slug link never falls back to the uuid. Unused by
	 *  the `/meetings/$id` branch, which takes the uuid. */
	meetingKey: string;
	className?: string;
	"aria-label"?: string;
	children: ReactNode;
};

export function MeetingLink({
	clubSlug,
	meetingId,
	meetingKey,
	className,
	"aria-label": ariaLabel,
	children,
}: MeetingLinkProps) {
	if (clubSlug) {
		return (
			<Link
				to="/club/$clubId/meeting/$meetingId"
				params={{ clubId: clubSlug, meetingId: meetingKey }}
				className={className}
				aria-label={ariaLabel}
			>
				{children}
			</Link>
		);
	}
	return (
		<Link
			to="/meetings/$id"
			params={{ id: meetingId }}
			className={className}
			aria-label={ariaLabel}
		>
			{children}
		</Link>
	);
}
