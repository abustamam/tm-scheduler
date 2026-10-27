// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BrandMark } from "./brand-mark";

describe("BrandMark", () => {
	afterEach(() => {
		cleanup();
	});

	it("renders the GavelUp wordmark and accessible glyph title", () => {
		render(<BrandMark />);
		expect(screen.getByText("GavelUp", { selector: "div" })).toBeTruthy();
		expect(screen.getByTitle("GavelUp")).toBeTruthy();
	});

	it("renders a subtitle when provided", () => {
		render(<BrandMark subtitle="Acme Club · Club 1492" />);
		expect(screen.getByText("Acme Club · Club 1492")).toBeTruthy();
	});

	it("lets a long subtitle truncate inside its column and keeps the full text in title", () => {
		render(<BrandMark subtitle="THR Speaking Club · Club 28680689" />);
		const line = screen.getByText("THR Speaking Club · Club 28680689");
		expect(line.getAttribute("title")).toBe(
			"THR Speaking Club · Club 28680689",
		);
		expect(line.className).toContain("truncate");
		// The text column is a flex item: without min-w-0 it refuses to shrink
		// and the truncation never happens.
		expect(line.parentElement?.className).toContain("min-w-0");
	});

	it("omits the title when the subtitle is not plain text", () => {
		render(<BrandMark subtitle={<span>Acme Club</span>} />);
		expect(
			screen.getByText("Acme Club").parentElement?.getAttribute("title"),
		).toBeNull();
	});

	it("omits the subtitle line when not provided", () => {
		render(<BrandMark />);
		expect(screen.queryByText(/Club 1492/)).toBeNull();
	});
});
