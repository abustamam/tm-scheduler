/**
 * The meeting route's half of the tab shell (#1582).
 *
 * The route cannot be mounted in a test (see `meeting-room-wiring.guard.test.ts`),
 * so the pieces are tested where they live (`meetingTabsFor` and `meetingTabFrom`
 * in `meeting-hub.test.ts`, the shell in `meeting-tabs.test.tsx`) and this file
 * pins what neither can see: that the route hands `meetingTabsFor` the three
 * conditions that gate the sections today, and keeps `tab` out of validateSearch.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = "src/routes/club.$clubId.meeting.$meetingId.tsx";
const flat = (t: string) => t.replace(/\s+/g, " ");
const source = flat(readSource(ROUTE));

describe("the meeting route wires the tab shell (#1582)", () => {
	// protects=a tab is offered exactly when its section renders today;
	// fails_when=one of the three conditions is swapped for another, dropped or
	// negated; no_claim=what each tab holds (the panels are checked by their own
	// guards) or that the shell renders
	it("hands meetingTabsFor the three section gates", () => {
		expect(source).toContain(
			"const ballotsShown = (isVoteCounter || effectiveCanManage) && !cancelled;",
		);
		expect(source).toContain(
			"const minutesShown = Boolean(minutes.visible && minutes.data);",
		);
		expect(source).toContain(
			"meetingTabsFor({ attendance: showPanel && !tmodPanelUnavailable, ballots: ballotsShown, minutes: minutesShown || effectiveCanManage, })",
		);
	});

	// protects=the tab's offer and its panel use the SAME named gate, so they
	// cannot drift apart; fails_when=a panel re-spells its condition inline;
	// no_claim=the gates' own expressions (the test above pins them)
	it("renders the ballots and minutes panels behind the same gates", () => {
		const from = source.indexOf("panels={{");
		expect(from).toBeGreaterThan(-1);
		expect(source.indexOf("{ballotsShown ? (", from)).toBeGreaterThan(from);
		expect(
			source.indexOf("{minutesShown && minutes.data ? (", from),
		).toBeGreaterThan(from);
		// the inline spellings are gone from the panels
		expect(source.slice(from)).not.toContain(
			"(isVoteCounter || effectiveCanManage) && !cancelled",
		);
		expect(source.slice(from)).not.toContain("minutes.visible && minutes.data");
	});

	// protects=an in-app hash navigation (the toolbar's Minutes <Link hash>, a
	// pushState that fires no hashchange) reaches the tab shell; fails_when=the
	// route stops reading the router location's hash or stops passing it on;
	// no_claim=the shell's reaction to it (meeting-tabs.test.tsx drives that)
	it("feeds the router location's hash to the tab shell", () => {
		expect(source).toContain(
			"const locationHash = useLocation({ select: (l) => l.hash });",
		);
		expect(source).toContain("hash={locationHash}");
	});

	// protects=the URL's tab is resolved against the offered tabs and handed to
	// the shell; fails_when=the shell is handed an unresolved search value
	it("resolves the active tab against the offered tabs", () => {
		expect(source).toContain("meetingTabFrom(search, offeredTabs)");
		expect(source).toContain("tabs={offeredTabs}");
		expect(source).toContain("active={activeTab}");
	});

	// protects=a tab switch keeps `room` and any other key and does not scroll or
	// push history; fails_when=the navigate drops prev, pushes, or resets scroll
	it("switches tab through search with replace and no scroll reset", () => {
		expect(source).toContain("replace: true, resetScroll: false");
		expect(source).toContain("...rest, [MEETING_TAB_PARAM]: tab");
	});

	// protects=SSR never 307s a ?tab= URL; fails_when=validateSearch is replaced
	// by something that coerces or strips
	it("still validates search with the pass-through validator", () => {
		expect(source).toMatch(/validateSearch: validateMeetingRoomSearch,/);
	});

	// protects=each section sits in its own tab; fails_when=a section is dropped
	// from its panel or moved to another
	it("puts each section in its own tab's panel", () => {
		const from = source.indexOf("panels={{");
		expect(from).toBeGreaterThan(-1);
		const at = (m: string) => source.indexOf(m, from);
		const roles = at("roles: (");
		const attendance = at("attendance: (");
		const ballots = at("ballots: (");
		const minutes = at("minutes: (");
		expect(roles).toBeGreaterThan(-1);
		expect(roles).toBeLessThan(attendance);
		expect(attendance).toBeLessThan(ballots);
		expect(ballots).toBeLessThan(minutes);
		expect(at("<MeetingAgenda")).toBeGreaterThan(roles);
		expect(at("<MeetingAgenda")).toBeLessThan(attendance);
		expect(at("<MeetingAttendancePanel")).toBeGreaterThan(attendance);
		expect(at("<MeetingAttendancePanel")).toBeLessThan(ballots);
		expect(at("Ballot Counter console")).toBeGreaterThan(ballots);
		expect(at("Ballot Counter console")).toBeLessThan(minutes);
		expect(at("<MeetingMinutes")).toBeGreaterThan(minutes);
	});
});
