/**
 * What the guest merge dialog shows before the admin confirms (#1609): the
 * preview's per-table counts, folded into the lines a person reads. Pure, so the
 * wording is tested without a dialog. The preview's own numbers come from the
 * server (the same code the merge runs); this only groups and words them.
 */

import type {
	GuestMergeTable,
	MergeGuestsPreview,
} from "#/server/guest-merge-logic";

/** The server's preview shape. `import type` is erased, so `lib/` still ships nothing server-side. */
export type MergePreviewCounts = MergeGuestsPreview;

/**
 * Which line each merged table is worded under (`null`: nothing a person
 * recognises, e.g. import bookkeeping). A `Record` over the merge's own table
 * list, so a table added to `GUEST_MERGE_TABLES` without wording fails typecheck.
 */
const TABLE_LINE: Record<GuestMergeTable, string | null> = {
	meeting_attendance: "attendance",
	role_slots: "roles",
	slot_cover_requests: "roles",
	speeches: "speeches",
	meeting_awards: "awards",
	table_topics_speakers: "topics",
	meeting_votes: "votes",
	meeting_ballot_guests: "votes",
	meeting_candidate_disqualifications: "votes",
	guest_invites: "invites",
	meeting_guest_rsvps: "rsvps",
	import_refs: null,
};

/** One line per thing the admin recognises, summing the tables behind it. */
const LINES: Array<{ id: string; label: [string, string] }> = [
	{ id: "attendance", label: ["attendance record", "attendance records"] },
	{ id: "roles", label: ["role", "roles"] },
	{ id: "speeches", label: ["speech", "speeches"] },
	{ id: "awards", label: ["award", "awards"] },
	{ id: "topics", label: ["Table Topics turn", "Table Topics turns"] },
	{ id: "votes", label: ["vote or ballot", "votes and ballots"] },
	{ id: "invites", label: ["invite", "invites"] },
	{ id: "rsvps", label: ["RSVP", "RSVPs"] },
];

/** The tables worded under one line. */
export const tablesForLine = (id: string): GuestMergeTable[] =>
	(Object.keys(TABLE_LINE) as GuestMergeTable[]).filter(
		(t) => TABLE_LINE[t] === id,
	);

const sum = (
	counts: Record<string, number>,
	tables: GuestMergeTable[],
): number => tables.reduce((n, t) => n + (counts[t] ?? 0), 0);

export interface MergePreviewSummary {
	/** "3 attendance records", only for the kinds that move at least one. */
	moved: string[];
	/** Same-meeting duplicates the keeper's own rows replace, all tables. */
	duplicatesDropped: number;
}

export function summarizeMergePreview(
	preview: MergePreviewCounts,
): MergePreviewSummary {
	const moved: string[] = [];
	for (const line of LINES) {
		const n = sum(preview.moved, tablesForLine(line.id));
		if (n > 0) moved.push(`${n} ${n === 1 ? line.label[0] : line.label[1]}`);
	}
	const duplicatesDropped = Object.values(preview.droppedAsDuplicate).reduce(
		(a, b) => a + b,
		0,
	);
	return { moved, duplicatesDropped };
}
