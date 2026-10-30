// @vitest-environment jsdom
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	HeadContent,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The roster module reaches `#/db`, which throws without DATABASE_URL at import.
vi.mock("#/db", () => ({ db: {} }));

import { Route as RosterRoute } from "./_authed/roster";

afterEach(cleanup);

describe("a signed-in page's tab title", () => {
	// protects=client-side navigation to /roster sets document.title to "Roster · <active club>" (#1422 criterion 1), through the REAL roster route's head
	// fails_when=the roster head is removed, reads another label, or names a club other than the active one
	// no_claim=does not render the roster page, run _authed's real beforeLoad, or prove the other 38 routes' heads (the guard test checks those lexically)
	it("reads `Roster · <club>` after navigating to /roster", async () => {
		const root = createRootRoute({
			// Stands in for `_authed`'s beforeLoad: the same two context keys.
			beforeLoad: () => ({
				clubs: [
					{ clubId: "club-a", name: "Evening Orators" },
					{ clubId: "club-b", name: "Sunrise Speakers" },
				],
				activeClubId: "club-b",
			}),
			component: () => (
				<>
					<HeadContent />
					<Outlet />
				</>
			),
		});
		const home = createRoute({
			getParentRoute: () => root,
			path: "/",
			component: () => <p>home</p>,
		});
		const roster = createRoute({
			getParentRoute: () => root,
			path: "/roster",
			head: RosterRoute.options.head as never,
			component: () => <p>roster</p>,
		});
		const router = createRouter({
			routeTree: root.addChildren([home, roster]),
			history: createMemoryHistory({ initialEntries: ["/"] }),
		});
		render(<RouterProvider router={router} />);
		await waitFor(() => expect(router.state.status).toBe("idle"));

		await router.navigate({ to: "/roster" });

		await waitFor(() =>
			expect(document.title).toBe("Roster · Sunrise Speakers"),
		);
	});
});
