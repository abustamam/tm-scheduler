/**
 * What an `assign_roles` call says it did (#809).
 *
 * These are the sentences a human reads, and the tool that produces them
 * imports `#/db` at load — so without this module they would be unassertable
 * (`CODING_STANDARDS.md`, "Test coverage"). The integration suite drives the
 * same functions through real rows; this pins the wording itself, which is the
 * half a database cannot make wrong.
 */
import { describe, expect, it } from "vitest";
import {
	changeLabel,
	findDuplicateSlots,
	MEETING_LOCKED_BLOCKING_MESSAGE,
	OPEN_LABEL,
	planLine,
	speechSentence,
} from "./assign-roles-plan";

describe("a plan line names the change (#809)", () => {
	it("fills an open slot: open → Sam", () => {
		const line = planLine({
			index: 0,
			slotId: "s1",
			role: "Timer",
			slotIndex: 0,
			from: OPEN_LABEL,
			to: "Sam",
		});
		expect(line.change).toBe("open → Sam");
		expect(line.from).toBe("open");
		// No speech moved, so the field is ABSENT rather than null — the plan
		// carries a sentence only when there is something to say, and `undefined`
		// is dropped by the canonicalizer while `null` would be a value the plan
		// asserts (`src/lib/mcp-plan.ts`).
		expect(line.speech).toBeUndefined();
		expect("speech" in line).toBe(false);
	});

	it("moves a held slot: Alex → Sam", () => {
		const line = planLine({
			index: 1,
			slotId: "s2",
			role: "Evaluator",
			slotIndex: 1,
			from: "Alex",
			to: "Sam",
		});
		expect(line.change).toBe("Alex → Sam");
		expect(line.slotIndex).toBe(1);
		expect(line.index).toBe(1);
	});

	it("clears a slot: Alex → open", () => {
		const line = planLine({
			index: 2,
			slotId: "s3",
			role: "Speaker",
			slotIndex: 0,
			from: "Alex",
			to: OPEN_LABEL,
		});
		expect(line.change).toBe("Alex → open");
		expect(line.to).toBe("open");
	});

	/**
	 * The sentence that keeps a release from reading like data loss.
	 *
	 * A release unlinks the speech and never deletes it (ADR-0009): it persists
	 * Person-owned and unscheduled. The plan has to say where it went, because
	 * the officer reading the plan is the only person positioned to notice that
	 * a speech came off a slot they were only reassigning.
	 */
	it("says where an unlinked speech goes, naming the member it belongs to", () => {
		const line = planLine({
			index: 0,
			slotId: "s4",
			role: "Speaker",
			slotIndex: 0,
			from: "Alex",
			to: OPEN_LABEL,
			unlinksSpeechTitled: "Ice Breaker",
		});
		expect(line.speech).toBe(
			`Alex's speech "Ice Breaker" returns to Alex's unscheduled speeches.`,
		);
		// The speech belongs to the person coming OFF the slot, never the one
		// arriving. A line that named `to` would be exactly backwards on the
		// reassign case, where both names are present and only one is right.
		expect(line.speech).not.toContain("open's");
		expect(speechSentence("Sam", "Pathways 1")).toBe(
			`Sam's speech "Pathways 1" returns to Sam's unscheduled speeches.`,
		);
	});

	it("says nothing about a speech when none is unlinked", () => {
		for (const unlinksSpeechTitled of [null, undefined]) {
			const line = planLine({
				index: 0,
				slotId: "s5",
				role: "Speaker",
				slotIndex: 0,
				from: "Alex",
				to: "Sam",
				unlinksSpeechTitled,
			});
			expect(line.speech).toBeUndefined();
		}
	});

	it("renders the arrow in one place", () => {
		expect(changeLabel("open", "Sam")).toBe("open → Sam");
	});

	// Pinned absolutely, and in a suite that runs without a database. The
	// integration case asserts it is NOT `MEETING_LOCKED_MESSAGE`, which is the
	// property that matters; on its own that passes for any value the constant
	// could hold, empty string included.
	it("states the lock refusal in its own words", () => {
		expect(MEETING_LOCKED_BLOCKING_MESSAGE).toContain(
			"no longer accepts changes",
		);
		expect(MEETING_LOCKED_BLOCKING_MESSAGE.length).toBeGreaterThan(20);
	});
});

describe("a slot named twice is a mistake, not a last-write-wins (#809)", () => {
	it("finds no duplicates in a clean batch", () => {
		expect(findDuplicateSlots(["a", "b", "c"])).toEqual([]);
	});

	it("groups every line that named the same slot", () => {
		// Grouped rather than one item per extra line, so the caller is told
		// which lines disagree — not only which one would have lost.
		expect(findDuplicateSlots(["a", "b", "a", "c", "a"])).toEqual([
			{ slotId: "a", indexes: [0, 2, 4] },
		]);
	});

	it("reports each duplicated slot separately", () => {
		expect(findDuplicateSlots(["a", "b", "b", "a"])).toEqual([
			{ slotId: "a", indexes: [0, 3] },
			{ slotId: "b", indexes: [1, 2] },
		]);
	});

	it("is empty for an empty batch", () => {
		expect(findDuplicateSlots([])).toEqual([]);
	});
});
