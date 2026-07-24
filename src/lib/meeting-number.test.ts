// src/lib/meeting-number.test.ts
import { describe, expect, it } from "vitest";
import { deriveMeetingNumber, type MeetingNumberRow } from "./meeting-number";

/** A meeting row in club order. `n` is the STORED number (null = provisional). */
function m(
	id: string,
	n: number | null = null,
	status: MeetingNumberRow["status"] = "scheduled",
): MeetingNumberRow {
	return { id, status, meetingNumber: n };
}

describe("deriveMeetingNumber", () => {
	it("returns the stored number when the meeting has one", () => {
		const rows = [m("a", 56)];
		expect(deriveMeetingNumber(rows, "a")).toBe(56);
	});

	it("derives the next number from the preceding numbered meeting", () => {
		// The exact scenario from #358: last night's meeting is numbered 56, the
		// next meeting already exists un-numbered and should read 57.
		const rows = [m("a", 56), m("b")];
		expect(deriveMeetingNumber(rows, "b")).toBe(57);
	});

	it("keeps counting across several un-numbered meetings", () => {
		const rows = [m("a", 56), m("b"), m("c"), m("d")];
		expect(deriveMeetingNumber(rows, "c")).toBe(58);
		expect(deriveMeetingNumber(rows, "d")).toBe(59);
	});

	it("does not let a cancelled meeting consume a number", () => {
		// A holiday cancellation between the anchor and the target: the target is
		// still the very next meeting the club actually holds.
		const rows = [m("a", 56), m("b", null, "cancelled"), m("c")];
		expect(deriveMeetingNumber(rows, "c")).toBe(57);
	});

	it("returns null for a cancelled meeting", () => {
		const rows = [m("a", 56), m("b", null, "cancelled")];
		expect(deriveMeetingNumber(rows, "b")).toBeNull();
	});

	it("anchors on the NEAREST preceding numbered meeting", () => {
		// A stale/wrong older number must not win over the recent one.
		const rows = [m("a", 10), m("b", 56), m("c")];
		expect(deriveMeetingNumber(rows, "c")).toBe(57);
	});

	it("returns null when nothing before the meeting is numbered", () => {
		// A club that has never entered a number gets no number at all — we never
		// invent a sequence (and never derive backwards from a later anchor).
		const rows = [m("a"), m("b"), m("c", 56)];
		expect(deriveMeetingNumber(rows, "a")).toBeNull();
		expect(deriveMeetingNumber(rows, "b")).toBeNull();
	});

	it("returns null for a meeting that is not in the list", () => {
		expect(deriveMeetingNumber([m("a", 56)], "nope")).toBeNull();
	});
});
