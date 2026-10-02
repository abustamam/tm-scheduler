// The cancellation notice builder (#1057): what the officer copies, who it
// names, and which addresses ride with it. Pure; the same function the meeting
// page's sheet and the `cancel_meeting` MCP tool build from.
import { describe, expect, it } from "vitest";
import { formatMeetingDate } from "./format";
import {
	assertMeetingNotCancelled,
	buildCancellationNotice,
	type CancellationHolder,
	cancellationNoticeHref,
	holdersFromSlots,
	isCancellationNoticeRequested,
	MEETING_CANCEL_PAST_MESSAGE,
	MEETING_CANCELLED_MESSAGE,
	meetingHasStarted,
} from "./meeting-cancellation-notice";

const AT = "2026-10-03T15:00:00Z";
const TZ = "America/Chicago";
// The SAME formatter the meeting page header uses, so the notice names the day
// the officer is looking at. Pinned by identity with the function rather than
// by a literal, which would agree with whichever renderer the author had in
// mind (the #725 lesson).
const DATE = formatMeetingDate(AT, TZ);

function notice(holders: readonly CancellationHolder[]) {
	return buildCancellationNotice({
		clubName: "Downtown Speakers",
		scheduledAt: AT,
		timezone: TZ,
		holders,
	});
}

describe("buildCancellationNotice", () => {
	it("with no holders is the one sentence, with no lines and no addresses", () => {
		const n = notice([]);
		expect(n.text).toBe(`Our meeting on ${DATE} is cancelled.`);
		expect(n.lines).toEqual([]);
		expect(n.emails).toEqual([]);
	});

	it("names every held role in agenda order, one line per role, joining several holders with ', '", () => {
		const n = notice([
			{ roleName: "Toastmaster", name: "Alice", email: "alice@example.com" },
			{ roleName: "Speaker", name: "Bob", email: "bob@example.com" },
			{ roleName: "Speaker", name: "Carol", email: null },
			{ roleName: "Timer", name: "Dana", email: "dana@example.com" },
		]);
		expect(n.text).toBe(
			[
				`Our meeting on ${DATE} is cancelled.`,
				"",
				"Toastmaster: Alice",
				"Speaker: Bob, Carol",
				"Timer: Dana",
			].join("\n"),
		);
		expect(n.lines).toEqual([
			{ roleName: "Toastmaster", names: ["Alice"] },
			{ roleName: "Speaker", names: ["Bob", "Carol"] },
			{ roleName: "Timer", names: ["Dana"] },
		]);
	});

	it("keeps the order the holders were given, which callers take from the agenda", () => {
		// Reversed input, reversed output: the builder sorts nothing.
		const n = notice([
			{ roleName: "Timer", name: "Dana" },
			{ roleName: "Toastmaster", name: "Alice" },
		]);
		expect(n.lines.map((l) => l.roleName)).toEqual(["Timer", "Toastmaster"]);
	});

	it("collects member addresses only, de-duplicated case-insensitively, in order", () => {
		const n = notice([
			{ roleName: "Toastmaster", name: "Alice", email: "Alice@Example.com" },
			{ roleName: "Speaker", name: "Bob", email: "bob@example.com" },
			// Same person on two roles: one address.
			{ roleName: "Timer", name: "Alice", email: "alice@example.com" },
			// A guest, or a member with no address on file: named, not addressed.
			{ roleName: "Grammarian", name: "Guest Gus", email: null },
			{ roleName: "Ah-Counter", name: "Eve" },
			// Whitespace is not a different address.
			{ roleName: "Evaluator", name: "Bob", email: " bob@example.com " },
		]);
		expect(n.emails).toEqual(["Alice@Example.com", "bob@example.com"]);
		// Everyone is still NAMED, address or not.
		expect(n.text).toContain("Grammarian: Guest Gus");
		expect(n.text).toContain("Ah-Counter: Eve");
	});

	it("gives the officer a subject that names the club and the date", () => {
		expect(notice([]).subject).toBe(
			`Downtown Speakers: meeting on ${DATE} cancelled`,
		);
	});

	it("formats the date in the CLUB's zone", () => {
		// 15:00Z on 3 Oct is 10:00 in Chicago but already 4 Oct in Auckland;
		// the notice must follow the club, not the server.
		const auckland = buildCancellationNotice({
			clubName: "X",
			scheduledAt: AT,
			timezone: "Pacific/Auckland",
			holders: [],
		});
		expect(auckland.text).toContain(formatMeetingDate(AT, "Pacific/Auckland"));
		expect(auckland.text).not.toContain(DATE);
	});
});

describe("holdersFromSlots", () => {
	it("keeps held slots in order, drops open ones, and never addresses a guest", () => {
		const holders = holdersFromSlots([
			{ roleName: "Toastmaster", assigneeName: "Alice", holderEmail: "a@x" },
			{ roleName: "Speaker", assigneeName: null, holderEmail: null },
			{
				roleName: "Speaker",
				assigneeName: "Guest Gus",
				assigneeIsGuest: true,
				// Even if a caller hands one over, a guest gets no address: guest
				// contact has never ridden on this surface.
				holderEmail: "gus@x",
			},
			// The connector's rows carry no email at all.
			{ roleName: "Timer", assigneeName: "Dana" },
		]);
		expect(holders).toEqual([
			{ roleName: "Toastmaster", name: "Alice", email: "a@x" },
			{ roleName: "Speaker", name: "Guest Gus", email: null },
			{ roleName: "Timer", name: "Dana", email: null },
		]);
	});
});

describe("the notice flag on the uuid URL", () => {
	it("builds the uuid meeting URL with the flag set", () => {
		expect(cancellationNoticeHref("downtown", "abc-123")).toBe(
			"/club/downtown/meeting/abc-123?notice=1",
		);
	});

	it("reads both spellings the router can hand over, and nothing else", () => {
		expect(isCancellationNoticeRequested({ notice: 1 })).toBe(true);
		expect(isCancellationNoticeRequested({ notice: "1" })).toBe(true);
		expect(isCancellationNoticeRequested({})).toBe(false);
		expect(isCancellationNoticeRequested({ room: 1 })).toBe(false);
		expect(isCancellationNoticeRequested({ notice: 0 })).toBe(false);
		expect(isCancellationNoticeRequested({ notice: true })).toBe(false);
	});
});

describe("meetingHasStarted (the cancel rule, maintainer's decision on #1084)", () => {
	const start = new Date("2026-10-03T23:00:00Z");

	it("is false before the start, and true at it and after it", () => {
		expect(meetingHasStarted(start, new Date(start.getTime() - 1))).toBe(false);
		expect(meetingHasStarted(start, start)).toBe(true);
		expect(meetingHasStarted(start, new Date(start.getTime() + 1))).toBe(true);
	});

	it("reads an ISO string the same as a Date (the page hands it the payload's)", () => {
		expect(meetingHasStarted(start.toISOString(), start)).toBe(true);
		expect(
			meetingHasStarted(start.toISOString(), new Date(start.getTime() - 1)),
		).toBe(false);
	});

	it("ignores the day: started minutes ago is started, though the day is not over", () => {
		expect(
			meetingHasStarted(start, new Date(start.getTime() + 10 * 60_000)),
		).toBe(true);
	});

	it("the refusal says the meeting has started, not that a date passed", () => {
		expect(MEETING_CANCEL_PAST_MESSAGE).toMatch(/already started/);
	});
});

describe("assertMeetingNotCancelled", () => {
	it("throws the member-facing sentence for a cancelled meeting and nothing otherwise", () => {
		expect(() => assertMeetingNotCancelled("cancelled")).toThrow(
			MEETING_CANCELLED_MESSAGE,
		);
		expect(() => assertMeetingNotCancelled("scheduled")).not.toThrow();
		expect(() => assertMeetingNotCancelled("completed")).not.toThrow();
	});
});
