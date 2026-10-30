// @vitest-environment jsdom
//
// protects: /schedule, /roster and /club/<slug> each render their skeleton while
//   a loader is pending past 150ms and none before it (#1424 AC1, AC3); the
//   skeleton mirrors the real page's structure and takes its classes from the
//   shared route-layout constants, which this file pins to the real source.
// fails_when: a route loses pendingComponent/pendingMs (TanStack's default is
//   1000ms, so a phone sees nothing), CELL_BASE's heights change and the
//   skeleton drifts, or a layout class in season-grid.tsx / roster.tsx changes
//   without route-layout.ts following.
// no_claim: pixel layout shift; SSR first paint (test:hydration); that the
//   route's real loader is slow. The test router copies each real route's
//   pendingMs/pendingComponent onto a route with a controllable loader.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CELL_BASE } from "#/components/club/grid-cell";
import { RosterSkeleton } from "#/components/members/roster-skeleton";
import * as layout from "#/components/route-layout";
import { readSource } from "#/test/guard-source";

vi.mock("#/db", () => ({ db: {} }));

import {
	ClubHomeSkeleton,
	ScheduleSkeleton,
	SeasonGridSkeleton,
} from "#/components/club/season-grid-skeleton";

type PendingOpts = { pendingMs?: number; pendingComponent?: () => unknown };
async function routeOptions(path: string): Promise<PendingOpts> {
	const mod = (await import(/* @vite-ignore */ path)) as {
		Route: { options: PendingOpts };
	};
	return mod.Route.options;
}

const ROUTES = [
	{
		name: "/schedule",
		path: "#/routes/_authed/schedule",
		skeleton: ScheduleSkeleton,
		testid: "season-grid-skeleton",
	},
	{
		name: "/roster",
		path: "#/routes/_authed/roster",
		skeleton: RosterSkeleton,
		testid: "roster-skeleton",
	},
	{
		name: "/club/<slug>",
		path: "#/routes/club.$clubId.index",
		skeleton: ClubHomeSkeleton,
		testid: "season-grid-skeleton",
	},
] as const;

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

async function mountPending(o: PendingOpts) {
	let release: () => void = () => {};
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const root = createRootRoute({ component: Outlet });
	const home = createRoute({
		getParentRoute: () => root,
		path: "/",
		component: () => <p>home</p>,
	});
	const page = createRoute({
		getParentRoute: () => root,
		path: "/page",
		loader: () => gate,
		pendingMs: o.pendingMs,
		pendingComponent: o.pendingComponent as never,
		component: () => <p data-testid="real-page">real</p>,
	});
	const router = createRouter({
		routeTree: root.addChildren([home, page]),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	await act(async () => {
		render(<RouterProvider router={router} />);
		await vi.advanceTimersByTimeAsync(0);
	});
	const nav = router.navigate({ to: "/page" as never });
	return { router, release, nav };
}

describe.each(ROUTES)("$name pending skeleton", (r) => {
	it("names its skeleton with pendingMs 150", async () => {
		const o = await routeOptions(r.path);
		expect(o.pendingMs).toBe(150);
		expect(o.pendingComponent).toBe(r.skeleton);
	});

	it("renders the skeleton past 150ms and not before", async () => {
		const o = await routeOptions(r.path);
		const { release, nav } = await mountPending(o);
		await act(() => vi.advanceTimersByTimeAsync(100));
		expect(screen.queryByTestId(r.testid)).toBeNull();
		await act(() => vi.advanceTimersByTimeAsync(100));
		expect(screen.getByTestId(r.testid)).toBeTruthy();
		release();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
			await nav;
		});
		expect(screen.queryByTestId(r.testid)).toBeNull();
		expect(screen.getByTestId("real-page")).toBeTruthy();
	});

	it("shows no skeleton when the loader resolves under 150ms", async () => {
		const o = await routeOptions(r.path);
		const { release, nav } = await mountPending(o);
		await act(() => vi.advanceTimersByTimeAsync(50));
		release();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
			await nav;
		});
		expect(screen.queryByTestId(r.testid)).toBeNull();
		expect(screen.getByTestId("real-page")).toBeTruthy();
	});
});

const sourceOf = (rel: string) =>
	readSource(resolve(dirname(fileURLToPath(import.meta.url)), "..", rel));

describe("skeleton structure", () => {
	it("the grid skeleton mirrors the table: toggle row, date header, label column, CELL_BASE cells", () => {
		render(<SeasonGridSkeleton />);
		const toggle = screen.getByTestId("season-grid-skeleton-toggle");
		const table = document.querySelector("table");
		expect(table?.className).toBe(layout.SEASON_TABLE_CLASS);
		// the toggle row sits above the table
		expect(
			toggle.compareDocumentPosition(table as Node) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		const head = screen.getByTestId("season-grid-skeleton-head");
		expect(head.closest("thead")).toBeTruthy();
		const ths = head.querySelectorAll("th");
		expect(ths[0].className).toBe(layout.SEASON_LABEL_HEAD_CLASS);
		expect(ths[0].className).toContain("w-36");
		expect(ths[1].className).toBe(layout.SEASON_DATE_HEAD_CLASS);
		expect(ths[1].className).toContain("min-w-[3.5rem]");
		const rows = screen.getAllByTestId("season-grid-skeleton-row");
		expect(rows.length).toBeGreaterThan(0);
		const cells = screen.getAllByTestId("season-grid-skeleton-cell");
		expect(cells).toHaveLength(rows.length * (ths.length - 1));
		for (const c of cells)
			for (const cls of CELL_BASE.split(" ").filter((k) => /(^|:)h-/.test(k)))
				expect(c.className).toContain(cls);
	});

	it("the roster skeleton is one bordered table under stats and filters", () => {
		render(<RosterSkeleton />);
		const stats = screen.getByTestId("roster-skeleton-stats");
		const filters = screen.getByTestId("roster-skeleton-filters");
		const table = screen.getByTestId("roster-skeleton");
		expect(stats.className).toBe(layout.ROSTER_STATS_GRID_CLASS);
		expect(filters.className).toBe(layout.ROSTER_FILTER_ROW_CLASS);
		expect(table.className).toBe(layout.ROSTER_TABLE_CLASS);
		const head = screen.getByTestId("roster-skeleton-head");
		expect(table.contains(head)).toBe(true);
		expect(head.className).toContain(layout.ROSTER_TABLE_GRID);
		const rows = screen.getAllByTestId("roster-skeleton-row");
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(table.contains(row)).toBe(true);
			expect(row.className).toContain(layout.ROSTER_TABLE_GRID);
		}
		// no per-row cards
		expect(table.querySelectorAll(".rounded-xl.border")).toHaveLength(0);
	});
});

describe("route-layout classes match the real pages' source", () => {
	const grid = sourceOf("components/club/season-grid.tsx");
	const roster = sourceOf("routes/_authed/roster.tsx");
	const tokens = (s: string) => s.split(/\s+/).filter(Boolean);

	it("season-grid.tsx carries every class the skeleton copies", () => {
		for (const [name, value] of Object.entries(layout)) {
			if (!name.startsWith("SEASON_")) continue;
			for (const t of tokens(value)) expect(grid, `${name}: ${t}`).toContain(t);
		}
	});
	it("roster.tsx carries every class the skeleton copies", () => {
		for (const [name, value] of Object.entries(layout)) {
			if (!name.startsWith("ROSTER_") || name === "ROSTER_TABLE_GRID") continue;
			for (const t of tokens(value)) {
				if (
					name === "ROSTER_STATS_GRID_CLASS" ||
					name === "ROSTER_FILTER_ROW_CLASS"
				)
					continue; // used via the constant
				expect(roster, `${name}: ${t}`).toContain(t);
			}
		}
	});
	it("each route imports its wrapper class from route-layout, not a literal", () => {
		const schedule = sourceOf("routes/_authed/schedule.tsx");
		const club = sourceOf("routes/club.$clubId.index.tsx");
		expect(schedule).toContain(
			"<PageContainer className={SCHEDULE_PAGE_CLASS}>",
		);
		expect(club).toContain("className={CLUB_HOME_WRAPPER_CLASS}");
		expect(roster).toContain("className={ROSTER_STATS_GRID_CLASS}");
		expect(roster).toContain("const TABLE_GRID = ROSTER_TABLE_GRID");
	});
});
