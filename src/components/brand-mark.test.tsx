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

	it("omits the subtitle line when not provided", () => {
		render(<BrandMark />);
		expect(screen.queryByText(/Club 1492/)).toBeNull();
	});
});
