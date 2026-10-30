// "Add to calendar" for one held role (#1423). Built client-side from data the
// page already has: no route, no server fn. The event carries no location, join
// link, email or phone (see `#/lib/calendar`).
import { CalendarPlus } from "lucide-react";
import { Button } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
	calendarEvent,
	googleCalendarUrl,
	icsFilename,
	toIcs,
} from "#/lib/calendar";
import { utcToZonedWallTime } from "#/lib/datetime";
import { isMeetingOver } from "#/lib/meeting-lifecycle";
import { rolesGuideUrl } from "#/lib/role-guide";
import type { PersonalMeetingView } from "#/server/personal-meeting";

const DEFAULT_LENGTH_MINUTES = 90;

export function AddToCalendarButton({
	clubName,
	clubId,
	timezone,
	meetingKey,
	status,
	scheduledAt,
	lengthMinutes,
	slotId,
	roleName,
	roleKey,
}: {
	clubName: string;
	/** The club's URL segment, for the links in the event. */
	clubId: string;
	timezone: string;
	/** The raw `$meetingId` URL segment. */
	meetingKey: string;
	status: string;
	scheduledAt: Date | string;
	/** Absent reads as the schema default (`meetings.length_minutes`). */
	lengthMinutes: number | undefined;
	slotId: string;
	roleName: string;
	roleKey: string | null | undefined;
}) {
	if (status === "cancelled") return null;
	if (isMeetingOver({ status, scheduledAt, timezone })) return null;

	// Built at click time: `window` does not exist during SSR.
	const build = () => {
		const origin = window.location.origin;
		return calendarEvent({
			clubName,
			roleName,
			scheduledAt,
			lengthMinutes: lengthMinutes ?? DEFAULT_LENGTH_MINUTES,
			meetingUrl: `${origin}/club/${encodeURIComponent(clubId)}/meeting/${encodeURIComponent(meetingKey)}`,
			roleGuideUrl: roleKey ? rolesGuideUrl({ origin, clubId, roleKey }) : null,
			uid: `${slotId}@gavelup`,
		});
	};

	const downloadIcs = () => {
		const start =
			typeof scheduledAt === "string" ? new Date(scheduledAt) : scheduledAt;
		const localDate = utcToZonedWallTime(start, timezone).slice(0, 10);
		const blob = new Blob([toIcs(build())], {
			type: "text/calendar;charset=utf-8",
		});
		const href = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = href;
		a.download = icsFilename(clubName, localDate, roleName);
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(href);
	};

	const openGoogle = () => {
		window.open(googleCalendarUrl(build()), "_blank", "noopener,noreferrer");
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="outline" className="min-h-11 sm:min-h-9">
					<CalendarPlus aria-hidden className="size-4" />
					Add to calendar
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start">
				<DropdownMenuItem
					className="min-h-11 sm:min-h-8"
					onSelect={downloadIcs}
				>
					Apple / Outlook (.ics)
				</DropdownMenuItem>
				<DropdownMenuItem className="min-h-11 sm:min-h-8" onSelect={openGoogle}>
					Google Calendar
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** The button for one held role of a `PersonalMeetingView`: the two surfaces
 *  mount it identically, and the short call site keeps their JSX compact. */
export function RoleCalendarButton({
	view,
	role,
	clubId,
	meetingKey,
}: {
	view: PersonalMeetingView;
	role: PersonalMeetingView["roles"][number];
	clubId: string;
	meetingKey: string;
}) {
	return (
		<AddToCalendarButton
			clubName={view.club.name}
			clubId={clubId}
			timezone={view.club.timezone}
			meetingKey={meetingKey}
			status={view.meeting.status}
			scheduledAt={view.meeting.scheduledAt}
			lengthMinutes={view.meeting.lengthMinutes}
			slotId={role.slotId}
			roleName={role.roleName}
			roleKey={role.roleKey}
		/>
	);
}
