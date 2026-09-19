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
import { listRoles } from "#/lib/list-roles";
import { OFFICER_POSITION_LABELS, type OfficerPosition } from "#/lib/officers";

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

/**
 * Told to the admin when convert REUSED a membership that had lapsed, and woke
 * it back up (#501).
 *
 * `inactive` is not a soft label — a lapsed membership is hidden from the
 * roster, the sign-up sheet, the season grid and every role picker — so a
 * convert that reused one silently left the new member invisible everywhere a
 * human would look, with a success toast and a `joined` guest card saying
 * otherwise. Convert now reactivates, which is what the admin meant; this
 * sentence is the half that stops the reactivation from being silent.
 *
 * It names the PRIOR status rather than only the outcome, because the thing the
 * admin needs the chance to notice is that this human was already on the roster
 * once. Person dedup can match the wrong human (#561), held back only by
 * `namesAgree` — an explicit notice is the moment that becomes visible.
 *
 * Shown ONLY when the reuse branch fired on a membership that was not already
 * `active`. Reuse of a live membership is ordinary dedup; a notice there would
 * fire on the common path and teach admins to ignore it.
 */
export const CONVERT_REACTIVATED_MESSAGE =
	"Reactivated an existing lapsed membership (was inactive).";

/**
 * Told to the admin when waking that lapsed membership also wrote its club role
 * back DOWN to Member (#501 review).
 *
 * `members.status === 'active'` IS the write-authorization gate —
 * `requireMembership` sends a non-active membership to
 * `requireReadWriteImpersonation`, which refuses an ordinary caller — and
 * deactivation never cleared `club_role`. So reactivating a row that lapsed
 * while it said `admin` silently handed full club-admin write access back, from
 * a guest card that shows no role at all. Restoring VISIBILITY is what #501
 * asked for; restoring AUTHORITY is not, and Person dedup can land on the wrong
 * human (#561).
 *
 * It names the remedy because the demotion is sometimes wrong: an admin who
 * genuinely wants that person back as an admin must be able to see what
 * happened and put it right. `ClubRoleControl` on the member page promotes in
 * one click.
 *
 * Shown ONLY alongside `CONVERT_REACTIVATED_MESSAGE` — the demotion rides the
 * reactivation and never fires on its own. Reuse of an ALREADY-ACTIVE admin is
 * ordinary dedup and is left entirely alone; demoting there would be a
 * privilege regression this code has no business performing.
 */
export const CONVERT_DEMOTED_MESSAGE =
	"Their club role was set back to Member — waking a lapsed membership never restores admin access. Make them an admin again from their member page if that's what you meant.";

/**
 * Told to the admin when the woken membership STILL confers admin, because it
 * holds an open officer term (#202's effective-admin: every officer is a full
 * admin, whatever `club_role` says).
 *
 * This sentence exists because the one above would otherwise be a lie. Convert
 * writes `club_role` down; it deliberately does NOT close officer terms — a term
 * is a governance fact about who the club's President is, read by the printed
 * agenda, the officer home, the COT seats and the onboarding checklist, and
 * vacating one from a guest card is not a VP-Membership decision. Deactivation
 * does not close them either, so a lapsed row can carry one.
 *
 * The residue is therefore real and this is where it becomes visible: the
 * membership is active again and its open term grants exactly the access the
 * demotion just removed. Ending the term is a checkbox on the member edit form.
 */
export const CONVERT_OFFICER_ADMIN_MESSAGE = (offices: string): string =>
	`They still hold an open officer term (${offices}), and every officer is a full club admin — end the term on their member page if that isn't right.`;

/** The shape `convertNoticeDescription` reads — the privilege half of
 *  `ConvertGuestResult`, restated here so this module stays free of `#/db`. */
export interface ConvertNotice {
	reactivated: boolean;
	/** The elevated club role convert wrote down to `member`, if it did. */
	demotedFrom?: "admin";
	/** Open officer positions the woken membership still holds. */
	retainedOfficerPositions: OfficerPosition[];
}

/**
 * The description line under convert's success toast, or `undefined` when the
 * conversion has nothing unusual to report.
 *
 * A function rather than three conditionals at the call site because the
 * sentences COMPOSE, and the composition is the part with a wrong answer in it:
 * the demotion notice alone overstates what happened when an officer term
 * survives it, and the officer notice alone is a non-sequitur without the
 * reactivation that made the term live again. Keeping them together in one pure
 * function is what lets `guest-convert.test.ts` assert every combination
 * without a database or a rendered toast.
 *
 * Silent on the ordinary path by construction: a fresh membership and a reuse
 * of an already-active one both arrive with `reactivated: false` and no
 * positions, and a notice that fires on the common path is one admins learn to
 * ignore.
 */
export function convertNoticeDescription(
	result: ConvertNotice,
): string | undefined {
	if (!result.reactivated) return undefined;
	const lines = [CONVERT_REACTIVATED_MESSAGE];
	if (result.demotedFrom) lines.push(CONVERT_DEMOTED_MESSAGE);
	if (result.retainedOfficerPositions.length > 0) {
		lines.push(
			CONVERT_OFFICER_ADMIN_MESSAGE(
				listRoles(
					result.retainedOfficerPositions.map(
						(p) => OFFICER_POSITION_LABELS[p],
					),
				),
			),
		);
	}
	return lines.join(" ");
}

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
