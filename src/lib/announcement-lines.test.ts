import { describe, expect, it } from "vitest";
import { announcementLines } from "./announcement-lines";

describe("announcementLines", () => {
	it("splits on newlines, trims each line, and drops blank lines", () => {
		expect(announcementLines("  Bring a guest  \n\nRenew dues\n")).toEqual([
			"Bring a guest",
			"Renew dues",
		]);
	});

	it("returns [] for null, undefined, or whitespace-only input", () => {
		expect(announcementLines(null)).toEqual([]);
		expect(announcementLines(undefined)).toEqual([]);
		expect(announcementLines("   \n  \t ")).toEqual([]);
	});
});
