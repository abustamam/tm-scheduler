// @vitest-environment jsdom
//
// The "Not on standard meetings" section on /admin/roles (#802).
//
// #801 landed the same fact as an inline badge on every non-standing card,
// deliberately, so nothing was invisible while this issue was pending. Two
// things a badge cannot do are what this file holds. It cannot GROUP — the club
// sees one flat list in which a contest's Chief Judge sits between two roles it
// runs every week — and it cannot say whether a role off the standard shape is
// off it and unused or off it and carrying three nights' agendas, which is the
// only question an officer looking at one is actually asking.
//
// Same harness as `club-settings.test.tsx`: mock every server-fn module (they
// reach `#/db` → `pg`, which must not load under jsdom), stub the route's
// `useRouteContext` / `useLoaderData`, and render the component directly rather
// than running the real loader.
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
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/role-definitions", () => ({
	createClubRole: vi.fn(),
	deleteClubRole: vi.fn(),
	listClubRoles: vi.fn(),
	reorderClubRoles: vi.fn().mockResolvedValue(undefined),
	setClubRoleEnabled: vi.fn(),
	syncTemplateToUpcomingMeetings: vi.fn(),
	updateClubRole: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { reorderClubRoles } from "#/server/role-definitions";
import type { RoleDefinitionRow } from "#/server/role-definitions-logic";
import { Route } from "./roles";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const ADMIN_CLUB = {
	clubId: "11111111-1111-4111-8111-111111111111",
	name: "Downtown Club",
	clubNumber: "123456",
	clubRole: "admin" as const,
};

function role(over: Partial<RoleDefinitionRow> & { id: string; name: string }) {
	return {
		category: "functionary" as const,
		defaultCount: 1,
		sortOrder: 0,
		isSpeakerRole: false,
		description: null,
		enabled: true,
		standing: true,
		slotCount: 0,
		agendaCount: 0,
		...over,
	};
}

async function renderRoles(roles: RoleDefinitionRow[]) {
	vi.spyOn(Route, "useRouteContext").mockReturnValue({
		adminClub: ADMIN_CLUB,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	vi.spyOn(Route, "useLoaderData").mockReturnValue({ roles } as any);

	const Component = Route.options.component as () => React.ReactElement;
	const rootRoute = createRootRoute({ component: () => <Component /> });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

/** A role's card, found by the name input that carries its id. */
function card(roleId: string): HTMLElement {
	const input = document.getElementById(`name-${roleId}`);
	const form = input?.closest("form");
	if (!form) throw new Error(`no card for ${roleId}`);
	return form as HTMLElement;
}

const TIMER = role({ id: "r-timer", name: "Timer", sortOrder: 0 });
const SPEAKER = role({
	id: "r-speaker",
	name: "Speaker",
	category: "speaker",
	isSpeakerRole: true,
	sortOrder: 1,
});
const JUDGE = role({
	id: "r-judge",
	name: "Chief Judge",
	sortOrder: 2,
	standing: false,
});

describe("/admin/roles non-standing section", () => {
	it("gives the non-standing roles their own section, with the standing ones above", async () => {
		await renderRoles([TIMER, JUDGE, SPEAKER]);

		const heading = screen.getByRole("heading", {
			name: "Not on standard meetings",
		});
		const section = heading.closest("section");
		if (!section) throw new Error("heading is not inside a section");

		// The contest role is under the heading…
		expect(within(section).getByDisplayValue("Chief Judge")).toBeTruthy();
		// …and the two the club runs every week are not.
		expect(within(section).queryByDisplayValue("Timer")).toBeNull();
		expect(within(section).queryByDisplayValue("Speaker")).toBeNull();
	});

	it("says nothing about a standard shape the club has no exceptions to", async () => {
		await renderRoles([TIMER, SPEAKER]);

		expect(
			screen.queryByRole("heading", { name: "Not on standard meetings" }),
		).toBeNull();
		expect(screen.getByDisplayValue("Timer")).toBeTruthy();
	});

	// The half the badge could not carry. Two non-standing roles, identical
	// except for how many of the club's agendas actually list them — which is
	// the difference between a role to delete and a role in use.
	it("says how many agendas declare each role", async () => {
		await renderRoles([
			TIMER,
			role({ id: "r-judge", name: "Chief Judge", standing: false }),
			role({
				id: "r-zoom",
				name: "Zoom Host",
				standing: false,
				agendaCount: 3,
			}),
		]);

		expect(
			within(card("r-judge")).getByText(
				"No meeting agenda lists this role right now.",
			),
		).toBeTruthy();
		expect(
			within(card("r-zoom")).getByText("Listed on 3 meeting agendas."),
		).toBeTruthy();
	});

	it("says it in the singular for exactly one", async () => {
		await renderRoles([
			role({
				id: "r-zoom",
				name: "Zoom Host",
				standing: false,
				agendaCount: 1,
			}),
		]);

		expect(
			within(card("r-zoom")).getByText("Listed on 1 meeting agenda."),
		).toBeTruthy();
	});

	// `agendaCount` is opt-in (`listRoleDefinitions`' `withAgendaCounts`), for
	// the same reason `slotCount` is: these rows are also served with no session
	// and to a route the router preloads on hover. A caller that did not ask
	// gets `undefined`, and `undefined` must read as "not asked", never as zero
	// — "No meeting agenda lists this role" would be a claim nobody made.
	it("stays silent when the count was not asked for, rather than claiming zero", async () => {
		await renderRoles([
			role({
				id: "r-zoom",
				name: "Zoom Host",
				standing: false,
				agendaCount: undefined,
			}),
		]);

		expect(within(card("r-zoom")).queryByText(/meeting agenda/i)).toBeNull();
	});

	// The reorder controls send `orderedIds` for the WHOLE bank — one
	// `sort_order` sequence shared by both sections — so a role's visual
	// neighbour is its neighbour within its SECTION, which need not be adjacent
	// in the underlying array. Reordering by the split index instead would write
	// the club's roles back in an order nobody asked for.
	it("moves a role past its neighbour IN ITS SECTION, not past the array's", async () => {
		// Standing, non-standing, standing — so the second standing role's
		// visual neighbour is two places away in `roles`.
		const A = role({ id: "r-a", name: "Ay", sortOrder: 0 });
		const GAP = role({
			id: "r-gap",
			name: "Gap",
			sortOrder: 1,
			standing: false,
		});
		const B = role({ id: "r-b", name: "Bee", sortOrder: 2 });
		await renderRoles([A, GAP, B]);

		await userEvent.click(
			within(card("r-b")).getByRole("button", { name: "Move up" }),
		);

		expect(reorderClubRoles).toHaveBeenCalledWith({
			data: {
				clubId: ADMIN_CLUB.clubId,
				// Ay and Bee swapped; Gap kept its place.
				orderedIds: ["r-b", "r-gap", "r-a"],
			},
		});
	});

	it("disables the arrows at each SECTION's ends, not only the whole list's", async () => {
		await renderRoles([TIMER, SPEAKER, JUDGE]);

		const up = (id: string) =>
			within(card(id)).getByRole("button", {
				name: "Move up",
			}) as HTMLButtonElement;
		const down = (id: string) =>
			within(card(id)).getByRole("button", {
				name: "Move down",
			}) as HTMLButtonElement;

		expect(up("r-timer").disabled).toBe(true);
		// Last of the STANDING section, though not last overall.
		expect(down("r-speaker").disabled).toBe(true);
		// First of its own section, though not first overall.
		expect(up("r-judge").disabled).toBe(true);
		expect(down("r-judge").disabled).toBe(true);
	});
});
