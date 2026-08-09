import { describe, expect, it } from "vitest";
import type { MeetingPhase } from "#/lib/meeting-lifecycle";
import { showsMinutesPrimary } from "./meeting-anchors";

describe("showsMinutesPrimary (#541 review)", () => {
	// The toolbar's completed-phase Minutes CTA and the route's anchor section
	// (both the loaded-minutes branch and the getMinutes-degrade fallback)
	// must agree on exactly this condition — that is the whole point of
	// pulling it into one function instead of two matching spellings.
	it("completed + canManage: shows the primary", () => {
		expect(showsMinutesPrimary("completed", true)).toBe(true);
	});

	it("completed + !canManage: does not show the primary", () => {
		expect(showsMinutesPrimary("completed", false)).toBe(false);
	});

	it.each<MeetingPhase>([
		"today",
		"upcoming",
	])("%s + canManage: does not show the primary (phase must be completed)", (phase) => {
		expect(showsMinutesPrimary(phase, true)).toBe(false);
	});

	it.each<MeetingPhase>([
		"today",
		"upcoming",
	])("%s + !canManage: does not show the primary", (phase) => {
		expect(showsMinutesPrimary(phase, false)).toBe(false);
	});
});
