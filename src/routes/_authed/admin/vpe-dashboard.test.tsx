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
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttendanceLapseRow } from "#/lib/attendance-lapse";

vi.mock("#/server/reporting", () => ({
	getSpeakerRotation: vi.fn(),
	getOverdueMembers: vi.fn(),
	getAttendanceLapse: vi.fn(),
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

async function renderRoute(lapse: AttendanceLapseRow[]) {
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		rotation: [],
		overdue: [],
		lapse,
		clubName: "Downtown Club",
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

	it("shows the streak and the date last seen", async () => {
		await renderRoute([lapseRow({ streak: 4 })]);
		expect(screen.getByText("4 missed")).toBeTruthy();
		expect(screen.getByText(/^last seen /)).toBeTruthy();
	});

	it("says 'never recorded' when nothing in the window was eligible", async () => {
		// rate null ⇒ no eligible meeting (joined after the window, or every
		// meeting excused). Must not render "NaN%".
		await renderRoute([
			lapseRow({ lastSeenAt: null, rate: null, eligibleCount: 0, streak: 3 }),
		]);
		expect(screen.getByText("never recorded")).toBeTruthy();
		expect(screen.queryByText(/NaN/)).toBeNull();
	});

	it("shows an attendance rate for a member never once recorded present", async () => {
		await renderRoute([
			lapseRow({
				lastSeenAt: null,
				rate: 0,
				presentCount: 0,
				eligibleCount: 8,
				streak: 8,
			}),
		]);
		expect(screen.getByText("0% attendance")).toBeTruthy();
	});

	it("links each lapsed member to their profile", async () => {
		await renderRoute([lapseRow({ memberId: "abc", name: "Dana Drift" })]);
		const link = screen.getByText("Dana Drift").closest("a");
		expect(link?.getAttribute("href")).toBe("/members/abc");
	});
});
