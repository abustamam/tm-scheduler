// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PresentDemo } from "./present-demo";

afterEach(cleanup);

const deck = () =>
	screen.getByRole("group", { name: /Sample slide deck/ }) as HTMLElement;
const next = () => screen.getByRole("button", { name: "Next slide" });
const prev = () => screen.getByRole("button", { name: "Previous slide" });
const live = () => screen.getByRole("status").textContent;

describe("PresentDemo", () => {
	it("starts on slide 1 of 5, the title splash", () => {
		render(<PresentDemo />);
		expect(screen.getByText("1 / 5")).toBeTruthy();
		expect(screen.getByText("Harbor City Speakers")).toBeTruthy();
		expect(screen.getByText("Start time: 7:00 PM")).toBeTruthy();
		expect(live()).toBe("Slide 1 of 5: Title slide");
	});

	it("moves with the two click zones and announces the slide", () => {
		render(<PresentDemo />);
		fireEvent.click(next());
		expect(screen.getByText("2 / 5")).toBeTruthy();
		expect(screen.getByText("Time: 5–7 minutes")).toBeTruthy();
		expect(live()).toBe("Slide 2 of 5: Speech");
		fireEvent.click(next());
		expect(live()).toBe("Slide 3 of 5: Vote for Best Speaker");
		fireEvent.click(next());
		expect(screen.getByText("Scan to grab a role")).toBeTruthy();
		expect(screen.getAllByText(/Open: grab it!/)).toHaveLength(3);
		fireEvent.click(prev());
		expect(screen.getByText("3 / 5")).toBeTruthy();
	});

	it("walks to the dark Thank You slide and stays there", () => {
		render(<PresentDemo />);
		for (let i = 0; i < 8; i++) fireEvent.click(next());
		expect(screen.getByText("5 / 5")).toBeTruthy();
		expect(screen.getByText("Thank You")).toBeTruthy();
		expect(
			screen.getByText("CONGRATULATIONS on another great learning session!"),
		).toBeTruthy();
		expect(screen.getByText("Next Meeting:")).toBeTruthy();
		expect(live()).toBe("Slide 5 of 5: Thank You");
	});

	it("does not go back past slide 1", () => {
		render(<PresentDemo />);
		fireEvent.click(prev());
		expect(screen.getByText("1 / 5")).toBeTruthy();
	});

	it("takes the arrow, page and space keys, and stops the page scrolling", () => {
		render(<PresentDemo />);
		// fireEvent returns false when the handler called preventDefault.
		const fire = (key: string) =>
			!fireEvent.keyDown(deck(), { key, cancelable: true });
		expect(fire("ArrowRight")).toBe(true);
		expect(screen.getByText("2 / 5")).toBeTruthy();
		expect(fire(" ")).toBe(true);
		expect(fire("PageDown")).toBe(true);
		expect(screen.getByText("4 / 5")).toBeTruthy();
		expect(fire("ArrowLeft")).toBe(true);
		expect(fire("PageUp")).toBe(true);
		expect(screen.getByText("2 / 5")).toBeTruthy();
		expect(fire("a")).toBe(false);
	});

	it("keeps the deck focusable and the QR decorative", () => {
		render(<PresentDemo />);
		expect(deck().getAttribute("tabindex")).toBe("0");
		fireEvent.click(next());
		fireEvent.click(next());
		expect(
			deck().querySelector("svg")?.closest("[aria-hidden='true']"),
		).toBeTruthy();
	});
});
