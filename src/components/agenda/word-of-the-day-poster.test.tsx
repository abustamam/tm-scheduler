// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WordOfTheDayPoster } from "./word-of-the-day-poster";

afterEach(cleanup);

const base = {
	word: "Ephemeral",
	definition: "Lasting for a very short time; fleeting.",
	example: "The applause was ephemeral, but the lesson stayed.",
	clubName: "Downtown Toastmasters",
	dateLong: "Friday, July 31, 2026",
};

describe("WordOfTheDayPoster", () => {
	it("renders the word, definition, and example", () => {
		render(<WordOfTheDayPoster {...base} />);
		expect(screen.getByText("Ephemeral")).toBeTruthy();
		expect(
			screen.getByText("Lasting for a very short time; fleeting."),
		).toBeTruthy();
		expect(
			screen.getByText(/The applause was ephemeral, but the lesson stayed\./),
		).toBeTruthy();
	});

	it("renders the club name and date in the footer", () => {
		render(<WordOfTheDayPoster {...base} />);
		expect(screen.getByText("Downtown Toastmasters")).toBeTruthy();
		expect(screen.getByText("Friday, July 31, 2026")).toBeTruthy();
	});

	it("sizes the word from its length", () => {
		const { unmount } = render(<WordOfTheDayPoster {...base} word="Apt" />);
		expect(screen.getByText("Apt").style.fontSize).toBe("200px");
		unmount();
		render(<WordOfTheDayPoster {...base} word="Circumlocution!" />);
		expect(screen.getByText("Circumlocution!").style.fontSize).toBe("88px");
	});

	it("omits the definition block when there is no definition", () => {
		render(<WordOfTheDayPoster {...base} definition={null} />);
		expect(screen.getByText("Ephemeral")).toBeTruthy();
		expect(screen.queryByTestId("wod-definition")).toBeNull();
		// The example still renders on its own.
		expect(screen.getByTestId("wod-example")).toBeTruthy();
	});

	it("omits the example block when there is no example", () => {
		render(<WordOfTheDayPoster {...base} example={null} />);
		expect(screen.getByTestId("wod-definition")).toBeTruthy();
		expect(screen.queryByTestId("wod-example")).toBeNull();
	});

	it("renders the word alone when neither definition nor example is set", () => {
		render(<WordOfTheDayPoster {...base} definition={null} example={null} />);
		expect(screen.getByText("Ephemeral")).toBeTruthy();
		expect(screen.queryByTestId("wod-definition")).toBeNull();
		expect(screen.queryByTestId("wod-example")).toBeNull();
	});

	it("treats a whitespace-only definition as absent", () => {
		render(<WordOfTheDayPoster {...base} definition="   " />);
		expect(screen.queryByTestId("wod-definition")).toBeNull();
	});
});
