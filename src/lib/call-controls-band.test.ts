// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BAND_STORAGE_KEY,
	bandInsets,
	bandLabel,
	nextBandEdge,
	readBandEdge,
	writeBandEdge,
} from "./call-controls-band";

afterEach(() => {
	window.localStorage.clear();
	vi.restoreAllMocks();
});

describe("call-controls band", () => {
	it("cycles none, top, right, bottom, left, none", () => {
		expect(nextBandEdge("none")).toBe("top");
		expect(nextBandEdge("top")).toBe("right");
		expect(nextBandEdge("right")).toBe("bottom");
		expect(nextBandEdge("bottom")).toBe("left");
		expect(nextBandEdge("left")).toBe("none");
	});

	it("uses fixed pixel sizes: 72 top/bottom, 260 left/right", () => {
		expect(bandInsets("none")).toEqual({
			top: 0,
			right: 0,
			bottom: 0,
			left: 0,
		});
		expect(bandInsets("top").top).toBe(72);
		expect(bandInsets("bottom").bottom).toBe(72);
		expect(bandInsets("left").left).toBe(260);
		expect(bandInsets("right").right).toBe(260);
	});

	it("labels generically", () => {
		expect(bandLabel("top")).toBe("Space for call controls: top");
	});

	it("round-trips through localStorage and defaults to none", () => {
		expect(readBandEdge()).toBe("none");
		writeBandEdge("left");
		expect(readBandEdge()).toBe("left");
	});

	it("ignores a junk stored value", () => {
		window.localStorage.setItem(BAND_STORAGE_KEY, "diagonal");
		expect(readBandEdge()).toBe("none");
	});

	it("survives storage that throws", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		expect(readBandEdge()).toBe("none");
		expect(() => writeBandEdge("top")).not.toThrow();
	});
});
