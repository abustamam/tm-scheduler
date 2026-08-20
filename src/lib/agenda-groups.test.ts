// src/lib/agenda-groups.test.ts
import { describe, expect, it } from "vitest";
import { groupByPresenter } from "./agenda-groups";
import type { TimelineRow } from "./agenda-timing";

function row(over: Partial<TimelineRow> & { time: string }): TimelineRow {
	return {
		who: "President",
		detail: "",
		minutes: 2,
		marks: null,
		...over,
	};
}

describe("groupByPresenter", () => {
	it("merges a run of consecutive rows with the same presenter", () => {
		// The real MCF close (#442/#352): three President beats in a row.
		const groups = groupByPresenter([
			row({ time: "7:44", detail: "Club business · announcements" }),
			row({ time: "7:46", detail: "Guest Comments" }),
			row({ time: "7:48", detail: "Adjourns" }),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0].who).toBe("President");
		expect(groups[0].rows.map((r) => r.time)).toEqual(["7:44", "7:46", "7:48"]);
	});

	it("wraps a lone row in a group of one, so the renderer sees one shape", () => {
		const groups = groupByPresenter([
			row({ time: "6:45", who: "Sergeant-at-Arms" }),
			row({ time: "6:46", who: "President" }),
		]);
		expect(groups).toHaveLength(2);
		expect(groups.map((g) => g.rows.length)).toEqual([1, 1]);
		expect(groups.map((g) => g.who)).toEqual(["Sergeant-at-Arms", "President"]);
	});

	it("only merges rows that are ADJACENT — a run that resumes later is a new group", () => {
		// Guards against a keyed/bucketed implementation, which would pull the
		// 7:42 Toastmaster row up next to the 6:47 one and reorder the meeting.
		const groups = groupByPresenter([
			row({ time: "6:47", who: "Toastmaster of the Day · Ali" }),
			row({ time: "6:50", who: "General Evaluator · Faisal" }),
			row({ time: "7:42", who: "Toastmaster of the Day · Ali" }),
		]);
		expect(groups).toHaveLength(3);
		expect(groups.flatMap((g) => g.rows.map((r) => r.time))).toEqual([
			"6:47",
			"6:50",
			"7:42",
		]);
	});

	// A hand-off is a real event between two beats — the Toastmaster introducing
	// the next segment. Absorbing it into a group would render it as one of the
	// presenter's own detail lines and lose the `HandoffBand`.
	it("never merges a hand-off row, and a hand-off breaks a run", () => {
		const groups = groupByPresenter([
			row({ time: "7:20", who: "Toastmaster of the Day · Ali" }),
			row({
				time: "7:20",
				who: "Toastmaster of the Day · Ali",
				handoff: true,
				minutes: 0,
			}),
			row({ time: "7:21", who: "Toastmaster of the Day · Ali" }),
		]);
		expect(groups).toHaveLength(3);
		expect(groups[1].rows[0].handoff).toBe(true);
	});

	it("keeps two consecutive hand-offs apart rather than merging them together", () => {
		// The real agenda has exactly this: the Table Topics Master hands to the
		// General Evaluator, who immediately hands to the evaluators.
		const groups = groupByPresenter([
			row({ time: "7:26", who: "A", handoff: true, minutes: 0 }),
			row({ time: "7:26", who: "A", handoff: true, minutes: 0 }),
		]);
		expect(groups).toHaveLength(2);
	});

	// The section guard (#agenda-templates). Sections carry `roleKey: null` and
	// put the segment TITLE in `who`, so the `who === who && roleKey === roleKey`
	// test below already separates the sections a real contest emits — every one
	// of them has a distinct title. That makes the guard unfalsifiable against
	// any realistic fixture: delete `if (prev.section || row.section)` and the
	// rest of this file still passes. The case that actually reaches it is two
	// adjacent rows AGREEING on `who` where at least one is a band — a section
	// header immediately followed by an unowned event of the same name, which a
	// template can express and which would otherwise swallow the band.
	it("never merges a section band into the row beside it, even on an exact `who` match", () => {
		const groups = groupByPresenter([
			row({ time: "8:00", who: "BREAK", section: true, minutes: 0 }),
			row({ time: "8:00", who: "BREAK", minutes: 10 }),
		]);
		expect(groups).toHaveLength(2);
		expect(groups[0].rows[0].section).toBe(true);
		expect(groups[1].rows[0].section).toBeUndefined();
	});

	it("keeps two consecutive section bands apart", () => {
		const groups = groupByPresenter([
			row({ time: "8:00", who: "CONTEST", section: true, minutes: 0 }),
			row({ time: "8:00", who: "CONTEST", section: true, minutes: 0 }),
		]);
		expect(groups).toHaveLength(2);
	});

	// `beatColor` and `isHighlighted` branch on `roleKey`, so a group has to be
	// homogeneous in it — otherwise one spine colour would stand for two roles.
	it("breaks a run when roleKey differs, even though `who` matches", () => {
		const groups = groupByPresenter([
			row({ time: "7:00", who: "Coach", roleKey: "speaker" }),
			row({ time: "7:05", who: "Coach", roleKey: "grammarian" }),
		]);
		expect(groups).toHaveLength(2);
	});

	it("treats absent and null roleKey as the same key", () => {
		// Event beats (President, Sergeant-at-Arms) omit `roleKey` entirely, while
		// a row built field-by-field may carry an explicit null. Splitting on that
		// difference would break the President run for no user-visible reason.
		const groups = groupByPresenter([
			row({ time: "7:44" }),
			row({ time: "7:46", roleKey: null }),
		]);
		expect(groups).toHaveLength(1);
	});

	it("carries every row through unchanged, in order, exactly once", () => {
		const rows = [
			row({ time: "6:53", who: "Speaker 1 · Jag", roleKey: "speaker" }),
			row({
				time: "7:21",
				who: "TTM · R",
				roleKey: "table_topics_master",
				marks: { green: 1, yellow: 2, red: 3 },
			}),
			row({ time: "7:26", who: "TTM · R", roleKey: "table_topics_master" }),
		];
		const flattened = groupByPresenter(rows).flatMap((g) => g.rows);
		expect(flattened).toEqual(rows);
	});

	// Merging must not swallow the timing trio: it belongs to ONE beat, and the
	// renderer prints it on that beat's own line.
	it("preserves per-row marks inside a merged group", () => {
		const groups = groupByPresenter([
			row({
				time: "7:21",
				who: "TTM",
				marks: { green: 1, yellow: 2, red: 3 },
			}),
			row({ time: "7:26", who: "TTM" }),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0].rows[0].marks).toEqual({ green: 1, yellow: 2, red: 3 });
		expect(groups[0].rows[1].marks).toBeNull();
	});

	it("returns no groups for no rows", () => {
		expect(groupByPresenter([])).toEqual([]);
	});
});
