// @vitest-environment jsdom
//
// The cancellation notice sheet (#1057): what the two copy buttons hand to the
// clipboard, and what the officer sees before pressing either. Nothing here
// sends anything — the clipboard IS the whole of what the app does.
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const { toastSuccess, toastError } = vi.hoisted(() => ({
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: { success: toastSuccess, error: toastError },
}));

import { formatMeetingDate } from "#/lib/format";
import type { CancellationHolder } from "#/lib/meeting-cancellation-notice";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { MeetingCancellationSheet } from "./meeting-cancellation-sheet";

const AT = "2026-10-03T15:00:00Z";
const TZ = "America/Chicago";
const DATE = formatMeetingDate(AT, TZ);

const HOLDERS: CancellationHolder[] = [
	{ roleName: "Toastmaster", name: "Alice", email: "alice@example.com" },
	{ roleName: "Speaker", name: "Bob", email: "bob@example.com" },
	{ roleName: "Speaker", name: "Guest Gus", email: null },
	{ roleName: "Timer", name: "Alice", email: "alice@example.com" },
];

let writeText: ReturnType<typeof vi.fn>;

/** After `userEvent.setup()`, which installs its own clipboard stub. */
function stubClipboard() {
	writeText = vi.fn(async () => {});
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
}

afterEach(() => {
	cleanup();
	toastSuccess.mockClear();
	toastError.mockClear();
});

async function renderSheet(holders: readonly CancellationHolder[] = HOLDERS) {
	await renderUnderMemoryRouter(
		<MeetingCancellationSheet
			open
			onOpenChange={() => {}}
			clubName="Downtown Speakers"
			scheduledAt={AT}
			timezone={TZ}
			holders={holders}
		/>,
	);
	const user = userEvent.setup();
	stubClipboard();
	return user;
}

describe("MeetingCancellationSheet (#1057)", () => {
	it("previews every held role with its holders, and the drafted text", async () => {
		await renderSheet();
		const list = screen.getByTestId("cancellation-holders");
		expect(list.textContent).toContain("Toastmaster: Alice");
		expect(list.textContent).toContain("Speaker: Bob, Guest Gus");
		expect(list.textContent).toContain("Timer: Alice");
		const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
		expect(box.value.startsWith(`Our meeting on ${DATE} is cancelled.`)).toBe(
			true,
		);
		expect(box.value).toContain("Speaker: Bob, Guest Gus");
		expect(box.readOnly).toBe(true);
	});

	it("says nothing is sent", async () => {
		await renderSheet();
		expect(screen.getByText(/nothing is sent from gavelup/i)).toBeTruthy();
	});

	it("Copy text puts the drafted notice on the clipboard", async () => {
		const user = await renderSheet();
		await user.click(screen.getByRole("button", { name: /^copy text$/i }));
		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		const copied = writeText.mock.calls[0]?.[0] as string;
		expect(copied).toBe(
			[
				`Our meeting on ${DATE} is cancelled.`,
				"",
				"Toastmaster: Alice",
				"Speaker: Bob, Guest Gus",
				"Timer: Alice",
			].join("\n"),
		);
		expect(toastSuccess).toHaveBeenCalled();
	});

	it("Copy holders' emails copies members with an address, de-duplicated, and counts them", async () => {
		const user = await renderSheet();
		const button = screen.getByRole("button", {
			name: /copy holders' emails \(2\)/i,
		}) as HTMLButtonElement;
		expect(button.disabled).toBe(false);
		await user.click(button);
		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		// Alice once, Bob once, the guest not at all.
		expect(writeText.mock.calls[0]?.[0]).toBe(
			"alice@example.com, bob@example.com",
		);
	});

	it("with no addresses the email button is disabled, not hidden", async () => {
		await renderSheet([{ roleName: "Timer", name: "Guest Gus", email: null }]);
		const button = screen.getByRole("button", {
			name: /copy holders' emails/i,
		}) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		expect(button.textContent).not.toMatch(/\(\d+\)/);
	});

	it("with no holders the notice is the one sentence and says nobody held a role", async () => {
		await renderSheet([]);
		expect(screen.queryByTestId("cancellation-holders")).toBeNull();
		expect(screen.getByText(/nobody held a role/i)).toBeTruthy();
		const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
		expect(box.value).toBe(`Our meeting on ${DATE} is cancelled.`);
	});

	it("a blocked clipboard is reported, not swallowed", async () => {
		const user = await renderSheet();
		writeText.mockRejectedValueOnce(new Error("denied"));
		await user.click(screen.getByRole("button", { name: /^copy text$/i }));
		await waitFor(() => expect(toastError).toHaveBeenCalled());
		expect(toastSuccess).not.toHaveBeenCalled();
	});
});
