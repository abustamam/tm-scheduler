// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CLAIM_DEMO_ROLES, ClaimDemo } from "./claim-demo";

afterEach(cleanup);

const claimButtons = () => screen.queryAllByRole("button", { name: /^Claim / });

describe("ClaimDemo", () => {
	it("starts with every open role claimable and no Reset", () => {
		render(<ClaimDemo />);
		expect(claimButtons()).toHaveLength(CLAIM_DEMO_ROLES.length);
		expect(screen.queryByText("You ✓")).toBeNull();
		expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
	});

	it("turns only the tapped row into 'You ✓'", () => {
		render(<ClaimDemo />);
		fireEvent.click(screen.getByRole("button", { name: "Claim Speaker 2" }));

		const mine = screen.getByText("You ✓");
		expect(mine.closest("li")?.textContent).toContain("Speaker 2");
		expect(screen.getAllByText("You ✓")).toHaveLength(1);
		expect(
			screen.queryByRole("button", { name: "Claim Speaker 2" }),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "Claim Toastmaster" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Claim Evaluator 1" }),
		).toBeTruthy();
	});

	it("shows Reset after the first claim, and Reset restores the initial state", () => {
		render(<ClaimDemo />);
		fireEvent.click(screen.getByRole("button", { name: "Claim Toastmaster" }));
		fireEvent.click(screen.getByRole("button", { name: "Claim Evaluator 1" }));
		expect(screen.getAllByText("You ✓")).toHaveLength(2);

		fireEvent.click(screen.getByRole("button", { name: "Reset" }));
		expect(claimButtons()).toHaveLength(CLAIM_DEMO_ROLES.length);
		expect(screen.queryByText("You ✓")).toBeNull();
		expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
	});

	it("gates the claim pop behind motion-safe", () => {
		render(<ClaimDemo />);
		fireEvent.click(screen.getByRole("button", { name: "Claim Toastmaster" }));
		const cls = screen.getByText("You ✓").className;
		expect(cls).toContain("motion-safe:zoom-in-[1.08]");
		expect(cls).toContain("motion-safe:duration-300");
		// No un-gated animation class alongside it.
		expect(cls.split(/\s+/)).not.toContain("animate-in");
	});

	it("moves focus to the next open role and announces the claim", () => {
		render(<ClaimDemo />);
		const status = screen.getByRole("status");
		expect(status.textContent).toBe("");

		const first = screen.getByRole("button", { name: "Claim Toastmaster" });
		first.focus();
		fireEvent.click(first);
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Claim Speaker 2" }),
		);
		expect(status.textContent).toBe("You claimed Toastmaster.");

		// Claiming a later row moves on to whichever role is still open.
		fireEvent.click(screen.getByRole("button", { name: "Claim Evaluator 1" }));
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Claim Speaker 2" }),
		);
		expect(status.textContent).toBe("You claimed Evaluator 1.");
	});

	it("moves focus to Reset once every role is taken, and back to the first role after Reset", () => {
		render(<ClaimDemo />);
		for (const r of CLAIM_DEMO_ROLES) {
			fireEvent.click(screen.getByRole("button", { name: `Claim ${r.role}` }));
		}
		const reset = screen.getByRole("button", { name: "Reset" });
		expect(document.activeElement).toBe(reset);

		fireEvent.click(reset);
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: `Claim ${CLAIM_DEMO_ROLES[0].role}` }),
		);
		expect(screen.getByRole("status").textContent).toMatch(/reset/i);
	});

	it("labels its container", () => {
		render(<ClaimDemo />);
		expect(
			screen.getByRole("region", {
				name: "Try it: claim a role on the sign-up sheet",
			}),
		).toBeTruthy();
	});
});
