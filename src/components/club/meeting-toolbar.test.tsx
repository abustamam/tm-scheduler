// @vitest-environment jsdom
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Slide } from "#/lib/agenda-slides";
import type { MeetingPhase } from "#/lib/meeting-lifecycle";
import { MeetingToolbar } from "./meeting-toolbar";

const BASE = {
	phase: "upcoming" as MeetingPhase,
	clubSlug: "downtown",
	meetingId: "2026-08-10",
	dbMeetingId: "11111111-2222-4333-8444-555555555555",
	sharePath: "/club/downtown/meeting/2026-08-10",
	wordOfTheDay: null as string | null,
	deck: undefined as Slide[] | undefined,
	clubName: undefined as string | undefined,
	hasIdentity: false,
	canManage: false,
	locked: false,
	canComplete: false,
	hasAddableRoles: false,
	lifecycleBusy: false,
	onAddRole: vi.fn(),
	onComplete: vi.fn(),
	onReopen: vi.fn(),
};

afterEach(cleanup);

/**
 * MeetingToolbar renders <Link>s (Present/Minutes/export menu), so mount it
 * under a minimal router — mirrors meeting-export-menu.test.tsx's harness.
 */
async function renderToolbar(overrides: Partial<typeof BASE> = {}) {
	const props = { ...BASE, ...overrides };
	const rootRoute = createRootRoute({
		component: () => <MeetingToolbar {...props} />,
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	// Let the router finish its first render pass.
	await waitFor(() => expect(router.state.status).toBe("idle"));
	return props;
}

describe("MeetingToolbar (#541 D2)", () => {
	it("upcoming: no primary — just share and the export menu", async () => {
		await renderToolbar({ phase: "upcoming", hasIdentity: true });
		expect(
			screen.getByRole("button", { name: /copy share link/i }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /print & export/i }),
		).toBeTruthy();
		expect(screen.queryByTestId("toolbar-primary")).toBeNull();
	});

	it("today + identity: Present is the filled primary, pinned to the present route", async () => {
		await renderToolbar({ phase: "today", hasIdentity: true });
		const primary = screen.getByTestId("toolbar-primary");
		expect(primary.textContent).toMatch(/present/i);
		expect(primary.closest("a")?.getAttribute("href")).toContain(
			"/club/downtown/meeting/2026-08-10/present",
		);
	});

	it("today + GUEST (no identity): no primary — spec D2 keeps guest chrome quiet (review 1A)", async () => {
		await renderToolbar({ phase: "today", hasIdentity: false });
		expect(screen.queryByTestId("toolbar-primary")).toBeNull();
		// Present stays one tap away for guests: the export menu lists it
		// whenever it is not the primary (asserted in meeting-export-menu.test).
	});

	it("today + officer without personal identity still gets the primary (canManage counts)", async () => {
		await renderToolbar({
			phase: "today",
			hasIdentity: false,
			canManage: true,
		});
		expect(screen.getByTestId("toolbar-primary").textContent).toMatch(
			/present/i,
		);
	});

	it("completed + officer: Minutes is the primary and anchors to the minutes section", async () => {
		await renderToolbar({ phase: "completed", canManage: true });
		const primary = screen.getByTestId("toolbar-primary");
		expect(primary.textContent).toMatch(/minutes/i);
		expect(primary.closest("a")?.getAttribute("href")).toContain("#minutes");
	});

	it("completed + member/guest: no primary — Minutes primary is officer-only per the spec table", async () => {
		await renderToolbar({
			phase: "completed",
			hasIdentity: true,
			canManage: false,
		});
		expect(screen.queryByTestId("toolbar-primary")).toBeNull();
	});

	it("officer edit group renders only for canManage", async () => {
		await renderToolbar({ canManage: false, hasAddableRoles: true });
		expect(screen.queryByRole("button", { name: /add role/i })).toBeNull();
		cleanup();
		await renderToolbar({
			canManage: true,
			hasAddableRoles: true,
			canComplete: true,
		});
		expect(screen.getByRole("button", { name: /add role/i })).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /complete meeting/i }),
		).toBeTruthy();
	});

	it("locked meeting offers Reopen (officer) instead of Add role / Complete", async () => {
		await renderToolbar({
			canManage: true,
			locked: true,
			hasAddableRoles: true,
			canComplete: true,
		});
		expect(
			screen.getByRole("button", { name: /reopen meeting/i }),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: /add role/i })).toBeNull();
		expect(
			screen.queryByRole("button", { name: /complete meeting/i }),
		).toBeNull();
	});

	it("wires the edit-group handlers", async () => {
		const onAddRole = vi.fn();
		const onComplete = vi.fn();
		await renderToolbar({
			canManage: true,
			hasAddableRoles: true,
			canComplete: true,
			onAddRole,
			onComplete,
		});
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: /add role/i }));
		await user.click(screen.getByRole("button", { name: /complete meeting/i }));
		expect(onAddRole).toHaveBeenCalledTimes(1);
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it("wires the reopen handler", async () => {
		const onReopen = vi.fn();
		await renderToolbar({ canManage: true, locked: true, onReopen });
		await userEvent.click(
			screen.getByRole("button", { name: /reopen meeting/i }),
		);
		expect(onReopen).toHaveBeenCalledTimes(1);
	});
});
