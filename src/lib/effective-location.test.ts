import { describe, expect, it } from "vitest";
import { effectiveLocation } from "./effective-location";

describe("effectiveLocation", () => {
	it("prefers the rule's location", () => {
		expect(effectiveLocation("Library", "Room 4")).toBe("Library");
	});
	it("falls back to the club default when the rule has none", () => {
		expect(effectiveLocation(null, "Room 4")).toBe("Room 4");
		expect(effectiveLocation(undefined, "Room 4")).toBe("Room 4");
	});
	it("is null when neither is known", () => {
		expect(effectiveLocation(null, null)).toBeNull();
		expect(effectiveLocation(undefined, undefined)).toBeNull();
	});
});
