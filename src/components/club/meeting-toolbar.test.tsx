// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgendaLayout } from "#/components/agenda/meeting-agenda-print";
import type { Slide } from "#/lib/agenda-slides";
import type { MeetingPhase } from "#/lib/meeting-lifecycle";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { MeetingToolbar } from "./meeting-toolbar";

const BASE = {
	phase: "upcoming" as MeetingPhase,
	clubSlug: "downtown",
	meetingId: "2026-08-10",
	dbMeetingId: "11111111-2222-4333-8444-555555555555",
	sharePath: "/club/downtown/meeting/2026-08-10",
	printLayout: undefined as AgendaLayout | undefined,
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
 * under a minimal router — shared with meeting-export-menu.test.tsx via
 * src/test/router-harness.tsx.
 */
async function renderToolbar(overrides: Partial<typeof BASE> = {}) {
	const props = { ...BASE, ...overrides };
	await renderUnderMemoryRouter(<MeetingToolbar {...props} />);
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
		// Filled weight — Button defaults to variant="default", not "outline",
		// so the phase primary reads as the one emphasized action in the row.
		expect(primary.getAttribute("data-variant")).toBe("default");
		// Opened in a new tab (target="_blank" above) needs noopener so the new
		// page can't reach back into this one via window.opener.
		expect(primary.closest("a")?.getAttribute("rel")).toContain("noopener");
	});

	it("today + GUEST (no identity): no primary, but share + the export menu stay reachable (spec D2 guest row)", async () => {
		await renderToolbar({ phase: "today", hasIdentity: false });
		expect(screen.queryByTestId("toolbar-primary")).toBeNull();
		// Present stays one tap away for guests: the export menu lists it
		// whenever it is not the primary (asserted in meeting-export-menu.test).
		expect(
			screen.getByRole("button", { name: /copy share link/i }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /print & export/i }),
		).toBeTruthy();
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

	it("today + identity: Present is already the toolbar primary, so the export menu omits it", async () => {
		await renderToolbar({ phase: "today", hasIdentity: true });
		await userEvent.click(
			screen.getByRole("button", { name: /print & export/i }),
		);
		expect(screen.queryByRole("menuitem", { name: /^present$/i })).toBeNull();
	});

	it("upcoming: no toolbar primary, so the export menu hands Present back", async () => {
		await renderToolbar({ phase: "upcoming", hasIdentity: true });
		await userEvent.click(
			screen.getByRole("button", { name: /print & export/i }),
		);
		expect(screen.getByRole("menuitem", { name: /^present$/i })).toBeTruthy();
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

	it("officer, but no addable roles left: no Add role button", async () => {
		await renderToolbar({ canManage: true, hasAddableRoles: false });
		expect(screen.queryByRole("button", { name: /add role/i })).toBeNull();
	});

	it("officer, but nothing left to complete: no Complete meeting button", async () => {
		await renderToolbar({
			canManage: true,
			canComplete: false,
			locked: false,
		});
		expect(
			screen.queryByRole("button", { name: /complete meeting/i }),
		).toBeNull();
	});

	it("lifecycle mutation in flight: Complete meeting disables instead of hiding", async () => {
		await renderToolbar({
			canManage: true,
			canComplete: true,
			lifecycleBusy: true,
		});
		const complete = screen.getByRole("button", {
			name: /complete meeting/i,
		}) as HTMLButtonElement;
		expect(complete.disabled).toBe(true);
	});

	it("lifecycle mutation in flight while locked: Reopen meeting disables instead of hiding", async () => {
		await renderToolbar({
			canManage: true,
			locked: true,
			lifecycleBusy: true,
		});
		const reopen = screen.getByRole("button", {
			name: /reopen meeting/i,
		}) as HTMLButtonElement;
		expect(reopen.disabled).toBe(true);
	});

	it("passes printLayout/deck/clubName/wordOfTheDay through to the export menu", async () => {
		const deck = [{ kind: "title" }] as unknown as Slide[];
		await renderToolbar({
			phase: "upcoming",
			hasIdentity: true,
			wordOfTheDay: "Buoyant",
			deck,
			clubName: "HCS",
			printLayout: "editorial",
		});
		await userEvent.click(
			screen.getByRole("button", { name: /print & export/i }),
		);
		expect(
			screen
				.getByRole("menuitem", { name: /word poster/i })
				.closest("a")
				?.getAttribute("href"),
		).toContain("/word");
		expect(
			screen.getByRole("menuitem", { name: /download \.pptx/i }),
		).toBeTruthy();
		expect(
			screen
				.getByRole("menuitem", { name: /print agenda/i })
				.closest("a")
				?.getAttribute("href"),
		).toBe("/club/downtown/meeting/2026-08-10/print?layout=editorial");
	});

	it("passes dbMeetingId through — the per-meeting PDFs must name THIS meeting", async () => {
		// dbMeetingId is a DIFFERENT id from meetingId two props above (uuid vs
		// URL key); wiring the wrong one serves another meeting's role sheets.
		await renderToolbar({ hasIdentity: true });
		await userEvent.click(
			screen.getByRole("button", { name: /print & export/i }),
		);
		await userEvent.click(
			screen.getByRole("menuitem", { name: /this meeting's role sheets/i }),
		);
		const pdf = document.querySelector('a[href*="/role-sheets/"]');
		expect(pdf?.getAttribute("href")).toContain(BASE.dbMeetingId);
	});

	it("passes sharePath through — the share chip copies the meeting URL", async () => {
		const user = userEvent.setup();
		await renderToolbar({ hasIdentity: true });
		await user.click(screen.getByRole("button", { name: /copy share link/i }));
		const copied = await window.navigator.clipboard.readText();
		expect(copied).toContain("/club/downtown/meeting/2026-08-10");
	});

	it("orders the toolbar: primary, then share, then the export menu trigger", async () => {
		await renderToolbar({ phase: "today", hasIdentity: true });
		const primary = screen.getByTestId("toolbar-primary");
		const share = screen.getByRole("button", { name: /copy share link/i });
		const menuTrigger = screen.getByRole("button", {
			name: /print & export/i,
		});
		expect(
			primary.compareDocumentPosition(share) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			share.compareDocumentPosition(menuTrigger) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});
});
