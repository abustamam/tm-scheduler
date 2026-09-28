import { Link } from "@tanstack/react-router";
import { MessageSquareHeart } from "lucide-react";

/**
 * The meeting page's "Leave feedback" link (#984): shown while the anonymous
 * feedback window is open, and NOT while the in-room strip is showing, because
 * the strip carries its own button and two identical calls to action would sit
 * a few pixels apart. `open` is `feedbackWindow(...).canWrite` off the route's
 * one frozen clock; `inRoom` is the same value the strip's `visible` gets.
 */
export function MeetingFeedbackLink({
	open,
	inRoom,
	clubId,
	meetingKey,
}: {
	open: boolean;
	inRoom: boolean;
	/** The club segment as it appears in the URL (slug or uuid). */
	clubId: string;
	/** The meeting's URL key. */
	meetingKey: string;
}) {
	if (!open || inRoom) return null;
	return (
		<Link
			to="/club/$clubId/meeting/$meetingId/feedback"
			params={{ clubId, meetingId: meetingKey }}
			data-testid="meeting-leave-feedback"
			className="flex w-fit items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
		>
			<MessageSquareHeart className="size-4" aria-hidden />
			Leave feedback
		</Link>
	);
}
