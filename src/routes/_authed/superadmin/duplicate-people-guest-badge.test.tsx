// @vitest-environment jsdom
//
// The merge tool labels a guest-only Person (#1124, ADR-0031). A guest has a
// Person now, and a duplicate of a member that the superadmin has to repair is
// often exactly that: a row with no club and no sign-in. It renders the real
// route component with its server fns mocked, in both places a Person row is
// drawn: an auto-detected duplicate group, and the manual search results.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";

const { searchPeople } = vi.hoisted(() => ({ searchPeople: vi.fn() }));

vi.mock("#/server/people", () => ({
	listDuplicatePeopleFn: vi.fn(),
	mergePeopleFn: vi.fn(),
	previewMerge: vi.fn(),
	searchPeople,
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { Route } from "./duplicate-people";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

function person(
	id: string,
	name: string,
	over: Partial<{ guestOnly: boolean; linked: boolean; clubs: string[] }> = {},
) {
	return {
		id,
		name,
		email: "shared@example.com",
		linked: over.linked ?? false,
		historyCount: 0,
		clubs: over.clubs ?? [],
		guestOnly: over.guestOnly ?? false,
	};
}

async function renderConsole(groups: unknown[]) {
	vi.spyOn(Route, "useLoaderData").mockReturnValue(
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
		groups as any,
	);
	const Page = Route.options.component as () => React.ReactElement;
	await renderUnderMemoryRouter(<Page />);
}

/** The "Guest" badges drawn on the row naming `name`. */
function badgesOnRow(name: string): string[] {
	const label = screen.getByText(name).closest("label");
	if (!label) throw new Error(`no row for ${name}`);
	return [...label.querySelectorAll("span")]
		.map((s) => s.textContent ?? "")
		.filter((t) => t === "Guest");
}

describe("the merge tool's Guest badge (#1124)", () => {
	it("marks a guest-only Person in an auto-detected group, and only that one", async () => {
		await renderConsole([
			{
				email: "shared@example.com",
				people: [
					person("p-guest", "Visitor Vera", { guestOnly: true }),
					person("p-member", "Member Vera", { clubs: ["Downtown"] }),
				],
			},
		]);

		expect(badgesOnRow("Visitor Vera")).toEqual(["Guest"]);
		expect(badgesOnRow("Member Vera")).toEqual([]);
	});

	it("marks a guest-only Person in the manual search results", async () => {
		searchPeople.mockResolvedValueOnce([
			person("s-guest", "Search Guest", { guestOnly: true }),
			person("s-member", "Search Member", { clubs: ["Downtown"] }),
		]);
		await renderConsole([]);

		fireEvent.change(screen.getByLabelText("Search for a merge candidate"), {
			target: { value: "search" },
		});
		fireEvent.click(screen.getByRole("button", { name: /search/i }));

		await waitFor(() => screen.getByText("Search Guest"));
		expect(searchPeople).toHaveBeenCalledWith({ data: "search" });
		expect(badgesOnRow("Search Guest")).toEqual(["Guest"]);
		expect(badgesOnRow("Search Member")).toEqual([]);
	});
});
