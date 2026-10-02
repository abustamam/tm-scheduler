// @vitest-environment jsdom
//
// Component tests for the "Stopped attending" section of vpe-dashboard.tsx
// (#530). The rest of the route (speaker queue / overdue) is unchanged; these
// cover only what the new section adds — the `isLapsed` filter that decides
// which rows the officer sees at all, the empty state, the stat tile, and
// LapseRow's three-way secondary-line branch.
//
// That branch is the reason this file exists: `loadAttendanceLapse` returns a
// row for EVERY active member and the page filters to the lapsed ones, so a
// filter that inverted or vanished would put the whole roster on a
// "stopped attending" list with the server suite entirely green.
//
// Pattern follows club-settings.test.tsx: mock the server-fn module (it reaches
// `#/db` → `pg`, which must not load under jsdom), stub `Route.useLoaderData`,
// and render the component directly rather than running the real loader.
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttendanceLapseRow } from "#/lib/attendance-lapse";
import type {
	LevelNudgeMeeting,
	LevelProximityRow,
} from "#/lib/level-proximity";
import type { OverdueMemberRow } from "#/server/reporting-logic";

vi.mock("#/server/reporting", () => ({
	getSpeakerRotation: vi.fn(),
	getOverdueMembers: vi.fn(),
	getAttendanceLapse: vi.fn(),
	getEvaluatorPairings: vi.fn(),
	getLevelProximity: vi.fn(),
}));

import { Route } from "./vpe-dashboard";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function lapseRow(over: Partial<AttendanceLapseRow> = {}): AttendanceLapseRow {
	return {
		memberId: "22222222-2222-4222-8222-222222222222",
		name: "Dana Drift",
		joinedAt: new Date("2024-01-15T00:00:00Z"),
		streak: 4,
		presentCount: 2,
		eligibleCount: 8,
		rate: 0.25,
		lastSeenAt: new Date("2026-05-06T00:00:00Z"),
		isLapsed: true,
		...over,
	};
}

async function renderRoute(
	lapse: AttendanceLapseRow[],
	extra: {
		overdue?: OverdueMemberRow[];
		proximity?: LevelProximityRow[];
		timezone?: string;
		nextMeeting?: LevelNudgeMeeting | null;
	} = {},
) {
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		rotation: [],
		overdue: extra.overdue ?? [],
		lapse,
		// #709 added a fourth loader key; this file asserts nothing about it.
		pairings: [],
		proximity: extra.proximity ?? [],
		// #942's section; this file asserts nothing about it.
		orientation: [],
		timezone: extra.timezone,
		// The instant the loader pins for tenure (#1017).
		now: Date.parse("2026-09-15T12:00:00Z"),
		clubName: "Downtown Club",
		clubId: "11111111-1111-4111-8111-111111111111",
		clubSlug: "downtown",
		nextMeeting: extra.nextMeeting ?? null,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);

	const Component = Route.options.component as () => React.ReactElement;
	const rootRoute = createRootRoute({ component: () => <Component /> });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
	return router;
}

/** The "Stopped attending" stat tile's number. */
function stoppedAttendingCount() {
	const label = screen.getByText("Stopped attending", {
		selector: "div",
	});
	return label.parentElement?.querySelector("span")?.textContent;
}

describe("VPE dashboard — Stopped attending (#530)", () => {
	it("shows the empty state when no member has lapsed", async () => {
		await renderRoute([lapseRow({ isLapsed: false, streak: 1 })]);
		expect(screen.getByText(/Nobody has dropped off the radar/)).toBeTruthy();
		expect(screen.queryByText("Dana Drift")).toBeNull();
		expect(stoppedAttendingCount()).toBe("0");
	});

	it("lists only the rows flagged isLapsed, not the whole roster", async () => {
		// The server returns a row per ACTIVE MEMBER; only the lapsed ones belong
		// on this list. A dropped filter would name every member here.
		await renderRoute([
			lapseRow({ memberId: "a", name: "Dana Drift", isLapsed: true }),
			lapseRow({
				memberId: "b",
				name: "Reg Regular",
				streak: 0,
				isLapsed: false,
			}),
		]);
		expect(screen.getByText("Dana Drift")).toBeTruthy();
		expect(screen.queryByText("Reg Regular")).toBeNull();
		expect(stoppedAttendingCount()).toBe("1");
	});

	it("shows the streak, the date last seen and the rate together", async () => {
		// A rate of 2/6 rather than a terminating one: the window holds at most 8
		// meetings, so thirds and sixths are ordinary, and without the rounding
		// the row reads "33.33333333333333% attended".
		await renderRoute([
			lapseRow({ streak: 4, presentCount: 2, eligibleCount: 6, rate: 2 / 6 }),
		]);
		expect(screen.getByText("4 missed")).toBeTruthy();
		expect(screen.getByText(/^last seen .+ · 33% attended$/)).toBeTruthy();
	});

	it("appends NO rate when nothing in the window was eligible", async () => {
		// rate null ⇒ no eligible meeting (joined after the window, or every
		// meeting excused). Asserted as the WHOLE line, not a substring: JS makes
		// `null * 100` zero rather than NaN, so dropping the null guard prints a
		// confident "0% attended" for a member nobody could have marked, and a
		// substring match on "never recorded present" still passes.
		await renderRoute([
			lapseRow({ lastSeenAt: null, rate: null, eligibleCount: 0, streak: 3 }),
		]);
		expect(screen.getByText("never recorded present")).toBeTruthy();
		expect(screen.queryByText(/attended/)).toBeNull();
		expect(screen.queryByText(/NaN/)).toBeNull();
	});

	it("shows a 0% rate for a member with eligible meetings but no presence", async () => {
		await renderRoute([
			lapseRow({
				lastSeenAt: null,
				rate: 0,
				presentCount: 0,
				eligibleCount: 8,
				streak: 8,
			}),
		]);
		expect(
			screen.getByText("never recorded present · 0% attended"),
		).toBeTruthy();
	});

	it("links each lapsed member to their profile", async () => {
		await renderRoute([lapseRow({ memberId: "abc", name: "Dana Drift" })]);
		const link = screen.getByText("Dana Drift").closest("a");
		expect(link?.getAttribute("href")).toBe("/members/abc");
	});
});

function proximityRow(
	over: Partial<LevelProximityRow> = {},
): LevelProximityRow {
	return {
		memberId: "33333333-3333-4333-8333-333333333333",
		name: "Maya Chen",
		pathName: "Presentation Mastery",
		level: 2,
		kind: "close",
		projectsLeft: 1,
		projectNames: ["Inspire Your Audience"],
		electivesToChoose: 0,
		email: "maya@example.com",
		phone: "+15551234567",
		preferredName: null,
		...over,
	};
}

describe("VPE dashboard — Close to a level (#898)", () => {
	it("shows the empty state when nobody is close", async () => {
		await renderRoute([], { proximity: [] });
		expect(screen.getByText("Close to a level")).toBeTruthy();
		expect(
			screen.getByText("Nobody is within two projects of a level yet."),
		).toBeTruthy();
	});

	it("renders an awaiting-approval row", async () => {
		await renderRoute([], {
			proximity: [
				proximityRow({
					kind: "awaiting_approval",
					projectsLeft: 0,
					projectNames: [],
				}),
			],
		});
		expect(
			screen.getByText(
				"Presentation Mastery · Level 2 · All projects done, approve in Base Camp",
			),
		).toBeTruthy();
	});

	it("renders each close-row copy case", async () => {
		await renderRoute([], {
			proximity: [
				proximityRow({ memberId: "a", name: "A One" }),
				proximityRow({
					memberId: "b",
					name: "B Two",
					projectsLeft: 2,
					projectNames: ["Inspire Your Audience", "Active Listening"],
				}),
				proximityRow({
					memberId: "c",
					name: "C Elective",
					projectsLeft: 2,
					electivesToChoose: 1,
				}),
				proximityRow({
					memberId: "d",
					name: "D Choose",
					projectsLeft: 2,
					projectNames: [],
					electivesToChoose: 2,
				}),
				proximityRow({
					memberId: "e",
					name: "E Unknown",
					projectsLeft: 2,
					projectNames: [],
				}),
			],
		});
		for (const line of [
			"Presentation Mastery · Level 2 · 1 left: Inspire Your Audience",
			"Presentation Mastery · Level 2 · 2 left: Inspire Your Audience, Active Listening",
			"Presentation Mastery · Level 2 · 2 left: Inspire Your Audience and 1 elective",
			"Presentation Mastery · Level 2 · 2 left: choose 2 electives",
			"Presentation Mastery · Level 2 · 2 left",
		]) {
			expect(screen.getByText(line)).toBeTruthy();
		}
		// PROJECTS, never speeches.
		expect(screen.queryByText(/speech/i)).toBeNull();
	});

	it("shows Speaking when a speaker slot is booked, and Not scheduled otherwise", async () => {
		await renderRoute([], {
			timezone: "America/Chicago",
			proximity: [
				proximityRow({
					memberId: "s",
					name: "Sam Speaking",
					upcomingSpeakerAt: new Date("2026-10-09T23:00:00Z"),
				}),
				proximityRow({ memberId: "n", name: "Nia Nobody" }),
			],
		});
		expect(screen.getByText("Speaking · Fri, Oct 9")).toBeTruthy();
		expect(screen.getByText("Speaking Oct 9")).toBeTruthy();
		expect(screen.getAllByText("Not scheduled")).toHaveLength(1);
	});

	it("links only the avatar and name, not the whole row", async () => {
		// The nudge follow-up puts buttons in the right-hand cell; they cannot
		// live inside an anchor.
		await renderRoute([], {
			proximity: [proximityRow({ memberId: "abc", name: "Maya Chen" })],
		});
		const link = screen.getByText("Maya Chen").closest("a");
		expect(link?.getAttribute("href")).toBe("/members/abc");
		expect(link?.textContent).not.toContain("Not scheduled");
		expect(link?.textContent).not.toContain("left");
	});

	// A booking at 23:30 on Oct 9 in Los Angeles is Oct 10 in UTC, where CI
	// runs; one at 00:30 on Oct 10 in Tokyo is Oct 9 in UTC and in LA. Between
	// them no single runtime zone renders both correctly without the club's.
	it.each([
		["America/Los_Angeles", "2026-10-10T06:30:00Z", "Fri, Oct 9", "Oct 9"],
		["Asia/Tokyo", "2026-10-09T15:30:00Z", "Sat, Oct 10", "Oct 10"],
	])("renders Speaking and Booked in the club's day (%s)", async (timezone, iso, pillDay, lineDay) => {
		const at = new Date(iso);
		await renderRoute([], {
			timezone,
			proximity: [proximityRow({ upcomingSpeakerAt: at })],
			overdue: [
				{
					memberId: "44444444-4444-4444-8444-444444444444",
					name: "Olu Overdue",
					clubRole: "member",
					joinedAt: null,
					lastAnyRoleAt: null,
					daysSinceLastRole: null,
					isOverdue: true,
					upcomingRoleAt: at,
				},
			],
		});
		expect(screen.getByText(`Speaking · ${pillDay}`)).toBeTruthy();
		expect(screen.getByText(`Speaking ${lineDay}`)).toBeTruthy();
		expect(screen.getByText(`Booked · ${pillDay}`)).toBeTruthy();
		expect(screen.getByText(`Booked ${lineDay}`)).toBeTruthy();
	});
});

describe("VPE dashboard — level nudge on Close to a level rows (#900)", () => {
	const next: LevelNudgeMeeting = {
		id: "55555555-5555-4555-8555-555555555555",
		urlKey: "2026-10-13",
		scheduledAt: new Date("2026-10-14T00:30:00Z"),
		location: "Room 4",
	};

	it("offers the draft on a close row with contact, no speaker slot and a next meeting", async () => {
		await renderRoute([], {
			timezone: "America/Chicago",
			nextMeeting: next,
			proximity: [proximityRow({ preferredName: "Mimi" })],
		});
		const wa = await screen.findByLabelText(
			"Message Maya Chen on WhatsApp, opens in a new tab",
		);
		const mail = screen.getByLabelText("Email Maya Chen");
		const body = decodeURIComponent(mail.getAttribute("href") ?? "");
		// The club's day, the preferred name, and the next meeting's public page.
		expect(body).toContain(
			"Hi Mimi, you're 1 project from finishing Presentation Mastery Level 2: Inspire Your Audience. Want to get it on the agenda for Tue, Oct 13?",
		);
		expect(body).toContain(
			`${window.location.origin}/club/downtown/meeting/2026-10-13`,
		);
		expect(body).toContain("subject=1 project to Level 2");
		expect(wa.getAttribute("href")).toContain("15551234567");
	});

	// The two no-contact rows are qualifying close rows otherwise (a next
	// meeting, no speaker slot). They pin that `showsLevelNudge` requires
	// `hasNudgeContact`, which the route's origin gating relies on: without it
	// `NudgeButtons` would render "No contact on file" here.
	it.each([
		["no phone or email", { phone: null, email: null }, next],
		["a blank email and no phone", { phone: null, email: "   " }, next],
		[
			"a speaker slot already booked",
			{ upcomingSpeakerAt: new Date("2026-10-14T00:30:00Z") },
			next,
		],
		["no next meeting", {}, null],
	] as const)("renders no control with %s", async (_label, over, meeting) => {
		await renderRoute([], {
			nextMeeting: meeting,
			proximity: [proximityRow(over)],
		});
		// Mounted and settled: the row itself is there.
		expect(screen.getByText("Maya Chen")).toBeTruthy();
		await waitFor(() => {
			expect(screen.queryByLabelText(/on WhatsApp/)).toBeNull();
			expect(screen.queryByLabelText(/^Email /)).toBeNull();
			// No control, not a disabled one or a "no contact" placeholder.
			expect(screen.queryByText("No contact on file")).toBeNull();
		});
	});

	it("never renders on an awaiting-approval row, whose action is in Base Camp", async () => {
		await renderRoute([], {
			nextMeeting: next,
			proximity: [
				proximityRow({
					kind: "awaiting_approval",
					projectsLeft: 0,
					projectNames: [],
				}),
			],
		});
		expect(
			screen.getByText(
				"Presentation Mastery · Level 2 · All projects done, approve in Base Camp",
			),
		).toBeTruthy();
		await waitFor(() => {
			expect(screen.queryByLabelText(/on WhatsApp/)).toBeNull();
			expect(screen.queryByLabelText(/^Email /)).toBeNull();
		});
	});

	it("opens the draft without navigating to the member's profile", async () => {
		const router = await renderRoute([], {
			nextMeeting: next,
			proximity: [proximityRow({ memberId: "abc" })],
		});
		const mail = await screen.findByLabelText("Email Maya Chen");
		// Not nested in the member-page link.
		expect(mail.closest('a[href^="/members"]')).toBeNull();
		expect(screen.getByText("Maya Chen").closest("a")?.contains(mail)).toBe(
			false,
		);
		// jsdom cannot follow a `mailto:`; stop the default AFTER React's
		// handlers (they run at the root, below `document`), so a router
		// `<Link>` wrapping the button would still get to navigate.
		const stop = (e: Event) => e.preventDefault();
		document.addEventListener("click", stop);
		try {
			fireEvent.click(mail);
		} finally {
			document.removeEventListener("click", stop);
		}
		await waitFor(() => expect(router.state.status).toBe("idle"));
		expect(router.state.location.pathname).toBe("/");
	});
});
