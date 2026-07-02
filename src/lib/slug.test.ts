import { describe, expect, it } from "vitest";
import { slugify } from "./slug";

describe("slugify", () => {
	it("lowercases and hyphenates", () => {
		expect(slugify("Downtown Speakers")).toBe("downtown-speakers");
	});
	it("collapses runs of non-alphanumerics to a single hyphen", () => {
		expect(slugify("MCF   Toastmasters!!")).toBe("mcf-toastmasters");
	});
	it("trims leading/trailing separators", () => {
		expect(slugify("  --Hello, World--  ")).toBe("hello-world");
	});
	it("lowercases a plain name", () => {
		expect(slugify("MCF")).toBe("mcf");
	});
	it("returns empty string for all-punctuation input", () => {
		expect(slugify("!!!")).toBe("");
	});
});
