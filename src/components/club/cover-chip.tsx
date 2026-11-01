import { slotLabel } from "#/lib/agenda";
import { type CoverStatus, coveredStory, coverStatus } from "#/lib/cover";
import { APP_LOCALE, formatMeetingTime } from "#/lib/format";
import type { MeetingCoverRequest } from "#/server/cover-logic";

/** "Tue 9:14pm", in the club's zone. The time is the app's own
 *  `formatMeetingTime`; `format.ts` has no weekday-only helper, so the weekday
 *  uses its `APP_LOCALE`. */
export function droppedAt(at: Date, timeZone: string): string {
	const day = new Intl.DateTimeFormat(APP_LOCALE, {
		weekday: "short",
		timeZone,
	}).format(at);
	const time = formatMeetingTime(at, timeZone).replace(/\s/g, "").toLowerCase();
	return `${day} ${time}`;
}

/** The ONE definition of a meeting that takes no more cover: it has ended or
 *  it was cancelled. The landing card and the chips both read it. */
export function coverMeetingOver(args: {
	over: boolean;
	status: string;
}): boolean {
	return args.over || args.status === "cancelled";
}

const CHIP_CLASS =
	"mt-2 inline-flex max-w-full items-center rounded-full border border-dashed border-warning px-2.5 py-0.5 text-xs font-semibold text-warning-foreground";

/** The ONE "covered and over" rule: a covered story line stops showing once
 *  the meeting is past. */
export function hidesCoveredStory(
	status: CoverStatus,
	meetingOver: boolean,
): boolean {
	return status === "covered" && meetingOver;
}

/** One chip per cover request whose slot is on this meeting; none once the
 *  meeting is over or cancelled (#1461). */
export function coverChipsFor(args: {
	coverRequests: MeetingCoverRequest[];
	slots: {
		id: string;
		roleName: string;
		slotIndex: number;
		slotsUnordered?: boolean;
	}[];
	roleCounts: Record<string, number>;
	scheduledAt: Date;
	timezone: string;
	now: Date;
	meetingOver: boolean;
}) {
	if (args.meetingOver) return [];
	const chips: {
		request: MeetingCoverRequest;
		roleLabel: string;
		status: CoverStatus;
	}[] = [];
	for (const request of args.coverRequests) {
		const slot = args.slots.find((s) => s.id === request.slotId);
		if (!slot) continue;
		const status = coverStatus(
			request,
			{ scheduledAt: args.scheduledAt },
			args.timezone,
			args.now,
		);
		if (hidesCoveredStory(status, args.meetingOver)) continue;
		chips.push({
			request,
			roleLabel: slotLabel(slot, args.roleCounts),
			status,
		});
	}
	return chips;
}

/**
 * The cover line under a role in the lineup (#1440). `finding_cover` is amber
 * and dashed (read-only: nobody can act on it here), `dropped` is the same read-only treatment (a status, not a control: DESIGN.md
 * reserves the amber surface for what can be acted on), and
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
		if (
			hidesCoveredStory(status, meetingOver) ||
			!request.coveredAt ||
			!request.coveredName
		)
			return null;
		return (
			<p
				data-cover-chip="covered"
				className="mt-2 text-sm font-semibold text-success"
			>
				<span className="sr-only">{roleLabel}: </span>
				{coveredStory({
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
			<span data-cover-chip="finding_cover" className={CHIP_CLASS}>
				<span className="sr-only">{roleLabel}: </span>
				{request.releasedName} is finding cover
			</span>
		);
	}
	return (
		<span data-cover-chip="dropped" className={CHIP_CLASS}>
			<span className="sr-only">{roleLabel} open: </span>
			{request.releasedName} dropped it{" "}
			{droppedAt(new Date(request.releasedAt), timeZone)}
		</span>
	);
}
