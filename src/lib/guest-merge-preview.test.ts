import { describe, expect, it } from "vitest";
import { summarizeMergePreview } from "./guest-merge-preview";

describe("summarizeMergePreview (#1609)", () => {
	it("words the moved rows per kind, sums the tables behind a line, and totals the dropped duplicates", () => {
		// protects=the counts the admin confirms against: grouped per recognisable kind, singular/plural right, zero kinds omitted, every dropped table counted;
		// fails_when=a table is left out of its line (a role-cover or DQ count vanishes), a zero line is shown, or dropped duplicates are not summed;
		// no_claim=that the numbers are right (the server computes them; guest-merge.integration.test.ts)
		const out = summarizeMergePreview({
			moved: {
				meeting_attendance: 3,
				role_slots: 1,
				slot_cover_requests: 1,
				speeches: 1,
				meeting_votes: 1,
				meeting_candidate_disqualifications: 1,
				meeting_awards: 0,
			},
			droppedAsDuplicate: { meeting_attendance: 1, guest_invites: 1 },
			absorbedPersonDeleted: false,
			refusal: null,
		});
		expect(out.moved).toEqual([
			"3 attendance records",
			"2 roles",
			"1 speech",
			"2 votes and ballots",
		]);
		expect(out.duplicatesDropped).toBe(2);
	});
});
