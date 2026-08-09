// @vitest-environment jsdom
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ROLE_SHEETS } from "#/data/role-sheets";
import { MeetingExportMenu } from "./meeting-export-menu";

afterEach(cleanup);

const BASE = {
	clubSlug: "downtown",
	meetingId: "2026-08-10",
	dbMeetingId: "11111111-2222-4333-8444-555555555555",
	wordOfTheDay: null as string | null,
	deck: undefined,
	clubName: undefined,
	presentIsPrimary: false,
};

/**
 * MeetingExportMenu renders <Link>s, so mount it under a minimal router —
 * mirrors the pattern in meeting-view-actions.test.tsx.
 */
async function openMenu(overrides: Partial<typeof BASE> = {}) {
	const props = { ...BASE, ...overrides };
	const rootRoute = createRootRoute({
		component: () => <MeetingExportMenu {...props} />,
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	// Let the router finish its first render pass.
	await waitFor(() => expect(router.state.status).toBe("idle"));
	await userEvent.click(
		screen.getByRole("button", { name: /print & export/i }),
	);
}

describe("MeetingExportMenu (#541 D2)", () => {
	it("always offers Print agenda and All role sheets, pinned to their targets", async () => {
		await openMenu();
		const print = screen.getByRole("menuitem", { name: /print agenda/i });
		expect(print.closest("a")?.getAttribute("href")).toContain(
			"/club/downtown/meeting/2026-08-10/print",
		);
		const roles = screen.getByRole("menuitem", { name: /all role sheets/i });
		expect(roles.closest("a")?.getAttribute("href")).toBe(
			"/club/downtown/roles",
		);
	});

	it("lists Present in the menu only when it is not the toolbar primary", async () => {
		await openMenu({ presentIsPrimary: false });
		const present = screen.getByRole("menuitem", { name: /present/i });
		expect(present.closest("a")?.getAttribute("href")).toContain(
			"/club/downtown/meeting/2026-08-10/present",
		);
	});

	it("omits Present from the menu when the toolbar already leads with it", async () => {
		await openMenu({ presentIsPrimary: true });
		expect(screen.queryByRole("menuitem", { name: /^present$/i })).toBeNull();
	});

	it("gates Word poster on a word existing — both branches", async () => {
		await openMenu({ wordOfTheDay: null });
		expect(screen.queryByRole("menuitem", { name: /word poster/i })).toBeNull();
		cleanup();
		await openMenu({ wordOfTheDay: "Buoyant" });
		expect(
			screen
				.getByRole("menuitem", { name: /word poster/i })
				.closest("a")
				?.getAttribute("href"),
		).toContain("/club/downtown/meeting/2026-08-10/word");
	});

	it("opens the per-meeting role-sheet PDFs in a dialog, one link per sheet", async () => {
		await openMenu();
		await userEvent.click(
			screen.getByRole("menuitem", { name: /this meeting's role sheets/i }),
		);
		for (const sheet of ROLE_SHEETS) {
			const link = screen.getByText(sheet.title).closest("a");
			expect(link?.getAttribute("href")).toBe(
				`/api/meetings/${BASE.dbMeetingId}/role-sheets/${sheet.key}/pdf`,
			);
		}
	});

	it("shows Download .pptx only when a deck and club name exist", async () => {
		await openMenu();
		expect(
			screen.queryByRole("menuitem", { name: /download \.pptx/i }),
		).toBeNull();
	});
});
