/**
 * Pure unit tests for the role-sheet speaker-label model (#311). `speakerLabels`
 * is the single source of the names pre-filled into the Timer / Ah-Counter
 * sheets, so these tests pin the rule: only *assigned speaker* slots appear (open
 * slots leave blank rows), in agenda order, with the speech title when set.
 */
import { describe, expect, it, vi } from "vitest";

// role-sheets-pdf-logic imports #/db (via minutes-logic) at the top level; mock
// it so this pure-unit test runs without a DATABASE_URL and without Postgres.
vi.mock("#/db", () => ({ db: {} }));

import type { MinutesProgramRow } from "./minutes-logic";
import { speakerLabels } from "./role-sheets-pdf-logic";

function row(p: Partial<MinutesProgramRow>): MinutesProgramRow {
	return {
		slotId: "slot",
		roleName: "Speaker",
		category: "speaker",
		assigneeName: null,
		isGuest: false,
		speechTitle: null,
		...p,
	};
}

describe("speakerLabels (#311)", () => {
	it("keeps only assigned speaker slots, in order", () => {
		const program = [
			row({ category: "speaker", assigneeName: "Alice" }),
			row({ category: "evaluator", assigneeName: "Ed" }),
			row({ category: "speaker", assigneeName: "Bob" }),
		];
		expect(speakerLabels(program)).toEqual(["Alice", "Bob"]);
	});

	it("drops open speaker slots (no assignee) so their rows stay blank", () => {
		const program = [
			row({ category: "speaker", assigneeName: "Alice" }),
			row({ category: "speaker", assigneeName: null }),
		];
		expect(speakerLabels(program)).toEqual(["Alice"]);
	});

	it("appends the speech title in quotes when set", () => {
		const program = [
			row({ assigneeName: "Alice", speechTitle: "My Icebreaker" }),
			row({ assigneeName: "Bob", speechTitle: null }),
		];
		expect(speakerLabels(program)).toEqual(['Alice — "My Icebreaker"', "Bob"]);
	});

	it("returns an empty list for a program with no assigned speakers", () => {
		expect(speakerLabels([])).toEqual([]);
		expect(
			speakerLabels([row({ category: "evaluator", assigneeName: "Ed" })]),
		).toEqual([]);
	});
});
