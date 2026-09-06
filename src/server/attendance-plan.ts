import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { attendancePlanStatusEnum, meetings } from "#/db/schema";
import { resolveActor } from "./attendance-actor-logic";
import { declinePlannedAttendance } from "./attendance-decline-logic";
import {
	CLEARABLE_ASK,
	clearPlanStatus,
	SELF_SERVICE_RUNGS,
	setPlanStatus,
} from "./attendance-plan-logic";
import { assertClubNotArchived, requireMemberInClub } from "./guards";
import { assertMeetingNotLocked } from "./meeting-authz-logic";

/**
 * The planned-attendance write surface (D6, 2026-08-11): one entry point for the
 * whole `reached_out | coming | not_coming` ladder, replacing the four fns that
 * wrote the two now-dropped boolean tables separately. Those keep working as
 * thin delegates until PR 2 repoints the panel here.
 */

/** Says "officer or Toastmaster" because both arms grant it since #576. A
 *  message naming only officers would be read by the person it just rejected —
 *  a member who IS the TMOD of some other meeting — as a bug in the panel. */
const OFFICER_ONLY_REACHED_OUT_MESSAGE =
	"Only an officer or this meeting's Toastmaster can record reaching out to someone.";

/** Meeting status + OWNING club. The club comes from the meeting, never the
 *  payload (#396): gating on a client-supplied `clubId` would let an admin of
 *  club A act on club B's meeting and file the row under A. The payload has no
 *  `clubId` field at all, so there is nothing to be tempted by. */
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

const planSchema = z.object({
	/** The member whose plan is being set (the subject). */
	memberId: z.string().uuid(),
	meetingId: z.string().uuid(),
	/** Who performed it. Omitted ⇒ self-service. PUBLIC path, so this is an
	 *  assertion, not proof — `resolveWriteActor` club-scopes it and a real
	 *  session overrides it (#396). */
	actorMemberId: z.string().uuid().optional(),
	// DERIVED from the pgEnum, never hand-listed. A literal union here would be
	// invisible to `tsc` — a narrower zod enum assigns cleanly into the wider
	// `AttendancePlanStatus` parameter — so a fourth rung added to the database
	// would be silently rejected by the only entry point that writes one. That is
	// the drift #510 hit from the other side.
	status: z.enum(attendancePlanStatusEnum.enumValues),
	/** How the change happened. Recorded in activity_log.detail only. */
	via: z.enum(["nudge", "manual"]).default("manual"),
});

/** Set a member's planned attendance for a meeting.
 *
 *  `not_coming` is not just a rung: it also frees every role the member holds in
 *  this meeting, on the arms `attendance-decline-logic.ts` allows (#663). The
 *  return carries `released` so the caller can say what was freed. */
export const setPlannedAttendance = createServerFn({ method: "POST" })
	.validator((i: unknown) => planSchema.parse(i))
	.handler(async ({ data }) => {
		const meeting = await loadMeeting(data.meetingId);
		// FIRST, so an archived club cannot be probed through the different errors
		// the checks below return — the existence oracle #544 set out to close.
		await assertClubNotArchived(meeting.clubId);
		assertMeetingNotLocked(meeting.status);
		await requireMemberInClub(data.memberId, meeting.clubId);
		// A DECLINE is not just a rung (#663). A member cannot both hold a role and
		// be absent, so `not_coming` also frees every slot they hold in this
		// meeting — one transaction, the same `releaseSlotsAndMarkUnavailable` the
		// season grid has used since #204, rather than the bare `setPlanStatus`
		// below that left the agenda listing a Toastmaster whose own row read "Not
		// coming".
		//
		// Returns BEFORE the ladder below so the actor is resolved once on this
		// path: the seam runs the SAME `resolveActor`, and it has to, because it
		// takes the raw claim (a pre-resolved actor id would satisfy the subject
		// check by construction — #675). Which arms may release is that seam's
		// decision and is executed in `attendance-decline.integration.test.ts`; the
		// ladder resumed below still guards every other rung.
		if (data.status === "not_coming") {
			return declinePlannedAttendance(db, {
				memberId: data.memberId,
				meetingId: data.meetingId,
				clubId: meeting.clubId,
				// The RAW claim, deliberately not defaulted to the subject — see the
				// seam's own note, and `availability.ts`'s.
				claimedActorMemberId: data.actorMemberId,
				via: data.via,
			});
		}
		const { actorMemberId, viaManager, via } = await resolveActor({
			clubId: meeting.clubId,
			meetingId: data.meetingId,
			memberId: data.memberId,
			claimedActorMemberId: data.actorMemberId,
		});
		// `reached_out` is an OFFICER's record of having asked, not a self-service
		// answer. Without this, the self-only arm admits it for the caller's own
		// subject — and on the anonymous path "the caller's own subject" is any
		// roster member, because `claimedActorMemberId` defaults to the subject.
		// The officer's outreach list would then show that member as already
		// asked, and they would be skipped.
		if (!viaManager && data.status === "reached_out") {
			throw new Error(OFFICER_ONLY_REACHED_OUT_MESSAGE);
		}
		// ONE return shape across both branches (#663). `released` is always
		// present and 0 here, rather than absent, so a caller reading it does not
		// have to narrow a union to find out whether anything was freed — the
		// route's decline toast is the reader.
		const written = await setPlanStatus(db, {
			memberId: data.memberId,
			meetingId: data.meetingId,
			clubId: meeting.clubId,
			status: data.status,
			actorMemberId,
			via: data.via,
			grantedVia: via,
			// `via: "nudge"` is the AUTO-advance behind a WhatsApp/email tap: the
			// officer tapped "message them" and the rung moved as a SIDE EFFECT,
			// with no rung in front of them to overrule. It must never demote a
			// real answer, so it may only overwrite `reached_out` — the same floor
			// `setContacted` (`server/outreach.ts`, still live and still called by
			// the recruit picker) has always carried, for exactly the reason
			// `setPlanStatus`'s own doc comment gives: without it an officer
			// working from a panel that rendered a while ago erases the decline
			// that arrived since, the member drops off `unavailableMembers`, and
			// the VPE hands a role to someone who said they cannot come. The
			// client guard in `markAsked` is NOT this check — it reads a `plan`
			// snapshot that is stale by construction, whereas `demoteFrom` is a
			// `setWhere` predicate evaluated by Postgres against the live row.
			//
			// `via: "manual"` is the officer picking a rung from the menu with the
			// current one on screen in front of them. That is a deliberate
			// correction and stays unrestricted.
			//
			// The TMOD arm is floored on BOTH paths, not just `nudge`. An officer's
			// deliberate menu pick is a correction by someone the club elected and
			// a session authenticated; the Toastmaster's is an honour-system claim,
			// so letting it overwrite a real `coming`/`not_coming` would let one
			// forged request per member mark the whole roster "Asked" and erase
			// every answer — invisible afterwards, since `answeredRungs` filters
			// `reached_out` out and the officer's panel would read "all contacted,
			// nobody declined" (#576 review).
			demoteFrom:
				data.status === "reached_out" &&
				(data.via === "nudge" || via === "tmod")
					? ["reached_out"]
					: undefined,
		});
		return { ...written, released: 0 };
	});

/** Clear a member's planned attendance back to "no answer" (row absent). */
export const clearPlannedAttendance = createServerFn({ method: "POST" })
	.validator((i: unknown) =>
		planSchema.omit({ status: true, via: true }).parse(i),
	)
	.handler(async ({ data }) => {
		const meeting = await loadMeeting(data.meetingId);
		await assertClubNotArchived(meeting.clubId);
		assertMeetingNotLocked(meeting.status);
		await requireMemberInClub(data.memberId, meeting.clubId);
		const { actorMemberId, via } = await resolveActor({
			clubId: meeting.clubId,
			meetingId: data.meetingId,
			memberId: data.memberId,
			claimedActorMemberId: data.actorMemberId,
		});
		return clearPlanStatus(db, {
			memberId: data.memberId,
			meetingId: data.meetingId,
			clubId: meeting.clubId,
			actorMemberId,
			// Clearing your OWN answer is self-service, but `reached_out` is not
			// your answer — it is the officer's record of having asked, and before
			// the consolidation deleting it required `requireUser()` +
			// `requireClubRole(admin)` because it lived in its own table. The
			// self-only arm is no barrier here: on the anonymous path
			// `claimedActorMemberId` defaults to the subject, so actor === subject
			// always holds and any roster member is reachable.
			//
			// Gated on the OFFICER arm specifically, NOT on `viaManager` (#576
			// review). `viaManager` also admits the Toastmaster, whose claim is
			// honour-system and whose id is published on the public payload — so
			// widening this would have dropped "delete another officer's private
			// record of having asked" from authenticated-admin to unauthenticated.
			// A Toastmaster keeps the whole WRITE ladder; taking back an officer's
			// `reached_out` stays an officer action, which is where the bar was
			// before the consolidation. Writing `reached_out` is what the panel is
			// for; deleting someone else's is not.
			//
			// BOTH arms now pass a floor (#573), and they are exact complements: the
			// self/TMOD arm may clear an ANSWER, the officer arm may clear the ASK.
			// Neither may erase the other's.
			//
			// The ternary STAYS. #573 proposed replacing this whole expression with
			// `["reached_out"]`, on the stated grounds that "non-officer arms are
			// unchanged — they already pass SELF_SERVICE_RUNGS". They pass it from
			// the other branch of THIS ternary, not from another function, so
			// collapsing it would also have stopped a self-asserted Toastmaster
			// clearing their own `coming` — a narrowing nobody asked for, in a
			// change whose whole point is that nobody asked for the other one.
			// (`clearAvailability` in `availability.ts` is a separate self-serve
			// endpoint and is genuinely untouched; `outreach.ts`'s admin clear
			// already passed `["reached_out"]` inline.)
			//
			// The officer arm used to pass `undefined` — clear whatever is there —
			// and that is the defect. "No answer" means "make it as if they never
			// replied", so it must never destroy a reply: the rail does not poll, so
			// a row can still read `Asked` while the server already holds
			// `not_coming`, and deleting that drops the member off
			// `unavailableMembers` and out of the recruit picker's warning. They can
			// then be handed a role they said they could not take.
			//
			// This is NOT the "officer corrects a wrong answer" power — that is the
			// SET path (pick Coming / Not coming), where `demoteFrom` deliberately
			// leaves an officer's deliberate pick unfloored. The two got conflated
			// because a one-tap menu item was wired to the unrestricted clear,
			// replacing `clearContacted`, which had always been narrow by
			// construction. Nobody decided officers needed to erase answers.
			//
			// Accepted trade-off: there is now no way to return an answered row to
			// "no answer". Same shape as roll mode's clear-to-unmarked gap
			// (TODOS.md). An officer who wants a row to stop saying "coming" picks
			// "Not coming".
			onlyFrom: via === "officer" ? CLEARABLE_ASK : SELF_SERVICE_RUNGS,
		});
	});
