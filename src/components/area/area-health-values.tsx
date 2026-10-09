import { useEffect, useState } from "react";
import {
	type ClubHealth,
	type ClubHealthStatus,
	RECENT_WINDOW_DAYS,
} from "#/lib/area-health";
import type { AreaHealthFieldKey } from "#/lib/area-health-fields";
import { DCP_GOALS } from "#/lib/dcp";
import { APP_LOCALE, formatMeetingDate } from "#/lib/format";

// What the area view prints for each of a club's numbers (#1119), in ONE place
// so the desktop table and the phone cards can never say different things about
// the same club. Every value is a count, a rate or a date: `ClubHealth` carries
// nothing about a person, and nothing here asks for more.
//
// "NOT TRACKED" IS NOT ZERO (`#/lib/area-health`). A field that is
// `tracked: false` prints "Not tracked" and never a number, so an Area Director
// comparing clubs can tell a quiet club from one that does not use the feature.

/** The text for a field the club does not record. Exported for the tests. */
export const NOT_TRACKED_TEXT = "Not tracked";

/** The text in place of the numbers for a club that has none to show. */
export function statusNote(status: ClubHealthStatus): string | null {
	switch (status) {
		case "on_gavelup":
			return null;
		case "not_on_gavelup":
			return "Not on GavelUp";
	}
}

/** "Club 1234567", or nothing for a club with no number on file. */
export function clubNumberText(clubNumber: string | null): string | null {
	return clubNumber ? `Club ${clubNumber}` : null;
}

function NotTracked() {
	return <span className="text-muted-foreground">{NOT_TRACKED_TEXT}</span>;
}

function Detail({ children }: { children: React.ReactNode }) {
	return <div className="text-xs text-muted-foreground">{children}</div>;
}

/** One decimal, the same in every runtime (no locale in the digits). */
function oneDecimal(n: number): string {
	return n.toFixed(1);
}

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/**
 * The next meetings' dates, in the VIEWER's zone and only after mount.
 *
 * `area-health` carries the meetings as instants and no club zone, so there is
 * no zone the server could name them in that is right for the club. Formatting
 * with the runtime's zone during render would print one day in the UTC server
 * and another in the viewer's browser, and React would throw the server markup
 * away (#608, #1017). So both first passes print a count, which no zone
 * changes, and the dates land after mount (`SpeechLogDate` is the precedent).
 */
function NextMeetings({ next }: { next: readonly string[] }) {
	// The viewer's own zone, named once they are in a browser: null on the server
	// pass and on every first client render, so both print the same thing.
	const [zone, setZone] = useState<string | null>(null);
	useEffect(
		() => setZone(Intl.DateTimeFormat().resolvedOptions().timeZone),
		[],
	);
	if (next.length === 0) return <Detail>No meetings on the calendar</Detail>;
	if (zone === null) {
		return <Detail>{plural(next.length, "meeting", "meetings")} next</Detail>;
	}
	return (
		<Detail>
			Next: {next.map((d) => formatMeetingDate(d, zone)).join(", ")}
		</Detail>
	);
}

function daysSinceText(days: number | null): string {
	if (days === null) return "None held yet";
	if (days === 0) return "Last held today";
	return `Last held ${plural(days, "day", "days")} ago`;
}

/** One field of one club: its numbers, or "Not tracked". */
export function FieldValue({
	club,
	field,
}: {
	club: ClubHealth;
	field: AreaHealthFieldKey;
}) {
	switch (field) {
		case "meetings": {
			const f = club.meetings;
			if (!f.tracked) return <NotTracked />;
			return (
				<div className="space-y-0.5">
					<div>
						{f.value.held} held
						{f.value.cancelled > 0 ? `, ${f.value.cancelled} cancelled` : ""}
					</div>
					<Detail>{daysSinceText(f.value.daysSinceLast)}</Detail>
					<NextMeetings next={f.value.next} />
				</div>
			);
		}
		case "roleFillRate": {
			const f = club.roleFillRate;
			if (!f.tracked) return <NotTracked />;
			const percent = Math.round((f.value.filled / f.value.total) * 100);
			return (
				<div className="space-y-0.5">
					<div>{percent}%</div>
					<Detail>
						{f.value.filled} of {f.value.total} roles filled
					</Detail>
				</div>
			);
		}
		case "attendance": {
			const f = club.attendance;
			if (!f.tracked) return <NotTracked />;
			return (
				<div className="space-y-0.5">
					<div>{oneDecimal(f.value.avgMembers)} members</div>
					<Detail>
						{oneDecimal(f.value.avgGuests)} guests; a roll at{" "}
						{f.value.rollTaken} of {f.value.held}
					</Detail>
				</div>
			);
		}
		case "officers": {
			const f = club.officers;
			if (!f.tracked) return <NotTracked />;
			return (
				<div className="space-y-0.5">
					<div>
						{f.value.seatsFilled} of {f.value.seatsTotal} filled
					</div>
					<Detail>
						{f.value.trained.tracked
							? `${f.value.trained.value} trained`
							: `Training: ${NOT_TRACKED_TEXT.toLowerCase()}`}
					</Detail>
				</div>
			);
		}
		case "dcp": {
			const f = club.dcp;
			if (!f.tracked) return <NotTracked />;
			return (
				<div>
					{f.value.goalsMet} of {DCP_GOALS.length} goals
				</div>
			);
		}
		case "renewals": {
			const f = club.renewals;
			if (!f.tracked) return <NotTracked />;
			return (
				<div className="space-y-0.5">
					<div>{f.value.paidThisPeriod} this period</div>
					<Detail>{f.value.paidLastPeriod} last period</Detail>
				</div>
			);
		}
		default: {
			const unreachable: never = field;
			return unreachable;
		}
	}
}

/**
 * The "as of" line: when the numbers were read. Named in UTC and says so, since
 * the server's clock is the one that read them and a zone-less print would be a
 * hydration mismatch between the server and a browser elsewhere (#1017).
 */
export function formatAsOf(asOf: string): string {
	const text = new Intl.DateTimeFormat(APP_LOCALE, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZone: "UTC",
	}).format(new Date(asOf));
	return `${text} UTC`;
}

/** How far back "recent" reaches, for the line that says what the counts cover. */
export const RECENT_WINDOW_NOTE = `Meetings, role fill and attendance count the last ${RECENT_WINDOW_DAYS} days.`;
