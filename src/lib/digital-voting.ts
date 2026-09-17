/**
 * Whether a meeting runs its award votes on phones (#770) — the ONE statement
 * of the rule every surface and every server gate asks.
 *
 * Two switches, and a meeting can only turn it further OFF: the club's
 * `digital_voting_enabled` (default on) and the meeting's
 * `digital_voting_disabled` (default off). A club that votes on paper is off
 * for every meeting, whatever the meeting says.
 *
 * "Off" removes digital voting only — the ballot QR, the Ballot Counter's vote
 * panel, the public ballot, and the server paths that open a vote, take a
 * ballot or add a guest to one. Paper voting is untouched: the agenda still
 * says who opens voting for Best Speaker, the deck still shows the nominees,
 * and the winners are still recorded in the minutes.
 *
 * Pure and `#/db`-free so the client bundle, the print route and the server
 * gates import the same function.
 */
export function isDigitalVotingOn(
	club: { digitalVotingEnabled: boolean },
	meeting: { digitalVotingDisabled: boolean },
): boolean {
	return club.digitalVotingEnabled && !meeting.digitalVotingDisabled;
}

/** The refusal every gated voting write throws, so the phone, the console and
 *  the tests all read one sentence. */
export const DIGITAL_VOTING_OFF_MESSAGE =
	"Digital voting is off for this meeting.";

/**
 * The public ballot's URL for a meeting's QR codes, or `null` when the meeting
 * runs no digital vote (#770) — the ONE place a ballot URL is built, so no
 * surface can print a QR the switch says should not exist
 * (`digital-voting-surfaces.guard.test.ts` holds every route to it).
 *
 * `origin` is what the caller knows about where it is running:
 * - `null` — not known yet (the first client render, before an effect reads
 *   `window.location`). Answers `""`, which every QR renderer treats as
 *   "loading": an empty value encodes without error but scans to nothing.
 * - `""` — deliberately relative (server render of a page whose deck is not
 *   scanned from). Answers the bare path.
 * - an origin — the absolute URL a phone's camera can resolve.
 */
export function ballotUrlFor(
	digitalVoting: boolean,
	meeting: { clubKey: string; meetingKey: string },
	origin: string | null,
): string | null {
	if (!digitalVoting) return null;
	if (origin === null) return "";
	return `${origin}/club/${meeting.clubKey}/meeting/${meeting.meetingKey}/vote`;
}
