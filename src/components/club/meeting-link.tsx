import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * Shared meeting link for the season grid (#214). TanStack Router's typed
 * `Link` requires a literal `to` string, so the public-vs-authed fork can't
 * be collapsed into one `<Link to={...}>` call — this component hides the
 * two-branch `if` behind a single call site instead.
 */
type MeetingLinkProps = {
	/** Club slug: when set (public club shell), links target the public meeting
	 *  view instead of the signed-in `/meetings/$id` route. */
	clubSlug?: string;
	meetingId: string;
	/** The meeting's canonical URL key (`$meetingId` param of the public view).
	 *  Required (#1396): a public link never falls back to the uuid. Unused by
	 *  the signed-in `/meetings/$id` branch, which takes the uuid. */
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
