// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	captureRef,
	isValidRef,
	REF_STORAGE_KEY,
	readRef,
} from "./marketing-ref";

beforeEach(() => {
	window.sessionStorage.clear();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("marketing ref attribution (#866)", () => {
	it("stores the first valid ref and does not let a later one overwrite it", () => {
		captureRef("?ref=district-57");
		expect(readRef()).toBe("district-57");

		captureRef("?ref=other");
		expect(readRef()).toBe("district-57");
		expect(window.sessionStorage.getItem(REF_STORAGE_KEY)).toBe("district-57");
	});

	it("ignores an invalid ref, and a later valid one is then still captured", () => {
		for (const bad of ["?ref=UPPER", "?ref=has%20space", "?ref=", "?nope=1"]) {
			captureRef(bad);
			expect(readRef(), bad).toBeNull();
		}
		expect(isValidRef("a".repeat(65))).toBe(false);
		expect(isValidRef("a".repeat(64))).toBe(true);

		captureRef("?ref=club-share");
		expect(readRef()).toBe("club-share");
	});

	it("swallows storage that throws (private mode, blocked site data)", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("SecurityError");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("SecurityError");
		});
		expect(() => captureRef("?ref=district-57")).not.toThrow();
		expect(readRef()).toBeNull();
	});

	it("is a no-op on the server (no window)", () => {
		vi.stubGlobal("window", undefined);
		expect(() => captureRef("?ref=district-57")).not.toThrow();
		expect(readRef()).toBeNull();
	});
});
