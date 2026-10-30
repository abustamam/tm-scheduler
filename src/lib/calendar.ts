// Calendar export for a held role (#1423). Pure: no DOM, no clock except the
// optional DTSTAMP, so the .ics and the Google link are golden-testable.
//
// DELIBERATELY ABSENT from every field: location, join link, member email or
// phone. The event links to the meeting page, which already decides what the
// viewer may see; an .ics lives forever in a calendar that syncs to other
// devices and people, so it carries nothing the page would gate.

export interface CalendarEvent {
	title: string;
	start: Date;
	end: Date;
	description: string;
	url: string;
	uid: string;
}

/** `scheduledAt` is a Date on the server and an ISO string after hydration. */
export function toDate(value: Date | string): Date {
	return typeof value === "string" ? new Date(value) : value;
}

export function calendarEvent(args: {
	clubName: string;
	roleName: string;
	scheduledAt: Date | string;
	lengthMinutes: number;
	meetingUrl: string;
	/** Omitted line when there is no guide URL. */
	roleGuideUrl?: string | null;
	uid: string;
}): CalendarEvent {
	const start = toDate(args.scheduledAt);
	const end = new Date(start.getTime() + args.lengthMinutes * 60_000);
	const lines = [`You're ${args.roleName}.`, `Meeting: ${args.meetingUrl}`];
	if (args.roleGuideUrl) lines.push(`Role guide: ${args.roleGuideUrl}`);
	return {
		title: `${args.roleName} · ${args.clubName} meeting`,
		start,
		end,
		description: lines.join("\n"),
		url: args.meetingUrl,
		uid: args.uid,
	};
}

/** `YYYYMMDDTHHMMSSZ`, UTC. */
export function icsUtc(d: Date): string {
	return d
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
}

/** RFC 5545 TEXT escaping: backslash first, then `;` `,` and newlines. */
function escapeText(s: string): string {
	return s
		.replace(/\\/g, "\\\\")
		.replace(/;/g, "\\;")
		.replace(/,/g, "\\,")
		.replace(/\r\n|\r|\n/g, "\\n");
}

const encoder = new TextEncoder();

/** Fold at 75 octets, never inside a UTF-8 sequence; continuation lines start
 *  with one space, which counts toward their 75. */
function fold(line: string): string {
	if (encoder.encode(line).length <= 75) return line;
	const out: string[] = [];
	let cur = "";
	let curBytes = 0;
	for (const ch of line) {
		const n = encoder.encode(ch).length;
		if (curBytes + n > 75) {
			out.push(cur);
			cur = " ";
			curBytes = 1;
		}
		cur += ch;
		curBytes += n;
	}
	out.push(cur);
	return out.join("\r\n");
}

export function toIcs(event: CalendarEvent, now: Date = new Date()): string {
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//GavelUp//EN",
		"CALSCALE:GREGORIAN",
		"BEGIN:VEVENT",
		`UID:${event.uid}`,
		`DTSTAMP:${icsUtc(now)}`,
		`DTSTART:${icsUtc(event.start)}`,
		`DTEND:${icsUtc(event.end)}`,
		`SUMMARY:${escapeText(event.title)}`,
		`DESCRIPTION:${escapeText(event.description)}`,
		`URL:${event.url}`,
		"END:VEVENT",
		"END:VCALENDAR",
	];
	return `${lines.map(fold).join("\r\n")}\r\n`;
}

export function googleCalendarUrl(event: CalendarEvent): string {
	const params = new URLSearchParams({
		action: "TEMPLATE",
		text: event.title,
		dates: `${icsUtc(event.start)}/${icsUtc(event.end)}`,
		details: event.description,
	});
	return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** `<club>-<yyyy-mm-dd>-<role>.ics`, slugified. The date is the club-local
 *  one the caller passes, so the name matches what the member sees. */
export function icsFilename(
	clubName: string,
	localDate: string,
	roleName: string,
): string {
	const slug = (s: string) =>
		s
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "x";
	return `${slug(clubName)}-${localDate}-${slug(roleName)}.ics`;
}
