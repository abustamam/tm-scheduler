// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MilestoneCard } from "./milestone-card";

const KEY = "gavelup:milestones";
const BOTH = { speechesDelivered: 1, meetingsAttended: 10 };

beforeEach(() => localStorage.clear());
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("MilestoneCard", () => {
	// protects=the first-speech card shows once per device; fails_when=it shows again on a second load or is never marked seen; no_claim=cross-device
	it("shows once, then not on the next load", () => {
		const first = render(<MilestoneCard memberId="m1" counts={BOTH} />);
		expect(screen.getByText("Your first speech is done.")).toBeTruthy();
		expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).toEqual([
			"m1:firstSpeech",
		]);
		first.unmount();
		// Second load: the first is seen, so the SECOND milestone is next, never both at once.
		render(<MilestoneCard memberId="m1" counts={BOTH} />);
		expect(screen.queryByText("Your first speech is done.")).toBeNull();
		expect(screen.getByText("10 meetings. You keep showing up.")).toBeTruthy();
	});

	// protects=dismissing the first never reveals the second in the same load; fails_when=the next card appears after Nice; no_claim=the next load
	it("shows nothing after Nice in the same load", async () => {
		render(<MilestoneCard memberId="m1" counts={BOTH} />);
		await userEvent.click(screen.getByRole("button", { name: "Nice" }));
		expect(screen.queryByRole("heading")).toBeNull();
	});

	// protects=a card that cannot be remembered never shows; fails_when=throwing storage shows a card; no_claim=the server
	it("shows nothing when storage throws", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		render(<MilestoneCard memberId="m1" counts={BOTH} />);
		expect(screen.queryByRole("heading")).toBeNull();
	});

	// protects=the 600ms motion is wired and the reduced-motion block still zeroes animations; fails_when=the class is dropped or the block stops covering animation-duration; no_claim=a rendered computed style (jsdom has no CSS engine)
	it("animates through classes the reduced-motion block covers", () => {
		render(<MilestoneCard memberId="m1" counts={BOTH} />);
		expect(document.querySelectorAll(".milestone-dot")).toHaveLength(8);
		expect(document.querySelector(".milestone-check")).not.toBeNull();
		const css = readFileSync("src/styles.css", "utf8");
		// Both milestone classes carry the 600ms animation and its keyframes exist.
		expect(css).toMatch(
			/\.milestone-check\s*{[^}]*animation:\s*celebrate-check 600ms/,
		);
		expect(css).toMatch(
			/\.milestone-dot\s*{[^}]*animation:\s*celebrate-dot 600ms/,
		);
		expect(css).toMatch(/@keyframes celebrate-check\s*{/);
		expect(css).toMatch(/@keyframes celebrate-dot\s*{/);
		// The reduced-motion block, by brace matching, not "everything after".
		const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
		expect(start).toBeGreaterThanOrEqual(0);
		let depth = 0;
		let end = css.indexOf("{", start);
		for (let i = end; i < css.length; i++) {
			if (css[i] === "{") depth++;
			if (css[i] === "}" && --depth === 0) {
				end = i;
				break;
			}
		}
		const block = css.slice(start, end);
		// The universal rule zeroes animation duration with !important, so the
		// milestone classes (no inline override) are covered...
		expect(block).toMatch(
			/\*,\s*::before,\s*::after\s*{[^}]*animation-duration:\s*0\.01ms\s*!important/,
		);
		// ...and nothing in the block re-enables them.
		expect(block).not.toMatch(/milestone-|celebrate-/);
	});
});
