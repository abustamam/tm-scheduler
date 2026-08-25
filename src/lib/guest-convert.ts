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
 * outcomes an admin actually faces are the two it names: same human (nothing to
 * convert) or genuine namesake (merge first).
 */
export const CONVERT_NAME_CLASH_MESSAGE =
	"Someone with this name is already on the roster. If it's the same person, they're already a member — mark the guest as joined by merging them on the Roster page. If it's a different person with the same name, add them from the Roster page instead.";

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
