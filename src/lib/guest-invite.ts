// Pure, client-safe rules for inviting a guest back to the next meeting (#899).
// No `#/db` here: the VPM board reads this to decide which rows get the invite
// control, and `applyRecordGuestInvite` reads it to decide which rows it
// refuses. One statement, so the button and the server cannot disagree about
// who may be invited.

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
