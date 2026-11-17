import { describe, expect, it } from "vitest";
import type { QueuedOp } from "./offline-minutes-queue";
import {
	type AwardOp,
	type AwardWinner,
	projectAwards,
} from "./project-awards";

const set = (
	category: AwardOp extends { category: infer C } ? C : never,
	name: string,
	queuedAt: number,
): AwardOp => ({
	type: "setAward",
	opId: `s${queuedAt}`,
	queuedAt,
	category,
	name,
	isGuest: false,
});
const clear = (
	category: AwardOp extends { category: infer C } ? C : never,
	queuedAt: number,
): AwardOp => ({
	type: "clearAward",
	opId: `c${queuedAt}`,
	queuedAt,
	category,
});

const TT: AwardWinner = { category: "best_table_topics", name: "Tess" };

describe("projectAwards (#1654, D7)", () => {
	// protects=a queued set replaces a fetched winner; fails_when=fetched wins
	// over the queue; no_claim=who typed it.
	it("a queued set takes its category with the op's name", () => {
		expect(
			projectAwards([TT], [set("best_table_topics", "Tom", 1)], []),
		).toEqual([{ category: "best_table_topics", name: "Tom" }]);
	});

	// protects=AC14: offline with nothing fetched still shows a queued award;
	// fails_when=null fetched short-circuits to []; no_claim=nothing about auth.
	it("a queued set with nothing fetched (null) still projects", () => {
		expect(projectAwards(null, [set("best_speaker", "Sam", 1)], [])).toEqual([
			{ category: "best_speaker", name: "Sam" },
		]);
	});

	// protects=AC15: a queued clear removes a fetched winner; fails_when=clears
	// are ignored; no_claim=the clear reaching the server.
	it("a queued clear removes the fetched winner", () => {
		expect(projectAwards([TT], [clear("best_table_topics", 1)], [])).toEqual(
			[],
		);
	});

	// protects=queue order decides, not array order; fails_when=ops apply in
	// array order; no_claim=ties (same queuedAt keep array order).
	it("applies set-then-clear and clear-then-set in queuedAt order", () => {
		expect(
			projectAwards(
				null,
				[clear("best_speaker", 2), set("best_speaker", "Sam", 1)],
				[],
			),
		).toEqual([]);
		expect(
			projectAwards(
				null,
				[set("best_speaker", "Sam", 2), clear("best_speaker", 1)],
				[],
			),
		).toEqual([{ category: "best_speaker", name: "Sam" }]);
	});

	// protects=AC16: a drained op keeps projecting until a fetch returns it, and
	// a fetched match does not duplicate; fails_when=overlay is ignored or
	// doubles the row; no_claim=when the overlay is dropped (hook test).
	it("projects overlay ops under the queue, and a fetched match stays one row", () => {
		const overlay = [set("best_table_topics", "Tess", 1)];
		expect(projectAwards(null, [], overlay)).toEqual([TT]);
		expect(projectAwards([TT], [], overlay)).toEqual([TT]);
		// A queued op is newer than the overlay.
		expect(
			projectAwards(null, [set("best_table_topics", "Tom", 5)], overlay),
		).toEqual([{ category: "best_table_topics", name: "Tom" }]);
	});

	// protects=non-award ops are inert and blank names drop, output in
	// AWARD_CATEGORIES order; fails_when=a role op throws/changes the result, or
	// a blank name is revealed; no_claim=role projection (project-slots).
	it("ignores non-award ops, drops blank names and orders by category", () => {
		const roleOp = {
			type: "releaseSlot",
			opId: "r",
			queuedAt: 1,
			slotId: "x",
		} as unknown as QueuedOp;
		const out = projectAwards(
			[TT],
			[roleOp, set("best_speaker", "  ", 2), set("best_evaluator", "Eve", 3)],
			[],
		);
		expect(out.map((w) => w.category)).toEqual([
			"best_evaluator",
			"best_table_topics",
		]);
	});
});
