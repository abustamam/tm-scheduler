import { describe, expect, it } from "vitest";
import { toE164 } from "./phone";

describe("toE164", () => {
	it("keeps an already-international number, stripping formatting", () => {
		expect(toE164("+1 (415) 555-2671")).toBe("+14155552671");
		expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
	});

	it("treats a 00 international prefix as +", () => {
		expect(toE164("0044 20 7946 0958")).toBe("+442079460958");
	});

	it("prepends the club default country code when the number lacks one", () => {
		expect(toE164("(415) 555-2671", "+1")).toBe("+14155552671");
		expect(toE164("415-555-2671", "1")).toBe("+14155552671");
	});

	it("returns null when no country code and no default (can't be made reliable)", () => {
		expect(toE164("415-555-2671")).toBeNull();
		expect(toE164("415-555-2671", null)).toBeNull();
	});

	it("returns null for empty / contentless input", () => {
		expect(toE164("")).toBeNull();
		expect(toE164(null)).toBeNull();
		expect(toE164("   ", "+1")).toBeNull();
		expect(toE164("n/a", "+1")).toBeNull();
	});

	it("does not double-prefix a number already starting with +", () => {
		expect(toE164("+14155552671", "+44")).toBe("+14155552671");
	});
});
