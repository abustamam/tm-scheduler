import { describe, expect, it } from "vitest";
import { zonedWallTimeToUtc } from "#/lib/datetime";
import {
	calendarEvent,
	googleCalendarUrl,
	icsFilename,
	toIcs,
} from "./calendar";

const NOW = new Date("2026-10-29T12:00:00Z");

function nov12() {
	return calendarEvent({
		clubName: "Downtown Speakers",
		roleName: "Toastmaster",
		scheduledAt: zonedWallTimeToUtc("2026-11-12T19:00", "America/Chicago"),
		lengthMinutes: 90,
		meetingUrl: "https://gavelup.example/club/downtown/meeting/2026-11-12",
		roleGuideUrl:
			"https://gavelup.example/club/downtown/roles-guide#toastmaster",
		uid: "slot-1@gavelup",
	});
}

// Unfold per RFC 5545 3.1: a CRLF followed by one space is a continuation.
const unfold = (ics: string) => ics.replace(/\r\n /g, "");

describe("calendarEvent", () => {
	/*
	 * protects: the title/description shape and the end = start + length rule.
	 * fails_when: the role guide line is kept with no URL, the end ignores
	 *   lengthMinutes, or the uid stops being the caller's.
	 * no_claim: says nothing about how the event is rendered by a calendar app.
	 */
	it("builds title, description and end, and drops the guide line without a URL", () => {
		const e = nov12();
		expect(e.title).toBe("Toastmaster · Downtown Speakers meeting");
		expect(e.description).toBe(
			"You're Toastmaster.\nMeeting: https://gavelup.example/club/downtown/meeting/2026-11-12\nRole guide: https://gavelup.example/club/downtown/roles-guide#toastmaster",
		);
		expect(e.end.getTime() - e.start.getTime()).toBe(90 * 60_000);
		expect(e.uid).toBe("slot-1@gavelup");

		const bare = calendarEvent({
			clubName: "C",
			roleName: "Timer",
			scheduledAt: e.start,
			lengthMinutes: 60,
			meetingUrl: "https://x/m",
			roleGuideUrl: null,
			uid: "u",
		});
		expect(bare.description).toBe("You're Timer.\nMeeting: https://x/m");
	});
});

describe("toIcs", () => {
	/*
	 * protects: the exact VCALENDAR bytes: CRLF, UTC stamps, PRODID, escaping.
	 * fails_when: a separator becomes LF, a time is written local or with
	 *   milliseconds, or `\ ; ,` / a newline is left unescaped in SUMMARY or
	 *   DESCRIPTION.
	 * no_claim: not validated against a real calendar parser.
	 */
	it("matches the golden string, escaping backslash, semicolon, comma and newline", () => {
		const e = calendarEvent({
			clubName: "A,B;C\\D",
			roleName: "Timer",
			scheduledAt: new Date("2026-11-13T01:00:00Z"),
			lengthMinutes: 90,
			meetingUrl: "https://x/m",
			uid: "s@gavelup",
		});
		expect(toIcs(e, NOW)).toBe(
			[
				"BEGIN:VCALENDAR",
				"VERSION:2.0",
				"PRODID:-//GavelUp//EN",
				"CALSCALE:GREGORIAN",
				"BEGIN:VEVENT",
				"UID:s@gavelup",
				"DTSTAMP:20261029T120000Z",
				"DTSTART:20261113T010000Z",
				"DTEND:20261113T023000Z",
				"SUMMARY:Timer · A\\,B;C\\\\D meeting",
				"DESCRIPTION:You're Timer.\\nMeeting: https://x/m",
				"URL:https://x/m",
				"END:VEVENT",
				"END:VCALENDAR",
				"",
			].join("\r\n"),
		);
	});

	/*
	 * protects: folding at 75 octets (not characters) with a lossless unfold.
	 * fails_when: a physical line exceeds 75 bytes, a multi-byte character is
	 *   split, or unfolding does not reproduce the logical line.
	 * no_claim: only the DESCRIPTION line is exercised.
	 */
	it("folds a 100-char description at 75 octets and unfolds losslessly", () => {
		const long = `${"é".repeat(50)}${"x".repeat(50)}`;
		const e = { ...nov12(), description: long };
		const ics = toIcs(e, NOW);
		const encoder = new TextEncoder();
		for (const line of ics.split("\r\n")) {
			expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
		}
		expect(ics).toContain("\r\n ");
		expect(unfold(ics)).toContain(`DESCRIPTION:${long}\r\n`);
		// Every line break inside the property is a valid fold, never a bare LF.
		expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
	});

	/*
	 * protects: UTC conversion for the issue's example and across a DST change
	 *   (CDT -5 before 2026-11-01, CST -6 after).
	 * fails_when: the zone's offset at the meeting's own date is not used.
	 * no_claim: the club zone itself is not read here.
	 */
	it("writes Nov 12 19:00 Chicago as 01:00Z and honours the DST boundary", () => {
		const ics = toIcs(nov12(), NOW);
		expect(ics).toContain("DTSTART:20261113T010000Z");
		expect(ics).toContain("DTEND:20261113T023000Z");

		const before = calendarEvent({
			clubName: "C",
			roleName: "R",
			scheduledAt: zonedWallTimeToUtc("2026-10-29T19:00", "America/Chicago"),
			lengthMinutes: 60,
			meetingUrl: "u",
			uid: "u",
		});
		expect(toIcs(before, NOW)).toContain("DTSTART:20261030T000000Z");
	});

	/*
	 * protects: nothing location-like, no join link, no email or phone.
	 * fails_when: a LOCATION/ATTENDEE/ORGANIZER/GEO property or a contact value
	 *   is ever emitted.
	 * no_claim: the meeting URL itself is a link the page gates.
	 */
	it("carries no location, join link, email or phone", () => {
		const ics = toIcs(nov12(), NOW);
		expect(ics).not.toMatch(/^(LOCATION|ATTENDEE|ORGANIZER|GEO|CONFERENCE)/m);
		expect(ics).not.toMatch(/@(?!gavelup)/);
		expect(ics).not.toMatch(
			/zoom|meet\.google|tel:|\+?\d{3}[-. ]\d{3}[-. ]\d{4}/i,
		);
	});
});

describe("googleCalendarUrl", () => {
	/*
	 * protects: the TEMPLATE link's UTC range, encoded title and details, and
	 *   the absence of a location parameter.
	 * fails_when: dates are local, the title is not URL-encoded, or a `location`
	 *   / `add` (guest) parameter appears.
	 * no_claim: the link is not opened against Google.
	 */
	it("carries the same UTC range and the encoded title, with no location", () => {
		const url = googleCalendarUrl(nov12());
		const u = new URL(url);
		expect(u.origin + u.pathname).toBe(
			"https://calendar.google.com/calendar/render",
		);
		expect(u.searchParams.get("action")).toBe("TEMPLATE");
		expect(u.searchParams.get("dates")).toBe(
			"20261113T010000Z/20261113T023000Z",
		);
		expect(u.searchParams.get("text")).toBe(
			"Toastmaster · Downtown Speakers meeting",
		);
		expect(url).toContain("text=Toastmaster+%C2%B7+Downtown+Speakers+meeting");
		expect(u.searchParams.has("location")).toBe(false);
		expect(u.searchParams.has("add")).toBe(false);
	});
});

describe("icsFilename", () => {
	/*
	 * protects: `<club>-<yyyy-mm-dd>-<role>.ics`, slugified.
	 * fails_when: spaces, accents or punctuation survive into the filename.
	 * no_claim: nothing about filesystem reserved names.
	 */
	it("slugifies club and role", () => {
		expect(
			icsFilename("Café Speakers!", "2026-11-12", "General Evaluator"),
		).toBe("cafe-speakers-2026-11-12-general-evaluator.ics");
	});
});
