// @vitest-environment jsdom
//
// Component tests for the "Up next" marker on the VPE dashboard (#543).
//
// The server suite proves `upcomingRoleAt` is DERIVED correctly. It cannot see
// whether the dashboard renders it, and the bug being fixed is a rendering
// contradiction: Monday's Toastmaster reading "Never held a role" on the
// officer's own page while the club's sign-up sheet has her name on it. So the
// half that matters here is that the marker appears BESIDE the backward-looking
// text rather than replacing it — a fix that quietly rewrote "Never held a
// role" or dropped the member from the overdue count would satisfy every
// assertion in the server suite and be the wrong change (#543 explicitly
// rejected that option).
//
// Pattern follows vpe-dashboard.test.tsx: mock the server-fn module (it reaches
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
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttendanceLapseRow } from "#/lib/attendance-lapse";
import { formatMeetingDate } from "#/lib/format";
import type {
	OverdueMemberRow,
	SpeakerRotationRow,
} from "#/server/reporting-logic";

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

// Noon UTC so the local calendar day is the same in every timezone a runner
// might use — a midnight fixture slips a day west of UTC and the weekday in
// the rendered pill changes with it.
const MONDAY = new Date("2026-08-10T12:00:00Z");
const LATER = new Date("2026-08-24T12:00:00Z");

function overdueRow(over: Partial<OverdueMemberRow> = {}): OverdueMemberRow {
	return {
		memberId: "m-1",
		name: "Dana Lee",
		clubRole: "member",
		joinedAt: new Date("2024-01-15T00:00:00Z"),
		lastAnyRoleAt: null,
		daysSinceLastRole: null,
		isOverdue: true,
		...over,
	};
}

function rotationRow(
	over: Partial<SpeakerRotationRow> = {},
): SpeakerRotationRow {
	return {
		memberId: "s-1",
		name: "Priya Raman",
		clubRole: "member",
		timesSpoken: 0,
		lastSpokenAt: null,
		joinedAt: new Date("2024-01-15T00:00:00Z"),
		latestPathwayPath: null,
		latestProjectName: null,
		latestProjectLevel: null,
		...over,
	};
}

function lapseRow(over: Partial<AttendanceLapseRow> = {}): AttendanceLapseRow {
	return {
		memberId: "l-1",
		name: "Casey Kim",
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

async function renderRoute(data: {
	rotation?: SpeakerRotationRow[];
	overdue?: OverdueMemberRow[];
	lapse?: AttendanceLapseRow[];
}) {
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		rotation: data.rotation ?? [],
		overdue: data.overdue ?? [],
		lapse: data.lapse ?? [],
		clubName: "Harbor City Speakers",
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

/** The row (the whole `<a>`) a named member is rendered in. */
function rowFor(name: string): HTMLElement {
	const link = screen.getByText(name).closest("a");
	if (!link) throw new Error(`no row rendered for ${name}`);
	return link;
}

/** The "Overdue members" stat tile's number. */
function overdueCount() {
	const label = screen.getByText("Overdue members", { selector: "div" });
	return label.parentElement?.querySelector("span")?.textContent;
}

describe("VPE dashboard — upcoming-claim marker (#543)", () => {
	it("marks an overdue member who is already booked, WITHOUT softening the wait", async () => {
		await renderRoute({
			overdue: [overdueRow({ upcomingRoleAt: MONDAY })],
		});

		const row = rowFor("Dana Lee");
		expect(
			within(row).getByText(`Up next · ${formatMeetingDate(MONDAY)}`),
		).toBeTruthy();
		// The backward-looking half is untouched — this member really has never
		// held a role, and the officer still needs to see that.
		expect(within(row).getByText("Never held a role")).toBeTruthy();
		expect(within(row).getByText("no role history")).toBeTruthy();
	});

	it("reads the date off the row rather than printing a fixed one", async () => {
		// Two members booked at different meetings. Without this a hardcoded
		// string in the pill would satisfy the assertion above.
		await renderRoute({
			overdue: [
				overdueRow({
					memberId: "a",
					name: "Soon Member",
					upcomingRoleAt: MONDAY,
				}),
				overdueRow({
					memberId: "b",
					name: "Later Member",
					upcomingRoleAt: LATER,
				}),
			],
		});

		expect(
			within(rowFor("Soon Member")).getByText(
				`Up next · ${formatMeetingDate(MONDAY)}`,
			),
		).toBeTruthy();
		expect(
			within(rowFor("Later Member")).getByText(
				`Up next · ${formatMeetingDate(LATER)}`,
			),
		).toBeTruthy();
	});

	it("still counts a booked member in the OVERDUE MEMBERS tile", async () => {
		// #543 weighed excluding them and said no: the count is about
		// participation history, and a claim is not participation until it
		// happens. A pill that silently decremented this tile would be the other
		// option shipped by accident.
		await renderRoute({
			overdue: [
				overdueRow({
					memberId: "a",
					name: "Booked One",
					upcomingRoleAt: MONDAY,
				}),
				overdueRow({ memberId: "b", name: "Unbooked One" }),
			],
		});

		expect(overdueCount()).toBe("2");
		expect(screen.getByText("Booked One")).toBeTruthy();
	});

	it("shows no marker for a member with no upcoming claim", async () => {
		await renderRoute({ overdue: [overdueRow()] });
		expect(screen.queryByText(/Up next/)).toBeNull();
	});

	it("marks a never-spoken member in the speaker queue, keeping the rank text", async () => {
		await renderRoute({
			rotation: [rotationRow({ upcomingRoleAt: MONDAY })],
		});

		const row = rowFor("Priya Raman");
		expect(
			within(row).getByText(`Up next · ${formatMeetingDate(MONDAY)}`),
		).toBeTruthy();
		// The queue ranks by DELIVERED speeches, so this stays true until Monday.
		expect(within(row).getByText("Never spoken")).toBeTruthy();
	});

	it("leaves the Stopped attending rows unmarked", async () => {
		// LapseRow shares `MemberIdentity` with the two lists above but has no
		// upcoming-claim data of its own, and #543 scoped the marker to the other
		// two sections. A default that leaked through the shared component would
		// show up here.
		await renderRoute({ lapse: [lapseRow()] });
		expect(screen.getByText("Casey Kim")).toBeTruthy();
		expect(screen.queryByText(/Up next/)).toBeNull();
	});
});
