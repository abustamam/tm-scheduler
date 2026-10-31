// The meeting row a NON-MEMBER's detail payload may carry (#1444, D6).
//
// The video-call join link is a key to the door (#731): anyone holding it can
// walk into the call and there is no revocation short of a new room. It used to
// ride the meeting detail payload to everyone, and the page merely chose not to
// draw it for a stranger, but TanStack Start dehydrates loader data into the
// served document, so the URL was in view-source of a signed-out visit. A
// stranger now gets a link to the RSVP page instead, and the URL comes back
// only on the RSVP confirmation.
//
// An ALLOWLIST, the pattern of `in-room-meeting-payload.ts`, and for the same
// reason: a `delete meeting.joinUrl` is blind to the next column nobody thought
// about. A `meetings` column reaches a non-member only by being named here.
// `meeting-join-url.guard.test.ts` fails on a column that is in neither list.

/** Every `meetings` column a non-member may carry. */
export const NON_MEMBER_MEETING_FIELDS = [
	"id",
	"clubId",
	"scheduledAt",
	"lengthMinutes",
	"digitalVotingDisabled",
	"location",
	"theme",
	"wordOfTheDay",
	"wodDefinition",
	"wodExample",
	"status",
	"meetingNumber",
	"templateId",
	"notes",
	"reminders",
	"tableTopicsNotes",
	"promoNote",
	"createdAt",
] as const;

/** Columns withheld from a non-member ON PURPOSE. Naming one here is the other
 *  way a new column passes the guard test. */
export const WITHHELD_MEETING_FIELDS = ["joinUrl"] as const;

/**
 * The meeting row narrowed to `NON_MEMBER_MEETING_FIELDS`. Typed as the row
 * without `joinUrl`: that is the only column withheld today, and the guard test
 * holds every other column to the allowlist, so the type stays true.
 */
export function nonMemberMeetingRow<M extends object>(
	meeting: M,
): Omit<M, (typeof WITHHELD_MEETING_FIELDS)[number]> {
	const kept: Record<string, unknown> = {};
	for (const field of NON_MEMBER_MEETING_FIELDS) {
		if (Object.hasOwn(meeting, field)) {
			kept[field] = (meeting as Record<string, unknown>)[field];
		}
	}
	return kept as Omit<M, (typeof WITHHELD_MEETING_FIELDS)[number]>;
}
