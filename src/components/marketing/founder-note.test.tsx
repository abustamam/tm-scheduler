// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FOUNDER_BLURB } from "#/lib/brand";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { FounderNote } from "./founder-note";

afterEach(cleanup);

describe("FounderNote", () => {
	it("renders the canonical FOUNDER_BLURB", async () => {
		await renderUnderMemoryRouter(<FounderNote />);
		expect(screen.getByText(FOUNDER_BLURB)).toBeTruthy();
	});

	it("merges a caller's className onto its own", async () => {
		await renderUnderMemoryRouter(<FounderNote className="mt-4" />);
		const el = screen.getByText(FOUNDER_BLURB).closest("p");
		expect(el?.className).toContain("mt-4");
		expect(el?.className).toContain("text-sm");
	});

	// #869 AC4: every page that renders the note links to /about, because the
	// link lives in the component rather than at each call site.
	it("links to /about inside the note", async () => {
		await renderUnderMemoryRouter(<FounderNote />);
		const link = screen.getByRole("link", { name: /More about GavelUp/ });
		expect(link.getAttribute("href")).toBe("/about");
		expect(link.closest("p")).toBe(
			screen.getByText(FOUNDER_BLURB).closest("p"),
		);
	});
});
