// @vitest-environment jsdom
//
// The meeting-sign ROUTE (#1167): the `arrow` search parsing, the 404 for an
// unknown club, the <title> that becomes the saved-PDF filename, and that
// `chrome=none` hides the toolbar. Same pattern as
// `club.$clubId_.meeting.$meetingId.word.test.tsx`.
import { isNotFound } from "@tanstack/react-router";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";

vi.mock("#/lib/club-route", () => ({ resolveClubOrRedirect: vi.fn() }));

import { resolveClubOrRedirect } from "#/lib/club-route";
import { Route } from "./club.$clubId_.sign";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

const validate = Route.options.validateSearch as (
	s: Record<string, unknown>,
) => { arrow?: string; chrome?: string };

async function renderSign(search: {
	arrow?: "left" | "right";
	chrome?: "none";
}) {
	vi.spyOn(Route, "useSearch").mockReturnValue(search as never);
	vi.spyOn(Route, "useParams").mockReturnValue({ clubId: "downtown" } as never);
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		club: { id: "c1", name: "Downtown Toastmasters", slug: "downtown" },
	} as never);
	const Component = Route.options.component as () => React.ReactElement;
	await renderUnderMemoryRouter(<Component />);
}

describe("meeting sign route: validateSearch", () => {
	it.each([
		["left", "left"],
		["right", "right"],
		["up", undefined],
		["", undefined],
		[undefined, undefined],
		[["left"], undefined],
	])("arrow=%j parses to %j", (input, expected) => {
		expect(validate({ arrow: input }).arrow).toBe(expected);
	});

	it("keeps chrome=none and drops any other chrome value", () => {
		expect(validate({ chrome: "none" }).chrome).toBe("none");
		expect(validate({ chrome: "full" }).chrome).toBeUndefined();
	});
});

describe("meeting sign route: loader and head", () => {
	it("passes the resolved club through", async () => {
		const club = { id: "c1", name: "Downtown Toastmasters", slug: "downtown" };
		vi.mocked(resolveClubOrRedirect).mockResolvedValue(club as never);
		const loader = Route.options.loader as (a: unknown) => Promise<unknown>;
		await expect(
			loader({ params: { clubId: "downtown" }, location: {} }),
		).resolves.toEqual({ club });
	});

	it("an unknown or archived club is a 404 (the resolver's notFound propagates)", async () => {
		const { notFound } = await import("@tanstack/react-router");
		vi.mocked(resolveClubOrRedirect).mockImplementation(async () => {
			throw notFound();
		});
		const loader = Route.options.loader as (a: unknown) => Promise<unknown>;
		const err = await loader({
			params: { clubId: "nope" },
			location: {},
		}).catch((e: unknown) => e);
		expect(isNotFound(err)).toBe(true);
	});

	it("titles the page for the saved PDF and keeps it out of search", () => {
		const head = Route.options.head as (a: unknown) => {
			meta: Array<Record<string, string>>;
		};
		const { meta } = head({
			loaderData: { club: { name: "Downtown Toastmasters" } },
		});
		expect(meta).toContainEqual({
			title: "Downtown Toastmasters — Meeting sign",
		});
		expect(meta).toContainEqual({
			name: "robots",
			content: "noindex, nofollow",
		});
	});
});

describe("meeting sign route: component", () => {
	it("shows the three tabs and a Print button, with the sign", async () => {
		await renderSign({});
		expect(screen.getByRole("link", { name: "No arrow" })).toBeTruthy();
		const left = screen.getByRole("link", { name: "Arrow left" });
		expect(left.getAttribute("href")).toBe("/club/downtown/sign?arrow=left");
		expect(screen.getByRole("link", { name: "Arrow right" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Print" })).toBeTruthy();
		expect(screen.getByText("Guests Welcome")).toBeTruthy();
	});

	it("renders the arrow variant for ?arrow=right", async () => {
		await renderSign({ arrow: "right" });
		expect(screen.getByText("THIS WAY")).toBeTruthy();
		expect(
			screen.getByTestId("sign-arrow").getAttribute("data-direction"),
		).toBe("right");
	});

	it("chrome=none hides the toolbar and leaves only the sheet", async () => {
		await renderSign({ chrome: "none" });
		expect(screen.queryByRole("button", { name: "Print" })).toBeNull();
		expect(screen.queryByRole("link", { name: "No arrow" })).toBeNull();
		expect(screen.getByTestId("meeting-sign")).toBeTruthy();
	});
});
