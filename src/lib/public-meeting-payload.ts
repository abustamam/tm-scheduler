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

/** The spellings of a join link worth removing from free text: as stored, with
 *  and without a trailing slash, and without its scheme. Longest first, so the
 *  scheme-less form never leaves an `https://` stub behind. */
function joinUrlSpellings(joinUrl: string): string[] {
	const noSlash = joinUrl.replace(/\/+$/, "");
	const noScheme = noSlash.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
	return [...new Set([joinUrl, noSlash, noScheme])]
		.filter((v) => v.length > 0)
		.sort((a, b) => b.length - a.length);
}

/**
 * A text field with the join link taken out. A club that pasted its video link
 * into `location` or the notes would otherwise hand the key to the door to the
 * stranger the allowlist was withholding it from. A field that was only the link
 * becomes null; one that held more keeps the rest with the gap closed.
 */
function withoutJoinUrl(text: string, spellings: string[]): string | null {
	let out = text;
	for (const spelling of spellings) {
		out = out.replace(
			// A trailing slash is the same link.
			new RegExp(`${spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/*`, "gi"),
			"",
		);
	}
	if (out === text) return text;
	const tidy = out
		.replace(/[ \t]+\n/g, "\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
	return tidy === "" ? null : tidy;
}

/**
 * The meeting row narrowed to `NON_MEMBER_MEETING_FIELDS`, with the row's own
 * join link also taken out of every free-text field it was kept in. Typed as the
 * row without `joinUrl`: that is the only column withheld today, and the guard
 * test holds every other column to the allowlist, so the type stays true.
 *
 * `location` is dropped outright when it held the link (a place that was only a
 * URL says nothing without it), the others keep the text around it.
 */
export function nonMemberMeetingRow<M extends object>(
	meeting: M,
): Omit<M, (typeof WITHHELD_MEETING_FIELDS)[number]> {
	const source = meeting as Record<string, unknown>;
	const joinUrl = typeof source.joinUrl === "string" ? source.joinUrl : "";
	const spellings = joinUrl ? joinUrlSpellings(joinUrl) : [];
	const kept: Record<string, unknown> = {};
	for (const field of NON_MEMBER_MEETING_FIELDS) {
		if (!Object.hasOwn(meeting, field)) continue;
		const value = source[field];
		if (typeof value !== "string" || spellings.length === 0) {
			kept[field] = value;
			continue;
		}
		const cleaned = withoutJoinUrl(value, spellings);
		kept[field] = field === "location" && cleaned !== value ? null : cleaned;
	}
	return kept as Omit<M, (typeof WITHHELD_MEETING_FIELDS)[number]>;
}
