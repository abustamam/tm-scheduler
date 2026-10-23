// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ClaimDemo } from "./claim-demo";

afterEach(cleanup);

const claimBtn = (role: string) =>
	screen.getByRole("button", { name: `Claim ${role} — open` });
const row = (role: string) =>
	screen.getByText(role, { selector: "p" }).closest("li") as HTMLElement;
const filledText = () => screen.getByText(/Roles filled: \d of 6/).textContent;

describe("ClaimDemo", () => {
	it("starts with three of six filled, open rows with Claim and the rest Filled", () => {
		render(<ClaimDemo />);
		expect(filledText()).toBe("Roles filled: 3 of 6");
		for (const r of ["Speaker 2", "Evaluator 1", "Timer"]) {
			expect(claimBtn(r)).toBeTruthy();
		}
		expect(screen.getAllByText("Filled")).toHaveLength(3);
		expect(screen.getByText("Evaluates")).toBeTruthy();
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
		expect(filledText()).toBe("Roles filled: 3 of 6");
	});

	it("opens the claim sheet after a name, then marks (you) with Release", () => {
		render(<ClaimDemo />);
		fireEvent.click(claimBtn("Timer"));
		fireEvent.click(screen.getByRole("button", { name: "Jordan Reyes" }));
		expect(screen.getByRole("dialog", { name: "Timer" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Claim" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(row("Timer").textContent).toContain("Jordan Reyes (you)");
		expect(filledText()).toBe("Roles filled: 4 of 6");
		expect(screen.getByRole("status").textContent).toBe("You claimed Timer.");
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
		expect(screen.getByText("Min 5 · Max 7 minutes")).toBeTruthy();
		fireEvent.change(input, { target: { value: "Tide Pools" } });
		fireEvent.click(
			screen.getByRole("button", { name: "Claim speaking slot" }),
		);
		expect(row("Speaker 2").textContent).toContain("“Tide Pools”");
		fireEvent.click(screen.getByRole("button", { name: "Release" }));
		expect(row("Speaker 2").textContent).not.toContain("Tide Pools");

		fireEvent.click(claimBtn("Speaker 2"));
		fireEvent.click(
			screen.getByRole("button", { name: "Claim speaking slot" }),
		);
		expect(row("Speaker 2").textContent).toContain("“TBA”");
	});

	it("Cancel leaves the role open and returns focus to its Claim button", () => {
		render(<ClaimDemo />);
		fireEvent.click(claimBtn("Timer"));
		fireEvent.click(screen.getByRole("button", { name: "Jordan Reyes" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(filledText()).toBe("Roles filled: 3 of 6");
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
		expect(filledText()).toBe("Roles filled: 3 of 6");
		expect(screen.getByRole("status").textContent).toBe("You released Timer.");
		expect(document.activeElement).toBe(claimBtn("Timer"));
	});
});
