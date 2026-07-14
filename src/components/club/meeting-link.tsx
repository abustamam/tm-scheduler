import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

type MeetingLinkProps = {
	clubSlug?: string;
	meetingId: string;
	className?: string;
	"aria-label"?: string;
	children: ReactNode;
};

export function MeetingLink({
	clubSlug,
	meetingId,
	className,
	"aria-label": ariaLabel,
	children,
}: MeetingLinkProps) {
	if (clubSlug) {
		return (
			<Link
				to="/club/$clubId/meeting/$meetingId"
				params={{ clubId: clubSlug, meetingId }}
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
