/**
 * What the guest merge dialog shows before the admin confirms (#1609): the
 * preview's per-table counts, folded into the lines a person reads. Pure, so the
 * wording is tested without a dialog. The preview's own numbers come from the
 * server (the same code the merge runs); this only groups and words them.
 */

/** The shape `previewMergeGuests` returns; restated so `lib/` imports nothing server-side. */
export interface MergePreviewCounts {
	moved: Record<string, number>;
	droppedAsDuplicate: Record<string, number>;
	absorbedPersonDeleted: boolean;
	refusal: string | null;
}

/** One line per thing the admin recognises, summing the tables behind it. */
const LINES: Array<{ label: [string, string]; tables: string[] }> = [
	{
		label: ["attendance record", "attendance records"],
		tables: ["meeting_attendance"],
	},
	{ label: ["role", "roles"], tables: ["role_slots", "slot_cover_requests"] },
	{ label: ["speech", "speeches"], tables: ["speeches"] },
	{ label: ["award", "awards"], tables: ["meeting_awards"] },
	{
		label: ["Table Topics turn", "Table Topics turns"],
		tables: ["table_topics_speakers"],
	},
	{
		label: ["vote or ballot", "votes and ballots"],
		tables: [
			"meeting_votes",
			"meeting_ballot_guests",
			"meeting_candidate_disqualifications",
		],
	},
	{ label: ["invite", "invites"], tables: ["guest_invites"] },
	{ label: ["RSVP", "RSVPs"], tables: ["meeting_guest_rsvps"] },
];

const sum = (counts: Record<string, number>, tables: string[]): number =>
	tables.reduce((n, t) => n + (counts[t] ?? 0), 0);

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
		const n = sum(preview.moved, line.tables);
		if (n > 0) moved.push(`${n} ${n === 1 ? line.label[0] : line.label[1]}`);
	}
	const duplicatesDropped = Object.values(preview.droppedAsDuplicate).reduce(
		(a, b) => a + b,
		0,
	);
	return { moved, duplicatesDropped };
}
