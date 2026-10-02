// @vitest-environment jsdom
/**
 * `/schedule`'s `?past=` (#1048): what the URL admits, what the loader sends,
 * and that picking a lookback keeps the rest of the search.
 *
 * The URL cases go through the router's own `defaultParseSearch` before
 * `validateSearch`, because that is what a typed-in address actually hits:
 * `?past=8` arrives as the NUMBER 8, `?past=` as an empty string, and a repeated
 * param as whatever the parser makes of it. Feeding `validateSearch` hand-built
 * objects alone would test a shape the app never receives.
 */

import {
	defaultParseSearch,
	defaultStringifySearch,
} from "@tanstack/react-router";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SeasonGridData } from "#/server/season-grid";
import { renderUnderMemoryRouter } from "#/test/router-harness";

const { getSeasonGrid } = vi.hoisted(() => ({
	getSeasonGrid: vi.fn(async (_: unknown) => ({}) as SeasonGridData),
}));
vi.mock("#/server/season-grid", () => ({ getSeasonGrid }));
// The route imports `listCancelledMeetings` from the meetings server-fn module
// (#1057), which reaches `#/db` on import like the three below. The cases here
// are about `?past=`; `schedule-cancelled.test.tsx` is where the strip is.
vi.mock("#/server/meetings", () => ({
	listCancelledMeetings: vi.fn(async () => []),
}));
vi.mock("#/server/slots", () => ({ claimSlot: vi.fn(), releaseSlot: vi.fn() }));
vi.mock("#/server/availability", () => ({
	clearAvailability: vi.fn(),
	markUnavailableReleasing: vi.fn(),
	setAvailability: vi.fn(),
}));

import { Route } from "./schedule";

Element.prototype.scrollIntoView = vi.fn();

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

type ValidateSearch = (s: Record<string, unknown>) => {
	view: string;
	count: unknown;
	past?: number;
};
const validateSearch = Route.options
	.validateSearch as unknown as ValidateSearch;

/** A typed-in `/schedule?…`, parsed the way the router parses it. */
const fromUrl = (qs: string) => validateSearch(defaultParseSearch(qs));

describe("?past= in the URL", () => {
	it.each([4, 8, 13])("?past=%i is kept", (n) => {
		expect(fromUrl(`?past=${n}`).past).toBe(n);
	});

	it.each([
		["?past=2", "the default itself"],
		["?past=99", "out of range"],
		["?past=0", "zero"],
		["?past=-1", "negative"],
		["?past=3", "between members of the set"],
		["?past=abc", "not a number"],
		["?past=", "empty"],
		["?past=8&past=4", "repeated"],
		["", "absent"],
	])("%s (%s) falls back to 2, which the URL leaves out", (qs) => {
		const search = fromUrl(qs);
		expect(search.past).toBeUndefined();
		expect("past" in search).toBe(false);
	});

	it("keeps view and count beside it", () => {
		expect(fromUrl("?view=roles&count=4&past=13")).toEqual({
			view: "roles",
			count: 4,
			past: 13,
		});
	});

	it("survives a reload: stringified then parsed again, it is unchanged", () => {
		const search = fromUrl("?view=roles&count=4&past=8");
		expect(fromUrl(defaultStringifySearch(search))).toEqual(search);
	});
});

describe("the loader", () => {
	type LoaderDeps = (o: { search: ReturnType<ValidateSearch> }) => {
		count: unknown;
		past: number;
	};
	const loaderDeps = Route.options.loaderDeps as unknown as LoaderDeps;
	const loader = Route.options.loader as unknown as (o: {
		context: {
			activeClubId: string | null;
			clubs: never[];
			officerPositions: never[];
		};
		deps: ReturnType<LoaderDeps>;
	}) => Promise<unknown>;

	it.each([
		["?past=13", 13],
		["?past=8", 8],
		["?past=99", 2],
		["", 2],
	])("%s asks the server for pastCount %i", async (qs, expected) => {
		const deps = loaderDeps({ search: fromUrl(qs) });
		expect(deps.past).toBe(expected);
		await loader({
			context: { activeClubId: "club-1", clubs: [], officerPositions: [] },
			deps,
		});
		expect(getSeasonGrid).toHaveBeenCalledWith({
			data: { clubId: "club-1", count: 8, pastCount: expected },
		});
	});
});

const gridData: SeasonGridData = {
	clubSlug: null,
	meetings: [
		{
			id: "m1",
			scheduledAt: "2026-10-01T19:00:00Z",
			timezone: "UTC",
			urlKey: "2026-10-01",
			openCount: 1,
			totalSlots: 1,
			isPast: false,
			isAnchor: true,
			isCompleted: false,
		},
	],
	rows: [
		{
			roleDefinitionId: "ti",
			slotIndex: 0,
			label: "Timer",
			shortCode: "Time",
			sortOrder: 0,
			isSpeakerRole: false,
		},
	],
	members: [{ id: "a", name: "Amir" }],
	memberNames: [{ id: "a", name: "Amir" }],
	guestNames: [],
	cells: [],
	unavailable: [],
	contacted: [],
};

async function renderPage(search: ReturnType<ValidateSearch>) {
	const navigate = vi.fn();
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		data: gridData,
		cancelled: [],
	} as never);
	vi.spyOn(Route, "useSearch").mockReturnValue(search as never);
	vi.spyOn(Route, "useRouteContext").mockReturnValue({
		clubs: [],
		activeClubId: "club-1",
		currentMemberId: "a",
		impersonating: null,
	} as never);
	vi.spyOn(Route, "useNavigate").mockReturnValue(navigate as never);
	const Page = Route.options.component as React.ComponentType;
	await renderUnderMemoryRouter(<Page />);
	return navigate;
}

/** Apply the `search` updater the page handed `navigate` to `prev`. */
function applied(
	navigate: ReturnType<typeof vi.fn>,
	prev: ReturnType<ValidateSearch>,
) {
	const arg = navigate.mock.calls.at(-1)?.[0] as {
		search: (p: typeof prev) => Record<string, unknown>;
	};
	return arg.search(prev);
}

describe("the Show past control", () => {
	it("reads the current lookback from the URL", async () => {
		await renderPage({ view: "roles", count: 4, past: 13 });
		expect(
			screen
				.getByRole("button", { name: "Show 13 past meetings" })
				.getAttribute("aria-pressed"),
		).toBe("true");
	});

	it("reads 2 as current when the URL has no past", async () => {
		await renderPage({ view: "roles", count: 4 });
		expect(
			screen
				.getByRole("button", { name: "Show 2 past meetings" })
				.getAttribute("aria-pressed"),
		).toBe("true");
	});

	it("picking one keeps view and count", async () => {
		const prev = { view: "roles", count: 4 } as const;
		const navigate = await renderPage(prev);
		fireEvent.click(
			screen.getByRole("button", { name: "Show 8 past meetings" }),
		);
		await waitFor(() => expect(navigate).toHaveBeenCalled());
		const next = applied(navigate, prev);
		expect(next).toEqual({ view: "roles", count: 4, past: 8 });
		expect(defaultStringifySearch(next)).toBe("?view=roles&count=4&past=8");
	});

	it("picking 2 drops the key from the URL rather than writing past=2", async () => {
		const prev = { view: "members", count: "all", past: 13 } as const;
		const navigate = await renderPage(prev);
		fireEvent.click(
			screen.getByRole("button", { name: "Show 2 past meetings" }),
		);
		await waitFor(() => expect(navigate).toHaveBeenCalled());
		const next = applied(navigate, prev);
		expect(next.view).toBe("members");
		expect(next.count).toBe("all");
		expect(defaultStringifySearch(next)).not.toContain("past");
	});

	it("the orientation toggle keeps past", async () => {
		const prev = { view: "members", count: 8, past: 13 } as const;
		const navigate = await renderPage(prev);
		fireEvent.click(screen.getByRole("button", { name: "Roles × Meetings" }));
		await waitFor(() => expect(navigate).toHaveBeenCalled());
		expect(applied(navigate, prev)).toEqual({
			view: "roles",
			count: 8,
			past: 13,
		});
	});

	it("the Meetings shown control keeps past", async () => {
		const prev = { view: "members", count: 8, past: 4 } as const;
		const navigate = await renderPage(prev);
		fireEvent.click(screen.getByRole("button", { name: "All" }));
		await waitFor(() => expect(navigate).toHaveBeenCalled());
		expect(applied(navigate, prev)).toEqual({
			view: "members",
			count: "all",
			past: 4,
		});
	});
});
