// Pure, client-safe rules for inviting a guest back to the next meeting (#899).
// No `#/db` here: the VPM board reads this to decide which rows get the invite
// control, and `applyRecordGuestInvite` reads it to decide which rows it
// refuses. One statement, so the button and the server cannot disagree about
// who may be invited.

import type { GuestKind } from "#/lib/guest-profile";

/** The pipeline stages a guest may occupy — structurally `GuestStage`. */
type Stage = "prospect" | "following_up" | "joined" | "lost";

/**
 * A guest may be invited only while still in the funnel: Prospects or
 * Following up. `joined` (a stranded row included — it can be moved back to
 * Prospect first) and `lost` are not invitable.
 */
export function isInvitableStage(stage: Stage): boolean {
	return stage === "prospect" || stage === "following_up";
}

export const NOT_INVITABLE_MESSAGE =
	"Only a guest in Prospects or Following up can be invited. Move them back to Prospect first.";

/**
 * A guest may be invited only when they are in the funnel AND a prospect: a
 * Visiting Toastmaster is a Toastmaster from another club, never a prospect, so
 * their stored `stage` (the default `prospect`) is not a funnel position
 * (#1608). The card asks this; the server's two refusals test the kind
 * directly so each can give its own message.
 */
export function isInvitableGuest(guest: {
	stage: Stage;
	kind: GuestKind;
}): boolean {
	return guest.kind === "visitor" && isInvitableStage(guest.stage);
}

export const NOT_INVITABLE_KIND_MESSAGE =
	"Visiting Toastmasters aren't invited. Change their kind to Guest first.";

export const NO_STAGE_KIND_MESSAGE =
	"A Visiting Toastmaster has no stage to move. Change their kind to Guest first.";

/**
 * Which invite draft a guest gets, by how recently they visited:
 * - `never`: no visits at all (a Prospect can have none);
 * - `firstRecent` / `repeatRecent`: their latest visit is the club's most
 *   recent held meeting, on their first / a later visit;
 * - `lapsed`: they have visited, but a later meeting has been held since.
 */
export type InviteKind = "never" | "firstRecent" | "repeatRecent" | "lapsed";

export function inviteKindFor(guest: {
	inviteVisitCount: number;
	lastVisitWasLatestMeeting: boolean;
}): InviteKind {
	if (guest.inviteVisitCount <= 0) return "never";
	if (!guest.lastVisitWasLatestMeeting) return "lapsed";
	return guest.inviteVisitCount === 1 ? "firstRecent" : "repeatRecent";
}
