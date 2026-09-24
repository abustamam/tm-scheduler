// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FOUNDER_BLURB } from "#/lib/brand";
import { FounderNote } from "./founder-note";

afterEach(cleanup);

describe("FounderNote", () => {
	it("renders the canonical FOUNDER_BLURB", () => {
		render(<FounderNote />);
		expect(screen.getByText(FOUNDER_BLURB)).toBeTruthy();
	});

	it("merges a caller's className onto its own", () => {
		render(<FounderNote className="mt-4" />);
		const el = screen.getByText(FOUNDER_BLURB);
		expect(el.className).toContain("mt-4");
		expect(el.className).toContain("text-sm");
	});
});
