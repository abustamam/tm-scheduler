// Legacy entry points, retained so PR 1 changes no client file. "Not available"
// is now one rung of the ladder (`not_coming`) rather than the presence of a row
// in its own table, so these are thin delegates onto `attendance-plan-logic`.
//
// `setAvailability` / `clearAvailability` still back the season grid's own
// availability toggle (`season-grid.tsx:176,203`) — PR 2 only repoints the
// MEETING PAGE (the officer panel and the personal strip) onto
// `setPlannedAttendance` / `clearPlannedAttendance` directly; it never touches
// the grid, so these two are not retiring. `markUnavailableReleasing` is NOT in
// that set either: it also releases every role the member holds (#204), which
// the new write surface does not do, so it outlives the other two until
// something folds slot release into the ladder.
//
// All three are PUBLIC and session-less. The two `setAvailability` /
// `clearAvailability` delegates therefore name the rungs they may touch
// (`SELF_SERVICE_RUNGS`) rather than trusting the plan seam to know who is
// calling: that seam is `attendance-plan-logic.ts`, and it genuinely cannot
// know — it takes a `DbOrTx` and no session.
//
// `markUnavailableReleasing` is the exception since #675, and the distinction is
// worth keeping straight because it is what the missing gate hid behind. ITS
// seam is `releaseSlotsAndMarkUnavailable`, which reaches the request for a
// session itself and runs the D6 actor ladder — so the caller check does live
// there, and this module must hand it the client's RAW assertion for that to
// mean anything.
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings } from "#/db/schema";
import {
	clearPlanStatus,
	SELF_SERVICE_RUNGS,
	setPlanStatus,
} from "./attendance-plan-logic";
import { releaseSlotsAndMarkUnavailable } from "./availability-logic";
import { assertClubNotArchived, requireMemberInClub } from "./guards";
import { assertMeetingNotLocked } from "./meeting-authz-logic";
import { requestWriteActor } from "./write-actor-logic";

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
	 *  PUBLIC path, so this is an assertion, not proof — `requestWriteActor`
	 *  club-scopes it and a real session overrides it (#396). */
	actorMemberId: z.string().uuid().optional(),
	meetingId: z.string().uuid(),
	/** Deprecated as an authority: the club is derived from `meetingId`. */
	clubId: z.string().uuid(),
});

/** Mark a member as unavailable for a meeting — the `not_coming` rung.
 *  Idempotent (the seam upserts). PUBLIC — no session required.
 *  `requireMemberInClub` is a trust guard on the SUBJECT, not an authorization
 *  check on the CALLER; #675 audited this pair and left it, because writing
 *  `not_coming` releases nothing and the member's own answer is recoverable by
 *  re-answering. See TODOS/release-roles-subject-check-675.md. */
export const setAvailability = createServerFn({ method: "POST" })
	.validator((i: unknown) => availabilitySchema.parse(i))
	.handler(async ({ data }) => {
		const meeting = await loadMeeting(data.meetingId);
		await assertClubNotArchived(meeting.clubId);
		assertMeetingNotLocked(meeting.status);
		await requireMemberInClub(data.memberId, meeting.clubId);
		const actorMemberId = await requestWriteActor({
			clubId: meeting.clubId,
			claimedActorMemberId: data.actorMemberId ?? data.memberId,
		});

		await setPlanStatus(db, {
			memberId: data.memberId,
			meetingId: data.meetingId,
			clubId: meeting.clubId,
			status: "not_coming",
			actorMemberId,
			// Deliberately NO `demoteFrom`. Writing `not_coming` over an officer's
			// `reached_out` is the ladder working: they asked, the member answered.
			// Restricting this would silently discard the answer, which is a worse
			// loss than the "we asked them" bit it would have preserved.
		});

		return { ok: true as const };
	});

/** Take a member's "not coming" back to "no answer" (row absent).
 *  PUBLIC — no session required. `requireMemberInClub` proves the SUBJECT is on
 *  the roster; it proves nothing about the caller. What bounds this one is the
 *  self-service floor it hands the seam below, which keeps an officer's
 *  `reached_out` out of reach of a session-less delete. */
export const clearAvailability = createServerFn({ method: "POST" })
	.validator((i: unknown) => availabilitySchema.parse(i))
	.handler(async ({ data }) => {
		const meeting = await loadMeeting(data.meetingId);
		await assertClubNotArchived(meeting.clubId);
		assertMeetingNotLocked(meeting.status);
		await requireMemberInClub(data.memberId, meeting.clubId);
		const actorMemberId = await requestWriteActor({
			clubId: meeting.clubId,
			claimedActorMemberId: data.actorMemberId ?? data.memberId,
		});

		await clearPlanStatus(db, {
			memberId: data.memberId,
			meetingId: data.meetingId,
			clubId: meeting.clubId,
			actorMemberId,
			// THE fix for the authorization regression this consolidation created.
			// Deleting an officer's "I contacted them" used to require
			// `requireUser()` + `requireClubRole(admin)`, because it lived in its own
			// table. It now shares a row with the member's own answer, and this
			// endpoint takes no session at all — so without this the whole officer
			// chase list was erasable by anyone who could read a member id off the
			// public season grid.
			onlyFrom: SELF_SERVICE_RUNGS,
		});

		return { ok: true as const };
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
		assertMeetingNotLocked(meeting.status);
		await requireMemberInClub(data.memberId, meeting.clubId);
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
