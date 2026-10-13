// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { toast } = vi.hoisted(() => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("sonner", () => ({ toast }));

import { ShareLinkButton } from "./share-link-button";

beforeEach(() => {
	vi.stubGlobal("navigator", {
		clipboard: { writeText: vi.fn(async () => {}) },
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("ShareLinkButton toast", () => {
	// protects=a caller-supplied successMessage is the toast text after a copy;
	// fails_when=the prop is ignored and the default text is shown;
	// no_claim=sonner and the clipboard are stubbed, so no real toast renders
	// and no real clipboard is written.
	it("toasts a custom successMessage", async () => {
		render(
			<ShareLinkButton
				path="/club/x/next"
				label="Copy it"
				successMessage="Custom copied text"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Copy it" }));
		await vi.waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith("Custom copied text"),
		);
		expect(toast.success).toHaveBeenCalledTimes(1);
	});

	// protects=the two existing callers (sign-up sheet, onboarding checklist)
	// that pass no successMessage keep "Link copied — paste it to share";
	// fails_when=the default is changed or dropped when the prop is omitted;
	// no_claim=does not render those two callers; it exercises the component
	// with no successMessage, which is all they rely on.
	it("toasts the default text when successMessage is omitted", async () => {
		render(<ShareLinkButton path="/club/x" label="Copy it" />);
		fireEvent.click(screen.getByRole("button", { name: "Copy it" }));
		await vi.waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith(
				"Link copied — paste it to share",
			),
		);
	});
});
