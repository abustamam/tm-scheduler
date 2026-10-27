// Legacy entry points, retained so PR 1 changes no client file. "Not available"
// is now one rung of the ladder (`not_coming`) rather than the presence of a row
// in its own table, so these are thin delegates onto `attendance-plan-logic`.
//
// `setAvailability` / `clearAvailability` still back the season grid's own
// availability toggle (`season-grid.tsx:176,203`) — PR 2 only repoints the
// MEETING PAGE (the officer panel and the personal strip) onto
// `setPlannedAttendance` / `clearPlannedAttendance` directly; it never touches
// the grid, so these two are not retiring.
//
// `markUnavailableReleasing` is NOT in that set either, and the reason CHANGED
// with #663. It used to be "the new write surface does not release roles"; it
// now does — `setPlannedAttendance`'s `not_coming` folds slot release into the
// ladder through `attendance-decline-logic.ts`. Three differences are left, and
// none of them is authorization:
//
//   · This endpoint releases UNCONDITIONALLY; the rail's requires an explicit
//     `releaseHeldRoles` on the payload, because that endpoint's request shape
//     did not change when the side effect did and a stale tab must not trip it.
//   · This one releases on all three arms of D6 — it is the season grid's
//     act-on-behalf-of path and the personal page's single-subject "Can't make
//     it", both of which confirm first. The rail's withholds the release from a
//     Toastmaster acting on ANOTHER member's row: a product ceiling on how much
//     one honour-system caller can sweep in a few honest taps, and deliberately
//     not a security claim (see `attendance-decline-logic.ts`). Since #762 the
//     security claim is a SEPARATE gate on both endpoints — releasing THROUGH
//     THESE TWO needs a proven session — and both seams execute that refusal
//     rather than describing it. Stated that narrowly on purpose: `releaseSlot`
//     (`slots.ts`) reaches the identical end state one slot at a time, still
//     session-less, nulling the same five columns, and it is `pending-proof`
//     until the slots child lands. What these two close is the SWEEP, not the
//     capability.
//   · The rail's refuses once the meeting is OVER, not merely completed.
//
// Folding the two together would have to pick one of each, so they stay
// separate.
//
// All three used to be PUBLIC and session-less. #762 (ADR-0026) split them:
// `setAvailability` still is, and `clearAvailability` and
// `markUnavailableReleasing` are not — they DESTROY something a person put
// there (an answer, a programme's worth of role assignments), which is the side
// of the line that needs a session bound to a member of this club. Each names
// `requireSessionActor` in its own handler.
//
// The three seams (`setAvailabilityCore`, `clearAvailabilityCore`,
// `releaseSlotsAndMarkUnavailable`, all in `availability-logic.ts`) run the D6
// actor ladder themselves, so the caller check lives where vitest can execute
// it and this module hands each one the client's RAW assertion for that to mean
// anything. The two delegates still name the rungs they may touch rather than
// trusting the plan store to know who is calling: `attendance-plan-logic.ts`
// genuinely cannot — it takes a `DbOrTx` and no session. What it CAN be told is
// how the caller's identity was established, which is the `proof` the set seam
// passes and the `onlyIfAbsent` mode it picks from it, and which rungs the
// clear may delete.
//
// `markUnavailableReleasing` was the first of the three, since #675, and the
// distinction is worth keeping straight because it is what the missing gate hid
// behind.
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings } from "#/db/schema";
import { assertMeetingAccepts } from "#/lib/meeting-lifecycle";
import {
	clearAvailabilityCore,
	releaseSlotsAndMarkUnavailable,
	setAvailabilityCore,
} from "./availability-logic";
import { assertClubNotArchived, requireMemberInClub } from "./guards";
import { PLAN_ACCEPTING_CANCELLED } from "./meeting-write-options";
import { requireSessionActor } from "./write-actor-logic";

/** Load a meeting's status (for the #150 lock) and its OWNING club, or throw if
 *  it's missing. The club is read from the meeting rather than trusted from the
 *  payload (#396) — otherwise a caller could aim a write at club B's meeting and
 *  file the activity row under club A. */
async function loadMeeting(
	meetingId: string,
): Promise<{ status: string; clubId: string }> {
	const [row] = await db
		.select({ status: meetings.status, clubId: meetings.clubId })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!row) throw new Error("Meeting not found.");
	return row;
}

const availabilitySchema = z.object({
	/** The member whose availability is being set (the subject). */
	memberId: z.string().uuid(),
	/** Who performed the action. Omitted ⇒ self-service (actor = subject); set
	 *  to an officer's member id when an admin marks someone else unavailable.
	 *  PUBLIC path, so this is an assertion, not proof — the actor ladder
	 *  club-scopes it and a real session overrides it (#396). */
	actorMemberId: z.string().uuid().optional(),
	meetingId: z.string().uuid(),
	/** Deprecated as an authority: the club is derived from `meetingId`. */
	clubId: z.string().uuid(),
});

/** Mark a member as unavailable for a meeting — the `not_coming` rung.
 *  Idempotent (the seam upserts). PUBLIC — still no session required, and
 *  deliberately so: this is the season grid's own toggle and the honour-system
 *  sign-up sheet is the product (ADR-0010).
 *
 *  What a session-less caller may do NARROWED with #762, though. `requireMemberInClub`
 *  is a trust guard on the SUBJECT, not an authorization check on the CALLER,
 *  and #675 audited this pair and left it on the grounds that writing
 *  `not_coming` releases nothing and is recoverable by re-answering. ADR-0026
 *  disagrees with the second half: re-answering needs the member to NOTICE, and
 *  a row flipped to "not coming" takes them off the assign picker and out of the
 *  season grid's offers in the meantime. So an ASSERTED caller may fill a blank
 *  and may re-affirm the answer already there; changing one raises
 *  `SIGN_IN_REQUIRED_MESSAGE` from the seam, which the grid renders as a toast
 *  carrying a one-tap sign-in link.
 *
 *  And WHOSE row is the caller's question, answered in the seam
 *  (`setAvailabilityCore`): the member's own, or any member's for an officer, and
 *  nobody else's. A signed-in caller used to resolve to the unrestricted write
 *  with nothing comparing them with the subject. */
export const setAvailability = createServerFn({ method: "POST" })
	.validator((i: unknown) => availabilitySchema.parse(i))
	.handler(async ({ data }) => {
		const meeting = await loadMeeting(data.meetingId);
		await assertClubNotArchived(meeting.clubId);
		// By write class (#1135). `plan` refuses a completed meeting here, as the lock
		// always did, before the membership and actor checks. It accepts
		// `cancelled` because that refusal is the plan seam's, further down
		// (`setPlanStatus` / `clearPlanStatus`), and moving it up here would change
		// what a caller who fails those checks is told.
		assertMeetingAccepts(meeting.status, "plan", PLAN_ACCEPTING_CANCELLED);
		await requireMemberInClub(data.memberId, meeting.clubId);
		// The ladder, the owner-or-officer rule and the write all run in the seam,
		// where vitest can reach them. The RAW claim, as the other two take it.
		//
		// `proof` is RETURNED (#762 review), and it is the only thing this fn can
		// tell a caller that the caller cannot work out for itself. The season
		// grid offers "Undo" on this toast, and undo is `clearAvailability`, which
		// now needs a session — so a grid that offers it to everyone offers half
		// its viewers a control whose every tap ends in a refusal.
		//
		// The grid has no session signal of its own (it is mounted by both the
		// public club shell and the authed schedule), and the honest answer is not
		// a second guess at one: it is what the write that JUST LANDED actually
		// resolved to, from the same resolution that decided the write's mode.
		// Additive, so a tab loaded before this deploy simply ignores it.
		return setAvailabilityCore(db, {
			memberId: data.memberId,
			meetingId: data.meetingId,
			clubId: meeting.clubId,
			claimedActorMemberId: data.actorMemberId,
		});
	});

/** Take a member's "not coming" back to "no answer" (row absent).
 *  SIGNED IN since #762 — a clear DESTROYS an answer a person put there, which
 *  is the side of ADR-0026's line that needs a session bound to a member of this
 *  club. `requireMemberInClub` proves the SUBJECT is on the roster and proves
 *  nothing about the caller; neither is the check that says the person clearing
 *  the row is entitled to.
 *
 *  That check is `clearAvailabilityCore`'s: a member's answer is cleared by that
 *  member, or by an officer acting on the season grid (`canManageOthers` there,
 *  `requireClubRole(admin)` here), and by nobody else, the meeting's Toastmaster
 *  included, and only by a caller whose identity a session proved. An officer
 *  clearing ANOTHER member's row removes a decline and nothing else. */
export const clearAvailability = createServerFn({ method: "POST" })
	.validator((i: unknown) => availabilitySchema.parse(i))
	.handler(async ({ data }) => {
		const meeting = await loadMeeting(data.meetingId);
		await assertClubNotArchived(meeting.clubId);
		// By write class (#1135), as `setAvailability`'s: `cancelled` is refused by
		// the plan seam below.
		assertMeetingAccepts(meeting.status, "plan", PLAN_ACCEPTING_CANCELLED);
		await requireMemberInClub(data.memberId, meeting.clubId);
		// The explicit, early half, as in `markUnavailableReleasing`: a write
		// surface that deletes an answer names its session gate in its own handler.
		// The RETURN is deliberately unused. The seam checks the PROOF of the actor
		// it resolves, which is the half vitest can execute, and it is the one that
		// holds when the session's membership changes between the two reads.
		await requireSessionActor({ clubId: meeting.clubId });
		const { cleared } = await clearAvailabilityCore(db, {
			// The SUBJECT is `data.memberId`, never the claim: the ladder compares the
			// actor with it.
			memberId: data.memberId,
			meetingId: data.meetingId,
			clubId: meeting.clubId,
			// The RAW claim, deliberately NOT defaulted to the subject. Behind the
			// session gate it changes no outcome, so this is defence in depth: a
			// default would make actor === subject for every request if the gate were
			// ever lost, the shape `markUnavailableReleasing` documents.
			claimedActorMemberId: data.actorMemberId,
		});

		// `cleared` is RETURNED, as `setAvailability` returns `proof`: the grid
		// offers "Undo" (a re-decline) on this toast, and an officer's clear of
		// another member's row removes a decline and nothing else, so a grid that
		// still shows a decline over a newer `coming` deletes nothing. Undoing a
		// clear that removed nothing would overwrite that answer. Additive, so a
		// tab loaded before this deploy simply ignores it.
		return { ok: true as const, cleared };
	});

/**
 * Mark a member unavailable for a meeting AND release every role they hold in
 * it, atomically (#204). A member can't both hold a role and be absent, so the
 * grid offers this as one confirmed action instead of a contradiction. Release
 * mirrors `releaseSlot` (slot → open, assignee + speech unlinked; speech kept).
 *
 * PUBLIC — no session required. `requireMemberInClub` below is a TRUST guard on
 * the SUBJECT (they are on this club's roster and still active); it is NOT an
 * authorization check on the CALLER, and reading it as one is how this fn
 * shipped with no subject check while its less destructive sibling
 * `setPlannedAttendance` had one (#675). The caller's authorization is the D6
 * ladder, and it runs inside `releaseSlotsAndMarkUnavailable` — a seam vitest
 * can reach — rather than here, where nothing but a source grep could see it.
 */
export const markUnavailableReleasing = createServerFn({ method: "POST" })
	.validator((i: unknown) => availabilitySchema.parse(i))
	.handler(async ({ data }) => {
		const meeting = await loadMeeting(data.meetingId);
		await assertClubNotArchived(meeting.clubId);
		// By write class (#1135): completed refuses here, before the membership and
		// session checks. `cancelled` is accepted HERE for the order only: the seam
		// refuses it, after those checks and the actor ladder, so a caller who fails
		// one of them still hears that. The seam refuses a completed meeting too, so
		// this early copy exists for the order, not for the refusal.
		assertMeetingAccepts(meeting.status, "plan", PLAN_ACCEPTING_CANCELLED);
		await requireMemberInClub(data.memberId, meeting.clubId);
		// #762. The seam refuses an asserted caller itself — that is where the
		// check is testable — so this is the explicit, readable half: a write
		// surface that frees another person's roles names its session gate in its
		// own handler rather than inheriting one four files away.
		await requireSessionActor({ clubId: meeting.clubId });
		const { released } = await releaseSlotsAndMarkUnavailable(db, {
			memberId: data.memberId,
			meetingId: data.meetingId,
			clubId: meeting.clubId,
			// The RAW claim, deliberately NOT defaulted to the subject. That default
			// is what the two delegates above still use, and it is right for them
			// because they only resolve who to CREDIT. Here the same expression
			// would make actor === subject for every request and turn the ladder's
			// subject check into a no-op — the #675 hole, restored in one token.
			// `availability-authz.guard.test.ts` reads this handler VERBATIM, so
			// spelling the offending expression in a comment would fail it.
			claimedActorMemberId: data.actorMemberId,
		});
		return { ok: true as const, released };
	});
