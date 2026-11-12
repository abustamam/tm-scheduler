// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CALL_CONTROLS_STORAGE_KEY,
	callControlsInset,
	callControlsLabel,
	nextCallControlsEdge,
	parseCallControlsEdge,
	readCallControlsEdge,
	writeCallControlsEdge,
} from "./call-controls-band";

afterEach(() => {
	window.localStorage.clear();
	vi.restoreAllMocks();
});

describe("call-controls band", () => {
	// protects=the cycle order the Z key and the button walk; fails_when=an edge
	// is skipped, repeated or the last one does not wrap to none; no_claim=none
	// beyond protects.
	it("cycles none, top, right, bottom, left, none", () => {
		expect(nextCallControlsEdge("none")).toBe("top");
		expect(nextCallControlsEdge("top")).toBe("right");
		expect(nextCallControlsEdge("right")).toBe("bottom");
		expect(nextCallControlsEdge("bottom")).toBe("left");
		expect(nextCallControlsEdge("left")).toBe("none");
	});

	// protects=a stored value only ever becomes a real edge; fails_when=null or
	// garbage is passed through instead of none; no_claim=none beyond protects.
	it("parses each valid value and falls back to none", () => {
		for (const e of ["none", "top", "right", "bottom", "left"] as const) {
			expect(parseCallControlsEdge(e)).toBe(e);
		}
		expect(parseCallControlsEdge(null)).toBe("none");
		expect(parseCallControlsEdge("diagonal")).toBe("none");
		expect(parseCallControlsEdge("")).toBe("none");
	});

	// protects=fixed pixel band: 72 top/bottom, 260 left/right, other sides 0;
	// fails_when=a band is the wrong size or lands on the wrong side;
	// no_claim=no layout: jsdom cannot show the slide clears the band.
	it("insets by a fixed pixel band per edge", () => {
		const zero = { top: 0, right: 0, bottom: 0, left: 0 };
		expect(callControlsInset("none")).toEqual(zero);
		expect(callControlsInset("top")).toEqual({ ...zero, top: 72 });
		expect(callControlsInset("bottom")).toEqual({ ...zero, bottom: 72 });
		expect(callControlsInset("left")).toEqual({ ...zero, left: 260 });
		expect(callControlsInset("right")).toEqual({ ...zero, right: 260 });
	});

	// protects=generic wording, off for none; fails_when=none reads "none" or a
	// product name appears; no_claim=none beyond protects.
	it("labels generically", () => {
		expect(callControlsLabel("top")).toBe("Space for call controls: top");
		expect(callControlsLabel("none")).toBe("Space for call controls: off");
	});

	// protects=the stored edge survives a reload under the spec's key;
	// fails_when=write or read uses another key or the default is not none;
	// no_claim=jsdom localStorage stands in for the browser's.
	it("round-trips through localStorage and defaults to none", () => {
		expect(readCallControlsEdge()).toBe("none");
		writeCallControlsEdge("left");
		expect(window.localStorage.getItem(CALL_CONTROLS_STORAGE_KEY)).toBe("left");
		expect(readCallControlsEdge()).toBe("left");
	});

	// protects=blocked storage never throws; fails_when=read or write throws;
	// no_claim=a mocked Storage stands in for a private window.
	it("survives storage that throws", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		expect(readCallControlsEdge()).toBe("none");
		expect(() => writeCallControlsEdge("top")).not.toThrow();
	});
});
