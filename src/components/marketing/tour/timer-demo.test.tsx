// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TimerDemo } from "./timer-demo";

afterEach(cleanup);

const light = () =>
	screen
		.getByRole("region", { name: "Try it: the Timer's timing light" })
		.querySelector("button") as HTMLButtonElement;

describe("TimerDemo", () => {
	it("shows the speaker's slot and window", () => {
		render(<TimerDemo />);
		expect(screen.getByText("Speaker 2 · 5–7 min")).toBeTruthy();
	});

	it("cycles off → green → yellow → red → off, naming each colour in text", () => {
		render(<TimerDemo />);
		const seen: Array<[string | null, string]> = [];
		const caption = () =>
			screen.getByText(/^(Off|Green|Yellow|Red)[.:]/).textContent ?? "";
		seen.push([light().getAttribute("data-state"), caption()]);
		for (let i = 0; i < 4; i++) {
			fireEvent.click(light());
			seen.push([light().getAttribute("data-state"), caption()]);
		}
		expect(seen.map(([s]) => s)).toEqual([
			"off",
			"green",
			"yellow",
			"red",
			"off",
		]);
		// Each state's colour is named in the caption, not only shown as a fill.
		for (const [state, text] of seen) {
			expect(text.toLowerCase()).toContain(state);
		}
		// And on the card itself.
		expect(light().textContent).toContain("off");
	});
});
