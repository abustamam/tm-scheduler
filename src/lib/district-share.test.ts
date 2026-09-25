import { describe, expect, it } from "vitest";
import {
	buildDistrictShareLink,
	DISTRICT_SHARE_BLURB,
	isValidDistrict,
} from "#/lib/district-share";
import { isValidRef } from "#/lib/marketing-ref";

/** The `ref` query value a share link carries. */
const refOf = (link: string) =>
	new URL(link, "https://example.test").searchParams.get("ref");

describe("district-share (#868)", () => {
	it("accepts 1-4 letters or digits and nothing else", () => {
		for (const ok of ["57", "1", "F", "u", "123A", "0000"]) {
			expect(isValidDistrict(ok), ok).toBe(true);
		}
		for (const bad of ["", "5 7!", "12345", " 57", "57 ", "5-7", "5_7", "é"]) {
			expect(isValidDistrict(bad), JSON.stringify(bad)).toBe(false);
		}
	});

	it("builds the absolute share link, lowercasing the district", () => {
		expect(buildDistrictShareLink("https://gavelup.app", "57")).toBe(
			"https://gavelup.app/?ref=district-57",
		);
		expect(buildDistrictShareLink("https://gavelup.app", "F")).toBe(
			"https://gavelup.app/?ref=district-f",
		);
		// Before mount there is no origin: the relative path.
		expect(buildDistrictShareLink("", "57")).toBe("/?ref=district-57");
	});

	// The ref the builder mints must be one the server keeps, or the share link
	// attributes nothing.
	it("mints a ref that marketing-ref's validator accepts, for every valid district shape", () => {
		for (const d of ["57", "F", "zz99", "ABCD", "0"]) {
			const ref = refOf(buildDistrictShareLink("https://gavelup.app", d));
			expect(ref, d).not.toBeNull();
			expect(isValidRef(ref as string), `${d} -> ${ref}`).toBe(true);
		}
	});

	it("ends the blurb with the link and keeps its promises modest", () => {
		const link = "https://gavelup.app/?ref=district-57";
		const blurb = DISTRICT_SHARE_BLURB(link);
		expect(blurb.startsWith("Worth a look for your club:")).toBe(true);
		expect(blurb.endsWith(` ${link}`)).toBe(true);
		expect(blurb).toContain("free for clubs during the pilot");
	});
});
