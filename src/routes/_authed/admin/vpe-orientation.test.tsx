// @vitest-environment jsdom
//
// Component tests for the "New members in orientation" section of
// vpe-dashboard.tsx (#942): placement above "Overdue for a role", the empty
// state, the day label and its highlight past 28 days, the ticks, the mentor
// line, and the nudge draft naming the member's next open item.
//
// Same pattern as vpe-dashboard.test.tsx: mock the server-fn module (it
// reaches `#/db` → `pg`, which must not load under jsdom), stub
// `Route.useLoaderData`, and render the component directly.
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LevelNudgeMeeting } from "#/lib/level-proximity";
import type { OrientationItemKey } from "#/lib/orientation";
import type { OrientationRosterRow } from "#/lib/orientation-roster";

vi.mock("#/server/reporting", () => ({
	getSpeakerRotation: vi.fn(),
	getOverdueMembers: vi.fn(),
	getAttendanceLapse: vi.fn(),
	getEvaluatorPairings: vi.fn(),
	getLevelProximity: vi.fn(),
	getOrientationRoster: vi.fn(),
}));

import { Route } from "./vpe-dashboard";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const KEYS: OrientationItemKey[] = [
	"choose-path",
	"ice-breaker",
	"supporting-role",
	"base-camp",
	"get-a-mentor",
];

function row(
	over: Partial<OrientationRosterRow> & { done?: OrientationItemKey[] } = {},
): OrientationRosterRow {
	const { done = [], ...rest } = over;
	return {
		memberId: "33333333-3333-4333-8333-333333333333",
		name: "Nia Newcomer",
		preferredName: null,
		email: "nia@example.com",
		phone: "+15551234567",
		startedAt: new Date("2026-09-20T00:00:00Z"),
		days: 10,
		items: KEYS.map((key) => ({ key, done: done.includes(key) })),
		mentorNames: [],
		...rest,
	};
}

const NEXT: LevelNudgeMeeting = {
	id: "55555555-5555-4555-8555-555555555555",
	urlKey: "2026-10-13",
	scheduledAt: new Date("2026-10-14T00:30:00Z"),
	location: "Room 4",
};

async function renderRoute(
	orientation: OrientationRosterRow[],
	nextMeeting: LevelNudgeMeeting | null = null,
) {
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		rotation: [],
		overdue: [],
		lapse: [],
		pairings: [],
		proximity: [],
		orientation,
		timezone: "America/Chicago",
		clubName: "Downtown Club",
		clubId: "11111111-1111-4111-8111-111111111111",
		clubSlug: "downtown",
		nextMeeting,
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
}

describe("VPE dashboard — New members in orientation (#942)", () => {
	it("sits directly above Overdue for a role", async () => {
		await renderRoute([]);
		const headings = screen
			.getAllByRole("heading", { level: 2 })
			.map((h) => h.textContent);
		const at = headings.indexOf("New members in orientation");
		expect(at).toBeGreaterThan(-1);
		expect(headings[at + 1]).toBe("Overdue for a role");
	});

	it("shows the empty state with nobody in orientation", async () => {
		await renderRoute([]);
		expect(
			screen.getByText("No new members in orientation right now."),
		).toBeTruthy();
	});

	it.each([
		[27, false],
		[28, false],
		[29, true],
	])("day %i highlighted: %s", async (days, stalled) => {
		await renderRoute([row({ days })]);
		const day = screen.getByText(`Day ${days}`);
		expect(day.className.includes("warning")).toBe(stalled);
		expect(screen.queryByText("Over 28 days") !== null).toBe(stalled);
	});

	it("renders rows in the order the loader sends them", async () => {
		await renderRoute([
			row({ memberId: "a", name: "Old Timer", days: 40 }),
			row({ memberId: "b", name: "New Comer", days: 2 }),
		]);
		const names = screen
			.getAllByTestId("orientation-row")
			.map((r) => r.querySelector("a")?.textContent);
		expect(names).toEqual(["OTOld Timer", "NCNew Comer"]);
	});

	it("links the name to the member page", async () => {
		await renderRoute([row()]);
		const link = screen.getByText("Nia Newcomer").closest("a");
		expect(link?.getAttribute("href")).toBe(
			"/members/33333333-3333-4333-8333-333333333333",
		);
	});

	it("ticks each item, saying done or to do in text", async () => {
		await renderRoute([row({ done: ["choose-path", "base-camp"] })]);
		const items = screen.getByTestId("orientation-row").querySelectorAll("li");
		expect([...items].map((li) => li.textContent)).toEqual([
			"path done",
			"Ice Breaker to do",
			"supporting role to do",
			"Base Camp done",
			"mentor to do",
		]);
	});

	it("names the mentor, or says there is none", async () => {
		await renderRoute([
			row({ memberId: "a", name: "Paired Pat", mentorNames: ["Mo Mentor"] }),
			row({ memberId: "b", name: "Lone Lee" }),
		]);
		expect(screen.getByText("Mentor: Mo Mentor")).toBeTruthy();
		expect(screen.getByText("No mentor")).toBeTruthy();
	});

	it("drafts a nudge about the next open item", async () => {
		await renderRoute([row({ done: ["choose-path"] })], NEXT);
		const mail = await screen.findByLabelText("Email Nia Newcomer");
		const body = decodeURIComponent(mail.getAttribute("href") ?? "");
		expect(body).toContain("subject=Your Ice Breaker");
		expect(body).toContain(
			`Hi Nia, would you like to schedule your Ice Breaker? Our next meeting is Tue, Oct 13, and you can sign up here: ${window.location.origin}/club/downtown/meeting/2026-10-13`,
		);
		expect(
			screen.getByLabelText(
				"Message Nia Newcomer on WhatsApp, opens in a new tab",
			),
		).toBeTruthy();
	});

	it.each<[string, OrientationItemKey[], string]>([
		[
			"choose-path",
			[],
			"Hi Nia, have you had a chance to pick your Pathways path yet? Here's a short guide to the paths:",
		],
		[
			"base-camp",
			["choose-path", "ice-breaker", "supporting-role"],
			"Hi Nia, have you had a chance to set up Base Camp yet? Here's how:",
		],
		[
			"get-a-mentor",
			["choose-path", "ice-breaker", "supporting-role", "base-camp"],
			"Hi Nia, would you like me to pair you with a mentor?",
		],
	])("with no next meeting, still drafts %s, naming no meeting", async (_k, done, text) => {
		await renderRoute([row({ done })], null);
		const mail = await screen.findByLabelText("Email Nia Newcomer");
		const body = decodeURIComponent(mail.getAttribute("href") ?? "");
		expect(body).toContain(text);
		expect(body).not.toMatch(/meeting/i);
	});

	it.each<[string, OrientationItemKey[]]>([
		["ice-breaker", ["choose-path"]],
		["supporting-role", ["choose-path", "ice-breaker"]],
	])("with no next meeting, offers no %s draft", async (_k, done) => {
		// A control row that DOES get a draft, so the absence below is read
		// after the post-mount pass that renders drafts, not before it.
		await renderRoute(
			[
				row({ done }),
				row({ memberId: "c", name: "Control Cal", email: "cal@example.com" }),
			],
			null,
		);
		await screen.findByLabelText("Email Control Cal");
		expect(screen.queryByLabelText("Email Nia Newcomer")).toBeNull();
		expect(
			screen.queryByLabelText(
				"Message Nia Newcomer on WhatsApp, opens in a new tab",
			),
		).toBeNull();
	});
});
