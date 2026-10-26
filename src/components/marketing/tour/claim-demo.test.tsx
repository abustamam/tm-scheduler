// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaimDemo } from "./claim-demo";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const claimBtn = (role: string) =>
	screen.getByRole("button", { name: `Claim ${role} — open` });
const row = (role: string) =>
	screen.getByText(role, { selector: "p" }).closest("li") as HTMLElement;
const filledText = () =>
	screen
		.getByRole("progressbar", { name: "Roles filled" })
		.getAttribute("aria-valuenow");

describe("ClaimDemo", () => {
	it("starts with three of six filled, open rows with Claim and the rest Filled", () => {
		render(<ClaimDemo />);
		expect(filledText()).toBe("3");
		for (const r of ["Speaker 2", "Evaluator 1", "Timer"]) {
			expect(claimBtn(r)).toBeTruthy();
		}
		expect(screen.getAllByText("Filled")).toHaveLength(3);
		expect(screen.getByText("Roles filled")).toBeTruthy();
		expect(screen.getByText("50%")).toBeTruthy();
		expect(row("Evaluator 1").textContent).toContain("Evaluates “Small Boats”");
		expect(screen.getByText(/Dynamic Leadership · 5–7 min/)).toBeTruthy();
		for (const r of ["Toastmaster", "Speaker 1", "Ah-Counter"]) {
			expect(row(r).textContent).not.toMatch(/Claim/);
		}
	});

	it("asks who you are first, with the real copy, and nothing is claimed yet", () => {
		render(<ClaimDemo />);
		fireEvent.click(claimBtn("Timer"));
		const dialog = screen.getByRole("dialog", { name: "Who are you?" });
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		expect(dialog.textContent).toContain(
			"Pick your name to continue. This just tags what you sign up for — no account needed.",
		);
		expect(dialog.textContent).toContain("Don't see your name?");
		// A link-styled button that must not navigate.
		const guestBook = screen.getByRole("button", {
			name: "Sign the guest book",
		});
		expect(guestBook.closest("a")).toBeNull();
		fireEvent.click(guestBook);
		expect(screen.getByRole("dialog", { name: "Who are you?" })).toBeTruthy();
		expect(filledText()).toBe("3");
	});

	it("opens the claim sheet after a name, then marks (you) with Release", () => {
		render(<ClaimDemo />);
		fireEvent.click(claimBtn("Timer"));
		fireEvent.click(screen.getByRole("button", { name: "Jordan Reyes" }));
		const sheet = screen.getByRole("dialog", { name: "Timer" });
		expect(sheet.textContent).toContain(
			"Time each speaker and show the green, yellow and red cards.",
		);
		fireEvent.click(screen.getByRole("button", { name: "Claim" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(row("Timer").textContent).toContain("Jordan Reyes (you)");
		expect(filledText()).toBe("4");
		expect(screen.getByRole("status").textContent).toBe("You're on as Timer.");
		const release = screen.getByRole("button", { name: "Release" });
		expect(document.activeElement).toBe(release);
	});

	it("skips the picker for the second claim", () => {
		render(<ClaimDemo />);
		fireEvent.click(claimBtn("Timer"));
		fireEvent.click(screen.getByRole("button", { name: "Sam Whitfield" }));
		fireEvent.click(screen.getByRole("button", { name: "Claim" }));
		fireEvent.click(claimBtn("Evaluator 1"));
		expect(screen.queryByRole("dialog", { name: "Who are you?" })).toBeNull();
		expect(screen.getByRole("dialog", { name: "Evaluator 1" })).toBeTruthy();
	});

	it("takes a speech title for a speaker slot, and shows TBA when blank", () => {
		render(<ClaimDemo />);
		fireEvent.click(claimBtn("Speaker 2"));
		fireEvent.click(screen.getByRole("button", { name: "Lena Park" }));
		const input = screen.getByLabelText("Speech title") as HTMLInputElement;
		expect(input.placeholder).toBe("TBA if not decided yet");
		expect(
			(screen.getByLabelText("Min minutes") as HTMLInputElement).value,
		).toBe("5");
		expect(
			(screen.getByLabelText("Max minutes") as HTMLInputElement).value,
		).toBe("7");
		fireEvent.change(screen.getByLabelText("Pathways project"), {
			target: { value: "Presentation Mastery · Level 2" },
		});
		fireEvent.change(input, { target: { value: "Tide Pools" } });
		fireEvent.click(
			screen.getByRole("button", { name: "Claim speaking slot" }),
		);
		expect(row("Speaker 2").textContent).toContain("“Tide Pools”");
		expect(row("Speaker 2").textContent).toContain(
			"Presentation Mastery · Level 2 · 5–7 min",
		);
		expect(screen.getByRole("status").textContent).toBe(
			"You're booked to speak!",
		);
		fireEvent.click(screen.getByRole("button", { name: "Release" }));
		expect(row("Speaker 2").textContent).not.toContain("Tide Pools");

		fireEvent.click(claimBtn("Speaker 2"));
		fireEvent.click(
			screen.getByRole("button", { name: "Claim speaking slot" }),
		);
		expect(row("Speaker 2").textContent).toContain("“TBA”");
	});

	// protects: the tour's Claim matches the product's amber Claim; fails_when:
	// it stays green or goes primary; no_claim: classes do not prove contrast.
	it("renders the open-row Claim with the amber classes, none green", () => {
		render(<ClaimDemo />);
		const c = screen.getAllByRole("button", { name: /^Claim .* — open$/ })[0]
			.className;
		expect(c).toMatch(/\bborder-warning\b/);
		expect(c).toMatch(/\bbg-warning-soft\b/);
		expect(c).toMatch(/\btext-warning-foreground\b/);
		expect(c).not.toMatch(/success/);
	});

	it("Cancel leaves the role open and returns focus to its Claim button", () => {
		render(<ClaimDemo />);
		fireEvent.click(claimBtn("Timer"));
		fireEvent.click(screen.getByRole("button", { name: "Jordan Reyes" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(filledText()).toBe("3");
		expect(document.activeElement).toBe(claimBtn("Timer"));
	});

	it("closes on Escape", () => {
		render(<ClaimDemo />);
		fireEvent.click(claimBtn("Timer"));
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("Release reopens the role and announces it", () => {
		render(<ClaimDemo />);
		fireEvent.click(claimBtn("Timer"));
		fireEvent.click(screen.getByRole("button", { name: "Jordan Reyes" }));
		fireEvent.click(screen.getByRole("button", { name: "Claim" }));
		fireEvent.click(screen.getByRole("button", { name: "Release" }));
		expect(filledText()).toBe("3");
		expect(screen.getByRole("status").textContent).toBe(
			"Role freed. Now tell the Toastmaster or VPE, or find someone to cover it.",
		);
		expect(document.activeElement).toBe(claimBtn("Timer"));
	});

	it("closes on a click on the backdrop but not inside the dialog", () => {
		render(<ClaimDemo />);
		fireEvent.click(claimBtn("Timer"));
		fireEvent.mouseDown(screen.getByRole("dialog"));
		expect(screen.getByRole("dialog")).toBeTruthy();
		fireEvent.mouseDown(
			screen.getByRole("dialog").parentElement as HTMLElement,
		);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("returns focus to the Claim button that opened the dialog on Escape", () => {
		render(<ClaimDemo />);
		fireEvent.click(claimBtn("Timer"));
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(document.activeElement).toBe(claimBtn("Timer"));
	});

	it("focuses the first control and wraps Tab and Shift+Tab inside the dialog", () => {
		render(<ClaimDemo />);
		fireEvent.click(claimBtn("Timer"));
		const dialog = screen.getByRole("dialog");
		const names = within(dialog).getAllByRole("button");
		expect(document.activeElement).toBe(names[0]);
		const last = names[names.length - 1];
		last.focus();
		const forward = !fireEvent.keyDown(last, { key: "Tab", cancelable: true });
		expect(forward).toBe(true);
		expect(document.activeElement).toBe(names[0]);
		const back = !fireEvent.keyDown(names[0], {
			key: "Tab",
			shiftKey: true,
			cancelable: true,
		});
		expect(back).toBe(true);
		expect(document.activeElement).toBe(last);
	});

	it("clears the toast timer on unmount", () => {
		const { unmount } = render(<ClaimDemo />);
		fireEvent.click(claimBtn("Timer"));
		fireEvent.click(screen.getByRole("button", { name: "Jordan Reyes" }));
		fireEvent.click(screen.getByRole("button", { name: "Claim" }));
		const pending = vi.getTimerCount();
		expect(pending).toBeGreaterThan(0);
		unmount();
		expect(vi.getTimerCount()).toBeLessThan(pending);
	});

	it("hides the toast after a few seconds", () => {
		render(<ClaimDemo />);
		fireEvent.click(claimBtn("Timer"));
		fireEvent.click(screen.getByRole("button", { name: "Jordan Reyes" }));
		fireEvent.click(screen.getByRole("button", { name: "Claim" }));
		act(() => vi.advanceTimersByTime(4100));
		expect(
			screen.queryByText("You're on as Timer.", { selector: "div" }),
		).toBeNull();
	});
});
