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

const cancelButton = () =>
	screen.queryByRole("button", { name: /cancel meeting/i });

describe("Cancel meeting (#1057)", () => {
	it("shows for an officer on a cancellable meeting, and wires the handler", async () => {
		const onCancel = vi.fn();
		await renderToolbar({ onCancel });
		const button = cancelButton();
		expect(button).toBeTruthy();
		// `outline`, like every other edit-group button: the phase primary is
		// the only filled control in the row (D2).
		expect(button?.getAttribute("data-variant")).toBe("outline");
		await userEvent.click(button as HTMLElement);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("is absent for a member, whatever the route says about cancellability", async () => {
		await renderToolbar({ canManage: false, canCancel: true });
		expect(cancelButton()).toBeNull();
	});

	it("is absent when the route says the meeting cannot be cancelled now", async () => {
		await renderToolbar({ canCancel: false });
		expect(cancelButton()).toBeNull();
	});

	it("is absent on a locked meeting, which offers Reopen instead", async () => {
		await renderToolbar({ locked: true, canCancel: true });
		expect(cancelButton()).toBeNull();
		expect(
			screen.getByRole("button", { name: /reopen meeting/i }),
		).toBeTruthy();
	});

	it("is absent, and defaults closed, when the route passes nothing (the optional props)", async () => {
		await renderToolbar({
			cancelled: undefined,
			canCancel: undefined,
			onCancel: undefined,
		});
		expect(cancelButton()).toBeNull();
		// The rest of the edit group is untouched by the defaults.
		expect(screen.getByRole("button", { name: /add role/i })).toBeTruthy();
	});

	it("in flight: disables and announces aria-busy rather than hiding", async () => {
		await renderToolbar({ lifecycleBusy: true });
		const button = cancelButton() as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		expect(button.getAttribute("aria-busy")).toBe("true");
		cleanup();
		await renderToolbar({ lifecycleBusy: false });
		expect(cancelButton()?.getAttribute("aria-busy")).not.toBe("true");
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
		expect(cancelButton()).toBeNull();
	});

	it("the control: a scheduled meeting with the same props keeps the group", async () => {
		await renderToolbar({
			cancelled: false,
			canComplete: true,
			hasAddableRoles: true,
		});
		expect(screen.getByRole("button", { name: /add role/i })).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /complete meeting/i }),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: /promote/i })).toBeTruthy();
		expect(cancelButton()).toBeTruthy();
	});
});
