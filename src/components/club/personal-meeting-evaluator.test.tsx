// @vitest-environment jsdom
//
// The personal page's "Before the meeting" list for an Evaluator (#1163): print
// rows for a paired evaluator in place of the confirm prompt.
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/availability", () => ({
	markUnavailableReleasing: vi.fn(async () => ({ ok: true, released: 1 })),
}));
vi.mock("#/server/attendance-plan", () => ({
	setPlannedAttendance: vi.fn(async () => ({ ok: true, confirmedRoles: [] })),
}));
vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const { PersonalMeetingBody } = await import("./personal-meeting-body");
type PersonalMeetingView =
	import("#/server/personal-meeting").PersonalMeetingView;

afterEach(cleanup);

function viewWith(
	evaluates: NonNullable<PersonalMeetingView["roles"][number]>["evaluates"],
): PersonalMeetingView {
	return {
		club: {
			id: "11111111-1111-4111-8111-111111111111",
			name: "Harbor City Speakers",
			timezone: "America/Chicago",
		},
		meeting: {
			id: "22222222-2222-4222-8222-222222222222",
			scheduledAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
			theme: null,
			wordOfTheDay: null,
			tableTopicsNotes: null,
			status: "scheduled",
			hasTiming: false,
		},
		member: { id: "33333333-3333-4333-8333-333333333333", name: "Marcus Lee" },
		roles: [
			{
				slotId: "44444444-4444-4444-8444-444444444444",
				roleName: "Evaluator",
				roleKey: "evaluator",
				speechTitle: null,
				status: "claimed",
				evaluates,
			},
		],
		planStatus: null,
	};
}

/** Mounts anything that contains a router `<Link>`; `/club/$clubId/meeting/…`
 *  is registered so the duty rows and the forward link resolve real hrefs. */
async function renderInRouter(node: ReactNode) {
	const rootRoute = createRootRoute({ component: () => <>{node}</> });
	rootRoute.addChildren([
		createRoute({
			getParentRoute: () => rootRoute,
			path: "/club/$clubId/meeting/$meetingId",
			component: () => null,
		}),
	]);
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

async function renderBody(view: PersonalMeetingView) {
	await renderInRouter(
		<PersonalMeetingBody
			view={view}
			clubId="harbor-city"
			meetingId="2026-09-05"
			onChanged={vi.fn(async () => {})}
			onNotYou={vi.fn()}
			canRepick
			roleGuides={[]}
		/>,
	);
}

const ICE_BREAKER_URL =
	"https://ccdn.toastmasters.org/medias/files/department-documents/education-documents/evaluation-resources/english/8101e-evaluation-resource.pdf";

describe("personal page: Evaluator print rows (#1163)", () => {
	it("a paired evaluator gets a print link per resource and no confirm prompt", async () => {
		await renderBody(
			viewWith({
				speakerName: "Priyanka Rao",
				speakerPreferredName: "Priya",
				projectName: "Evaluation and Feedback",
			}),
		);
		const links = screen.getAllByRole("link", { name: /^Print Priya's/ });
		// The project has three forms (evaluator role, first speech, second speech).
		expect(links).toHaveLength(3);
		expect(links[0]?.textContent).toBe(
			"Print Priya's evaluation form (Evaluator role)",
		);
		for (const a of links) {
			expect(a.getAttribute("target")).toBe("_blank");
			expect(a.getAttribute("rel")).toBe("noopener noreferrer");
			expect(a.getAttribute("href")).toMatch(/^https:\/\/.*toastmasters\.org/);
		}
		expect(screen.queryByText(/Confirm the role/)).toBeNull();
		expect(screen.queryByRole("checkbox")).toBeNull();
	});

	it("a single-form project's row has no part suffix and links the form", async () => {
		await renderBody(
			viewWith({
				speakerName: "Priyanka Rao",
				speakerPreferredName: null,
				projectName: "Ice Breaker",
			}),
		);
		const link = screen.getByRole("link", {
			name: "Print Priyanka's evaluation form",
		});
		expect(link.getAttribute("href")).toBe(ICE_BREAKER_URL);
	});

	it("an unknown project asks the member to check with the speaker", async () => {
		await renderBody(
			viewWith({
				speakerName: "Priyanka Rao",
				speakerPreferredName: null,
				projectName: "TBA",
			}),
		);
		expect(
			screen.getByRole("link", {
				name: "Print an evaluation form (ask Priyanka which project they're doing)",
			}),
		).toBeTruthy();
	});

	it.each([
		["unpaired", null],
		[
			"paired to an unassigned slot",
			{ speakerName: null, speakerPreferredName: null, projectName: null },
		],
	])("an evaluator %s keeps the confirm prompt", async (_label, evaluates) => {
		await renderBody(viewWith(evaluates));
		expect(screen.getByText(/Confirm the role/)).toBeTruthy();
		expect(screen.queryByText(/evaluation form/)).toBeNull();
	});
});
