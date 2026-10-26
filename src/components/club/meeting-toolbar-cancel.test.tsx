// @vitest-environment jsdom
//
// The toolbar's Cancel meeting button (#1057), and what a cancelled meeting
// takes out of the officer edit group. Beside `meeting-toolbar.test.tsx` the
// way `meeting-toolbar-promote.test.tsx` is: the matrix there is #541's, this
// is the cancel axis.
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// Same hoisted mock as the sibling suites: the export menu's packet dialog
// calls a server fn, which vitest would follow into `#/db`.
vi.mock("#/server/packet", () => ({ getPacketContext: vi.fn() }));

import type { MeetingPhase } from "#/lib/meeting-lifecycle";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { MeetingToolbar, type MeetingToolbarProps } from "./meeting-toolbar";

const BASE: MeetingToolbarProps = {
	phase: "upcoming" as MeetingPhase,
	clubSlug: "downtown",
	meetingId: "2026-10-03",
	dbMeetingId: "11111111-2222-4333-8444-555555555555",
	sharePath: "/club/downtown/meeting/2026-10-03",
	wordOfTheDay: null,
	hasIdentity: true,
	canManage: true,
	locked: false,
	canComplete: false,
	hasAddableRoles: true,
	lifecycleBusy: false,
	onAddRole: vi.fn(),
	onComplete: vi.fn(),
	onReopen: vi.fn(),
	cancelled: false,
	canCancel: true,
	onCancel: vi.fn(),
};

afterEach(cleanup);

async function renderToolbar(overrides: Partial<MeetingToolbarProps> = {}) {
	await renderUnderMemoryRouter(<MeetingToolbar {...BASE} {...overrides} />);
}

/** Opens the Manage menu (#1307): Cancel, Complete etc. are menu items now. */
async function openManage() {
	await userEvent.click(screen.getByRole("button", { name: /^manage$/i }));
}
const item = (name: RegExp) => screen.queryByRole("menuitem", { name });

const cancelButton = () => item(/cancel meeting/i);

describe("Cancel meeting (#1057)", () => {
	it("shows for an officer on a cancellable meeting, and wires the handler", async () => {
		const onCancel = vi.fn();
		await renderToolbar({ onCancel });
		// Behind Manage, not a top-level button (#1307).
		expect(
			screen.queryByRole("button", { name: /cancel meeting/i }),
		).toBeNull();
		await openManage();
		const button = cancelButton();
		expect(button).toBeTruthy();
		// The destructive item style, last in the menu.
		expect(button?.getAttribute("data-variant")).toBe("destructive");
		await userEvent.click(button as HTMLElement);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("is absent for a member, whatever the route says about cancellability", async () => {
		await renderToolbar({ canManage: false, canCancel: true });
		expect(screen.queryByRole("button", { name: /^manage$/i })).toBeNull();
		expect(cancelButton()).toBeNull();
	});

	it("is absent when the route says the meeting cannot be cancelled now", async () => {
		await renderToolbar({ canCancel: false });
		await openManage();
		expect(cancelButton()).toBeNull();
	});

	it("is absent on a locked meeting, which offers Reopen instead", async () => {
		await renderToolbar({ locked: true, canCancel: true });
		await openManage();
		expect(cancelButton()).toBeNull();
		expect(item(/reopen meeting/i)).toBeTruthy();
	});

	it("is absent, and defaults closed, when the route passes nothing (the optional props)", async () => {
		await renderToolbar({
			cancelled: undefined,
			canCancel: undefined,
			onCancel: undefined,
		});
		await openManage();
		expect(cancelButton()).toBeNull();
		// The rest of the edit group is untouched by the defaults.
		expect(item(/add role/i)).toBeTruthy();
	});

	it("in flight: disables and announces aria-busy rather than hiding", async () => {
		await renderToolbar({ lifecycleBusy: true });
		await openManage();
		const button = cancelButton() as HTMLElement;
		expect(button.getAttribute("aria-disabled")).toBe("true");
		expect(button.getAttribute("aria-busy")).toBe("true");
		cleanup();
		await renderToolbar({ lifecycleBusy: false });
		await openManage();
		expect(cancelButton()?.getAttribute("aria-busy")).not.toBe("true");
	});

	it("only the pressed control spins: Complete in flight leaves Cancel disabled but quiet (review of #1084, G)", async () => {
		await renderToolbar({
			phase: "today",
			canComplete: true,
			lifecycleBusy: true,
			busyAction: "complete",
		});
		await openManage();
		const complete = item(/complete meeting/i) as HTMLElement;
		const cancel = cancelButton() as HTMLElement;
		// Both disabled: nothing else may start while a lifecycle write runs.
		expect(complete.getAttribute("aria-disabled")).toBe("true");
		expect(cancel.getAttribute("aria-disabled")).toBe("true");
		// Only the one pressed says so, and only it carries the spinner.
		expect(complete.getAttribute("aria-busy")).toBe("true");
		expect(cancel.getAttribute("aria-busy")).not.toBe("true");
		expect(complete.querySelector(".animate-spin")).not.toBeNull();
		expect(cancel.querySelector(".animate-spin")).toBeNull();
	});

	it("…and the other way round: Cancel in flight leaves Complete quiet", async () => {
		await renderToolbar({
			phase: "today",
			canComplete: true,
			lifecycleBusy: true,
			busyAction: "cancel",
		});
		await openManage();
		const complete = item(/complete meeting/i) as HTMLElement;
		expect(cancelButton()?.getAttribute("aria-busy")).toBe("true");
		expect(complete.getAttribute("aria-busy")).not.toBe("true");
		expect(complete.querySelector(".animate-spin")).toBeNull();
	});
});

describe("the phase primary on a cancelled meeting (review of #1084, G)", () => {
	it.each([
		{ phase: "today" as MeetingPhase, label: "Present on the day" },
		{ phase: "completed" as MeetingPhase, label: "Minutes after it" },
	])("no filled primary — $label", async ({ phase }) => {
		await renderToolbar({
			phase,
			hasIdentity: true,
			cancelled: true,
			canCancel: false,
		});
		expect(screen.queryByTestId("toolbar-primary")).toBeNull();
		expect(
			document.querySelectorAll('[data-slot="button"][data-variant="default"]'),
		).toHaveLength(0);
	});

	it.each([
		"today",
		"completed",
	] as MeetingPhase[])("the control: the same %s phase, not cancelled, keeps its primary", async (phase) => {
		await renderToolbar({ phase, hasIdentity: true, cancelled: false });
		expect(screen.getByTestId("toolbar-primary")).toBeTruthy();
	});
});

describe("a cancelled meeting's toolbar (#1057)", () => {
	it("drops the whole officer edit group and Promote, keeps share and export", async () => {
		await renderToolbar({
			cancelled: true,
			canCancel: false,
			canComplete: true,
			hasAddableRoles: true,
		});
		// Nothing in the officer group is reachable: the menu has no items, so
		// the trigger itself is gone.
		expect(screen.queryByRole("button", { name: /^manage$/i })).toBeNull();
		expect(cancelButton()).toBeNull();
		expect(screen.queryByRole("button", { name: /add role/i })).toBeNull();
		expect(
			screen.queryByRole("button", { name: /complete meeting/i }),
		).toBeNull();
		expect(screen.queryByRole("button", { name: /promote/i })).toBeNull();
		// Restore is the BANNER's, not the toolbar's.
		expect(screen.queryByRole("button", { name: /restore/i })).toBeNull();
		expect(
			screen.getByRole("button", { name: /copy share link/i }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /print & export/i }),
		).toBeTruthy();
	});

	it("the gate is `cancelled`, not the route's canCancel: a stale true cannot resurface the button", async () => {
		await renderToolbar({ cancelled: true, canCancel: true });
		expect(screen.queryByRole("button", { name: /^manage$/i })).toBeNull();
		expect(cancelButton()).toBeNull();
	});

	it("the control: a scheduled meeting with the same props keeps the group", async () => {
		await renderToolbar({
			cancelled: false,
			canComplete: true,
			hasAddableRoles: true,
		});
		await openManage();
		expect(item(/add role/i)).toBeTruthy();
		expect(item(/complete meeting/i)).toBeTruthy();
		expect(item(/promote/i)).toBeTruthy();
		expect(cancelButton()).toBeTruthy();
	});
});
