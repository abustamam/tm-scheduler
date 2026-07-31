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
async function renderActions(props: { wordOfTheDay?: string | null } = {}) {
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
		expect(screen.getByText("Role sheet")).toBeTruthy();
	});

	it("shows the Word poster button when the meeting has a word", async () => {
		await renderActions({ wordOfTheDay: "Ebullient" });
		const link = screen.getByText("Word poster").closest("a");
		expect(link).toBeTruthy();
		expect(link?.getAttribute("href")).toBe(
			"/club/downtown/meeting/2026-07-31/word",
		);
	});

	it("hides the Word poster button when the word is null", async () => {
		await renderActions({ wordOfTheDay: null });
		expect(screen.queryByText("Word poster")).toBeNull();
	});

	it("hides the Word poster button when no word prop is passed", async () => {
		await renderActions();
		expect(screen.queryByText("Word poster")).toBeNull();
	});

	// Whitespace-only is what an admin leaves behind after clearing the field, so
	// it has to read as "no word" the same way the poster route treats it.
	it.each([
		["an empty string", ""],
		["whitespace only", "   "],
	])("hides the Word poster button for %s", async (_label, word) => {
		await renderActions({ wordOfTheDay: word });
		expect(screen.queryByText("Word poster")).toBeNull();
	});
});
