// @vitest-environment jsdom
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MeetingViewActions } from "./meeting-view-actions";

afterEach(cleanup);

/**
 * MeetingViewActions renders <Link>s, so mount it under a minimal router —
 * mirrors the pattern in onboarding-checklist.test.tsx / guest-resources.test.tsx.
 */
async function renderActions(props: { wordOfTheDay: string | null }) {
	const rootRoute = createRootRoute({
		component: () => (
			<MeetingViewActions
				clubSlug="downtown"
				meetingId="2026-07-31"
				{...props}
			/>
		),
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	// Let the router finish its first render pass.
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

describe("MeetingViewActions", () => {
	it("renders the three ungated launch actions", async () => {
		await renderActions({ wordOfTheDay: null });
		expect(screen.getByText("Print agenda")).toBeTruthy();
		expect(screen.getByText("Present")).toBeTruthy();
		// #542: "All role sheets" (was "Role sheet") — the club-level printable,
		// disambiguated from the meeting-specific "This meeting's role sheets"
		// download menu that renders beside this component on the meeting page.
		const link = screen.getByText("All role sheets").closest("a");
		expect(link?.getAttribute("href")).toBe("/club/downtown/roles");
	});

	it("shows the Word poster button when the meeting has a word", async () => {
		await renderActions({ wordOfTheDay: "Ebullient" });
		const link = screen.getByText("Word poster").closest("a");
		expect(link).toBeTruthy();
		expect(link?.getAttribute("href")).toBe(
			"/club/downtown/meeting/2026-07-31/word",
		);
	});

	// The whitespace row is the one that earns its keep: it is the only case that
	// fails if someone swaps `hasWordOfTheDay` for a bare `Boolean(...)`, which
	// would show a button leading to a poster with nothing on it.
	//
	// No `undefined` row: `wordOfTheDay` is a REQUIRED `string | null` prop, so
	// the compiler rules that input out at the one call site. `hasWordOfTheDay`
	// still handles it, and word-poster.test.ts covers that directly.
	it.each<[string, string | null]>([
		["null", null],
		["an empty string", ""],
		["whitespace only", "   "],
	])("hides the Word poster button for %s", async (_label, word) => {
		await renderActions({ wordOfTheDay: word });
		expect(screen.queryByText("Word poster")).toBeNull();
	});
});
