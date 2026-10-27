import { describe, expect, it } from "vitest";
import { markedAbsentMemberIds } from "#/lib/marked-absent-member-ids";

describe("markedAbsentMemberIds (#1344)", () => {
	it("marks an unavailable member who gave no answer", () => {
		// protects=a member the roll marked Absent, with no plan answer at all, is
		//   told "marked absent" rather than "you said you can't make it"
		// fails_when=the helper returns [] or drops members with no rung
		// no_claim=the card wording (meeting-agenda-absent-copy.test.tsx)
		expect(markedAbsentMemberIds(["m1"], [])).toEqual(["m1"]);
	});

	it("marks an unavailable member whose answer is coming", () => {
		// protects=Absent on the roll after the member said Coming: the roll wins
		//   for availability, and the member did not say they would miss it
		// fails_when=any answer at all, not just not_coming, clears the mark
		// no_claim=that the roll is what made them unavailable (the caller's input)
		expect(
			markedAbsentMemberIds(["m1"], [{ memberId: "m1", status: "coming" }]),
		).toEqual(["m1"]);
	});

	it("marks an unavailable member whose rung is only reached_out", () => {
		// protects=the officer's ask is not the member's answer, so it never
		//   subtracts, even if an upstream filter stopped dropping those rows
		// fails_when=reached_out is treated as an answer that clears the mark
		// no_claim=that the public payload carries reached_out (it does not)
		expect(
			markedAbsentMemberIds(
				["m1"],
				[{ memberId: "m1", status: "reached_out" }],
			),
		).toEqual(["m1"]);
	});

	it("does not mark a member who said not_coming, whatever the roll says", () => {
		// protects=the member's own decline keeps "you said you can't make it", also
		//   when the roll later recorded them Absent or Excused (still unavailable)
		// fails_when=the subtraction keys on the wrong status or the wrong member
		// no_claim=what the roll holds: the helper never sees it
		expect(
			markedAbsentMemberIds(
				["m1", "m2"],
				[{ memberId: "m1", status: "not_coming" }],
			),
		).toEqual(["m2"]);
	});

	it("subtracts per member, not per list", () => {
		// protects=one member's not_coming never clears a different member's mark
		// fails_when=the predicate drops the memberId comparison
		// no_claim=ordering of the result beyond the input's
		expect(
			markedAbsentMemberIds(
				["m1", "m2", "m3"],
				[
					{ memberId: "m2", status: "not_coming" },
					{ memberId: "m9", status: "not_coming" },
					{ memberId: "m3", status: "coming" },
				],
			),
		).toEqual(["m1", "m3"]);
	});

	it("is empty for a non-member's plan-only list where every id said not_coming", () => {
		// protects=the signed-out and non-member reader, whose unavailable list comes
		//   from the plan alone, gets no marked-absent ids at all
		// fails_when=the helper returns its input unchanged
		// no_claim=that a non-member sees the own-card copy (they have no card)
		const unavailable = ["m1", "m2"];
		expect(
			markedAbsentMemberIds(unavailable, [
				{ memberId: "m1", status: "not_coming" },
				{ memberId: "m2", status: "not_coming" },
			]),
		).toEqual([]);
	});

	it("returns a new array and leaves its inputs alone", () => {
		// protects=the route's own unavailableMemberIds is passed to sibling
		//   components after this call and must not be mutated
		// fails_when=the helper splices or sorts its input in place
		// no_claim=referential stability across renders (the route recomputes)
		const unavailable = ["m1", "m2"];
		const rungs = [{ memberId: "m1", status: "not_coming" as const }];
		const out = markedAbsentMemberIds(unavailable, rungs);
		expect(out).not.toBe(unavailable);
		expect(unavailable).toEqual(["m1", "m2"]);
		expect(rungs).toEqual([{ memberId: "m1", status: "not_coming" }]);
	});
});
