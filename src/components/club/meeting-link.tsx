import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * Shared meeting link for the season grid (#214). TanStack Router's typed
 * `Link` requires a literal `to` string, so the public-vs-authed fork can't
 * be collapsed into one `<Link to={...}>` call — this component hides the
 * two-branch `if` behind a single call site instead.
 */
export function MeetingLink({
	clubSlug,
	meetingId,
	meetingKey,
	className,
	"aria-label": ariaLabel,
	children,
}: {
	/** Club slug — when set (public club shell), links target the public
	 *  meeting view instead of the signed-in `/meetings/$id` route. */
	clubSlug?: string;
	meetingId: string;
	/** Club-local-date key for the PUBLIC view (`$meetingId` param). Defaults to
	 *  `meetingId`. Ignored by the authed `/meetings/$id` branch, which always
	 *  uses the raw uuid. */
	meetingKey?: string;
	className?: string;
	"aria-label"?: string;
	children: ReactNode;
}) {
	if (clubSlug) {
		return (
			<Link
				to="/club/$clubId/meeting/$meetingId"
				params={{ clubId: clubSlug, meetingId: meetingKey ?? meetingId }}
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
