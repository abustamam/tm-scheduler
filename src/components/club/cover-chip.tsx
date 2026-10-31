import { coveredStory } from "#/lib/cover";
import type { MeetingCoverRequest } from "#/server/cover-logic";

/** "Tue 9:14pm", in the club's zone. */
function droppedAt(at: Date, timeZone: string): string {
	const day = new Intl.DateTimeFormat("en-US", {
		weekday: "short",
		timeZone,
	}).format(at);
	const time = new Intl.DateTimeFormat("en-US", {
		hour: "numeric",
		minute: "2-digit",
		timeZone,
	})
		.format(at)
		.replace(/\s/g, "")
		.toLowerCase();
	return `${day} ${time}`;
}

/**
 * The cover line under a role in the lineup (#1440). `finding_cover` is amber
 * and dashed (read-only: nobody can act on it here), `dropped` is amber, and
 * `covered` is the green story line, shown only while the meeting is ahead.
 * Names only: the payload carries nothing else.
 */
export function CoverChip({
	request,
	status,
	roleLabel,
	timeZone,
	meetingOver,
}: {
	request: MeetingCoverRequest;
	status: "finding_cover" | "dropped" | "covered";
	roleLabel: string;
	timeZone: string;
	meetingOver: boolean;
}) {
	if (status === "covered") {
		if (meetingOver || !request.coveredAt || !request.coveredName) return null;
		return (
			<p
				data-cover-chip="covered"
				className="text-sm font-semibold text-success"
			>
				{coveredStory({
					roleLabel,
					releasedName: request.releasedName,
					coveredName: request.coveredName,
					releasedAt: new Date(request.releasedAt),
					coveredAt: new Date(request.coveredAt),
				})}
			</p>
		);
	}
	if (status === "finding_cover") {
		return (
			<span
				data-cover-chip="finding_cover"
				className="inline-flex max-w-full items-center rounded-full border border-dashed border-warning px-2.5 py-0.5 text-xs font-semibold text-warning-foreground"
			>
				{request.releasedName} is finding cover
			</span>
		);
	}
	return (
		<span
			data-cover-chip="dropped"
			className="inline-flex max-w-full items-center rounded-full border border-warning bg-warning/15 px-2.5 py-0.5 text-xs font-semibold text-warning-foreground"
		>
			Open: {request.releasedName} dropped it{" "}
			{droppedAt(new Date(request.releasedAt), timeZone)}
		</span>
	);
}
