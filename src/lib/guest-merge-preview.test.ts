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

describe("summarizeMergePreview table coverage (#1609)", () => {
	it("counts every table the merge moves under some line, except import bookkeeping", () => {
		// protects=a table in the merge's table list cannot be silently left out of the confirm wording;
		// fails_when=a table maps to no line (its rows move but the admin is never told);
		// no_claim=the type-level guarantee (TABLE_LINE is a Record over GuestMergeTable, so a new table fails typecheck)
		const tables = [
			"meeting_attendance",
			"role_slots",
			"slot_cover_requests",
			"speeches",
			"meeting_awards",
			"table_topics_speakers",
			"meeting_votes",
			"meeting_ballot_guests",
			"meeting_candidate_disqualifications",
			"guest_invites",
			"meeting_guest_rsvps",
		];
		const out = summarizeMergePreview({
			moved: Object.fromEntries(tables.map((t) => [t, 1])),
			droppedAsDuplicate: {},
			absorbedPersonDeleted: false,
			refusal: null,
		});
		const total = out.moved.reduce((n, l) => n + Number.parseInt(l, 10), 0);
		expect(total).toBe(tables.length);
		expect(
			summarizeMergePreview({
				moved: { import_refs: 4 },
				droppedAsDuplicate: {},
				absorbedPersonDeleted: false,
				refusal: null,
			}).moved,
		).toEqual([]);
	});
});
