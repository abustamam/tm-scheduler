/**
 * User-facing sentences and predicates for guest → member conversion (#617, #618).
 *
 * These live in `lib/` rather than beside the logic they belong to, for the
 * reason CLAUDE.md records: `guest-pipeline-logic.ts` imports `#/db` at load, so
 * a unit test importing a constant from it throws `DATABASE_URL is not set`. A
 * value nothing can import is a value nothing can assert, and #519 shipped a cap
 * that could have been raised to five million with the whole suite green for
 * exactly that reason.
 */

/**
 * Refusal when this club already has a roster member whose name agrees with the
 * guest being converted (#617).
 *
 * Written for the VP-Membership board, which surfaces a thrown message verbatim,
 * so it has to say what to do next rather than only what went wrong. The two
 * outcomes an admin actually faces are the two it names: same human (already a
 * member — link them) or genuine namesake (add from the roster).
 *
 * The first half pointed at "merging them on the Roster page" until #635, and
 * that was the wrong remedy for the case this guard fires on most. The roster's
 * merge is member↔member; when the duplicate is a GUEST row beside a MEMBER row
 * there is only one member row and nothing to merge it with. It sent the admin
 * to a screen that could not help, on the exact rows this guard had just made
 * unconvertible. **Link** is the action that applies.
 */
export const CONVERT_NAME_CLASH_MESSAGE =
	"Someone with this name is already on the roster. If it's the same person, use “Already a member?” on this card to link them — their guest history carries across. If it's a different person who happens to share the name, add them from the Roster page instead.";

/** Refusal when the target of a link is not a member of this club. */
export const LINK_MEMBER_NOT_IN_CLUB_MESSAGE =
	"That member isn't on this club's roster.";

/**
 * Refusal when the guest has already been converted for real — `joined` AND
 * still pointing at a live membership.
 *
 * A STRANDED guest (joined, pointer null) is deliberately NOT refused: that is
 * a guest whose membership was removed from the roster (#618), and linking is
 * exactly the recovery this offers them.
 */
export const LINK_ALREADY_JOINED_MESSAGE =
	"This guest is already linked to a member. Unlink them first if you need to point them somewhere else.";

/**
 * Refusal when a slot assignment names a guest who is now a member (#637).
 *
 * Takes the name because the admin is looking at a picker that offered this
 * person as a guest — telling them "assign them as a member instead" without
 * saying WHO reads as a non-sequitur on a screen listing twenty names.
 */
export const GUEST_IS_NOW_A_MEMBER_MESSAGE = (name: string): string =>
	`${name} is a club member now — assign them from the member list above, not as a guest.`;

/** Refusal when unlinking a guest that was never linked. */
export const UNLINK_NOT_LINKED_MESSAGE = "This guest isn't linked to a member.";

/**
 * Refusal when undoing a conversion on a guest that is not converted (#618).
 *
 * Includes a STRANDED guest: the membership is already gone, so there is
 * nothing to unwind, and #632 gave that row its ordinary controls back.
 */
export const UNDO_NOT_CONVERTED_MESSAGE =
	"This guest isn't a converted member, so there's no conversion to undo.";

/**
 * Refusal when the conversion predates the record an undo replays (#618).
 *
 * Convert did not record which slots it moved, or whether it CREATED the
 * membership and the Person rather than deduping onto existing ones, until this
 * feature shipped. Without that, an undo cannot tell a membership it minted
 * from one that was already on the roster, and deleting the second destroys
 * real data. Refusing is the honest answer; removing the member from the roster
 * is still available and leaves the guest recoverable (#632).
 */
export const UNDO_NO_RECORD_MESSAGE =
	"This conversion happened before undo was available, so it can't be " +
	"reversed automatically. Remove the member from the roster instead — the " +
	"guest card comes back with its controls.";

/** Refusal when the converted member can sign in — mirrors `applyMemberRemove`. */
export const UNDO_MEMBER_HAS_ACCOUNT_MESSAGE =
	"That member is a signed-in account and can't be removed.";

/**
 * Refusal when the membership acquired something of its own since converting.
 *
 * Named rather than generic: the admin is being told they cannot use the one
 * control on the card, and "has history" without saying WHAT sends them
 * hunting. The merge tool is the right instrument once this is true.
 */
export const UNDO_MEMBER_HAS_HISTORY_MESSAGE = (what: string): string =>
	`This member has ${what} of their own now, so undoing the conversion would ` +
	`destroy it. Use the member merge tool instead.`;

/**
 * Whether a guest row is stranded: frozen at `joined` while the membership it
 * was converted into no longer exists (#618).
 *
 * `guests.converted_membership_id` is `onDelete: "set null"`, so removing the
 * member from the roster clears the pointer and leaves `stage` saying `joined`
 * forever. Every control on the pipeline card is gated on that stage, so the row
 * used to render a green "Member" badge for a member who was gone, with no way
 * back — `applySetGuestStage` refused because the stage said joined, and
 * `applyDeleteGuest` refused for the same reason.
 *
 * Exported as a predicate rather than inlined twice because the server guards
 * and the card must agree about it. They disagreeing is the bug.
 */
export function isStrandedConvertedGuest(guest: {
	stage: string;
	convertedMembershipId: string | null;
}): boolean {
	return guest.stage === "joined" && guest.convertedMembershipId === null;
}
