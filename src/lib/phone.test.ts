import { describe, expect, it } from "vitest";
import { toE164, toStoredPhone } from "./phone";

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

describe("toStoredPhone", () => {
	it("stores E.164 when the number can be normalized", () => {
		expect(toStoredPhone("+1 (415) 555-2671")).toBe("+14155552671");
		expect(toStoredPhone("0044 20 7946 0958")).toBe("+442079460958");
		expect(toStoredPhone("415-555-2671", "+1")).toBe("+14155552671");
	});

	it("preserves the trimmed raw number when E.164 can't be derived (no default)", () => {
		// A bare national number with no club default can't be made reliable — but
		// we must not drop the user's input; keep it as entered (trimmed).
		expect(toStoredPhone("415-555-2671")).toBe("415-555-2671");
		expect(toStoredPhone("  415-555-2671  ", null)).toBe("415-555-2671");
	});

	it("returns null for empty / contentless input", () => {
		expect(toStoredPhone("")).toBeNull();
		expect(toStoredPhone(null)).toBeNull();
		expect(toStoredPhone(undefined, "+1")).toBeNull();
		expect(toStoredPhone("   ", "+1")).toBeNull();
	});
});
