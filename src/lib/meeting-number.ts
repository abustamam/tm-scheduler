// Meeting numbering (#358). Clubs number their meetings ("Meeting #56") and
// read the number out at the top of the agenda.
//
// The model: a number is STORED once a meeting is done, and DERIVED before that.
// Meetings are created in batches ahead of time by the #190 read-triggered
// top-up, so stamping numbers at insert would be wrong — cancel one meeting for
// a holiday and every later stored number is off by one. Instead the most recent
// meeting carrying a stored number acts as an ANCHOR, and later un-numbered
// meetings derive their number by counting forward from it. Cancelled meetings
// don't consume a number.

export type MeetingNumberRow = {
	id: string;
	status: "scheduled" | "cancelled" | "completed";
	/** The stored number. NULL = provisional (derive it). */
	meetingNumber: number | null;
};

/**
 * The number to display for `targetId`, or null when none can be determined.
 * `rows` must be the club's meetings ordered by `scheduledAt` ASCENDING.
 */
export function deriveMeetingNumber(
	rows: MeetingNumberRow[],
	targetId: string,
): number | null {
	const idx = rows.findIndex((r) => r.id === targetId);
	if (idx === -1) return null;
	const target = rows[idx];
	if (target.meetingNumber != null) return target.meetingNumber;
	// A meeting the club didn't hold isn't numbered at all.
	if (target.status === "cancelled") return null;

	// Walk back to the NEAREST preceding meeting that carries a stored number,
	// then count the meetings actually held from there to the target.
	for (let i = idx - 1; i >= 0; i--) {
		const anchor = rows[i];
		if (anchor.meetingNumber == null) continue;
		let held = 0;
		for (let j = i + 1; j <= idx; j++) {
			if (rows[j].status !== "cancelled") held++;
		}
		return anchor.meetingNumber + held;
	}
	return null;
}
