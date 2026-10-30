// @vitest-environment jsdom
//
// protects: /schedule, /roster and /club/<slug> each name a skeleton as their
//   pendingComponent with pendingMs 150 (#1424), and the skeleton's cells take
//   their height from grid-cell's CELL_BASE, not a hand-typed copy.
// fails_when: a route loses pendingComponent/pendingMs (default is 1000ms, so
//   a phone sees nothing), or CELL_BASE's heights change and the skeleton drifts.
// no_claim: the router actually switching to the pending state (TanStack's
//   job); pixel layout shift; SSR (test:hydration covers first paint).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CELL_BASE } from "#/components/club/grid-cell";
import { RosterSkeleton } from "#/components/members/roster-skeleton";

vi.mock("#/db", () => ({ db: {} }));

import {
	ClubHomeSkeleton,
	ScheduleSkeleton,
} from "#/components/club/season-grid-skeleton";

afterEach(cleanup);

type PendingOpts = { pendingMs?: number; pendingComponent?: unknown };
async function routeOptions(path: string): Promise<PendingOpts> {
	const mod = (await import(/* @vite-ignore */ path)) as {
		Route: { options: PendingOpts };
	};
	return mod.Route.options;
}

describe("route pending skeletons", () => {
	it("/schedule", async () => {
		const o = await routeOptions("#/routes/_authed/schedule");
		expect(o.pendingMs).toBe(150);
		expect(o.pendingComponent).toBe(ScheduleSkeleton);
	});
	it("/roster", async () => {
		const o = await routeOptions("#/routes/_authed/roster");
		expect(o.pendingMs).toBe(150);
		expect(o.pendingComponent).toBe(RosterSkeleton);
	});
	it("/club/<slug>", async () => {
		const o = await routeOptions("#/routes/club.$clubId.index");
		expect(o.pendingMs).toBe(150);
		expect(o.pendingComponent).toBe(ClubHomeSkeleton);
	});
});

describe("skeleton rendering", () => {
	it("the grid skeleton has 8 rows of 4 cells (2 hidden below md) using CELL_BASE", () => {
		render(<ScheduleSkeleton />);
		const cells = screen.getAllByTestId("season-grid-skeleton-cell");
		expect(cells).toHaveLength(32);
		for (const c of cells) {
			for (const cls of CELL_BASE.split(" ").filter((k) => /(^|:)h-/.test(k)))
				expect(c.className).toContain(cls);
		}
		expect(
			cells.filter((c) => c.parentElement?.className.includes("hidden")),
		).toHaveLength(16);
	});
	it("the club-home skeleton carries the grid", () => {
		render(<ClubHomeSkeleton />);
		expect(screen.getByTestId("season-grid-skeleton")).toBeTruthy();
	});
	it("the roster skeleton has 8 rows", () => {
		render(<RosterSkeleton />);
		expect(screen.getAllByTestId("roster-skeleton-row")).toHaveLength(8);
	});
});
