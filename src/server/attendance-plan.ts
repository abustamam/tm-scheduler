import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { attendancePlanStatusEnum, meetings } from "#/db/schema";
import {
	CLEARABLE_ASK,
	clearPlanStatus,
	SELF_SERVICE_RUNGS,
	setPlanStatus,
} from "./attendance-plan-logic";
import {
	assertClubNotArchived,
	getSessionUser,
	NO_PERMISSION_MESSAGE,
	NOT_A_MEMBER_MESSAGE,
	type ResolvedMembership,
	requireClubRole,
	requireMemberInClub,
} from "./guards";
import {
	assertMeetingNotLocked,
	loadTmodMemberId,
} from "./meeting-authz-logic";
import { resolveWriteActor } from "./write-actor-logic";

/**
 * The planned-attendance write surface (D6, 2026-08-11): one entry point for the
 * whole `reached_out | coming | not_coming` ladder, replacing the four fns that
 * wrote the two now-dropped boolean tables separately. Those keep working as
 * thin delegates until PR 2 repoints the panel here.
 */

// Module-private on purpose. `server-modules.guard.test.ts` lets a server-fn
// module export ONLY `createServerFn`s and types: any other top-level export
// survives into the client bundle and drags `#/db` → `pg` → `Buffer` with it.
const SELF_ONLY_MESSAGE = "You can only change your own planned attendance.";
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

/** Which arm of D6 admitted the caller, plus who to credit. The capability flag
 *  is REPORTED rather than inferred: `actorMemberId === null` happens to mean
 *  "impersonating superadmin" today only because a read-only session falls
 *  through and is rejected below, which is an accident of ordering, not an
 *  invariant a caller should re-derive. */
interface ResolvedActor {
	actorMemberId: string | null;
	/** Admitted as someone who RUNS this meeting, and so may set any member's
	 *  row, write the officer-only `reached_out` rung, and clear without the
	 *  self-service restriction.
	 *
	 *  Named for the CAPABILITY, not the arm, because two arms now grant it: a
	 *  club officer, and this meeting's own TMOD (#576). It was `viaOfficer`
	 *  when only one did, and leaving that name while widening the meaning is
	 *  how a reader concludes the TMOD path is an officer session. */
	viaManager: boolean;
	/** WHICH arm granted it. Nothing branches on this today — it exists so the
	 *  next reader does not have to re-derive the distinction from
	 *  `actorMemberId`, which is the mistake the note above describes. */
	via: "officer" | "tmod" | "self";
}

/** Denials that legitimately mean "not an officer HERE" and so fall through to
 *  the self-only arm. Anything else — a db blip, an archived club — is rethrown
 *  rather than silently demoting a real officer (see the constants' jsdoc). */
const OFFICER_DENIALS: ReadonlySet<string> = new Set([
	NOT_A_MEMBER_MESSAGE,
	NO_PERMISSION_MESSAGE,
]);

/**
 * Resolve the acting member and enforce D6: a club officer OR this meeting's
 * Toastmaster may set anyone's row (#576); everyone else may set only their own.
 * Session-less by design — the anonymous roster-pick identity is the dominant
 * path in this product, and both non-officer arms below run without one.
 *
 * Arm order is load-bearing. Officer first (a session admin who also happens to
 * hold the TMOD slot should be credited as the officer they are), then TMOD,
 * then self. Putting self first would swallow the TMOD arm entirely, since a
 * TMOD writing their OWN row satisfies the self test.
 */
async function resolveActor(args: {
	/** ALWAYS the meeting's own club — see `loadMeeting`. */
	clubId: string;
	/** ALWAYS the meeting the write targets. The TMOD grant is scoped to THIS
	 *  meeting: holding the slot on one meeting confers nothing on another. */
	meetingId: string;
	memberId: string;
	claimedActorMemberId?: string;
}): Promise<ResolvedActor> {
	const user = await getSessionUser();
	if (user) {
		// Branch on whether the CALL succeeded, NEVER on `membership.id` being
		// truthy. `requireClubRole` already resolves the impersonation path: a
		// superadmin with an active read_write session comes back as a memberless
		// effective-admin whose `id` is null (#246), which `setPlanStatus`
		// documents as a decision rather than an omission — `logActivity` stamps
		// the real superadmin for it. `if (membership.id)` would push exactly that
		// principal down into the self-only branch below, where they hold no
		// membership, and reject the write.
		let membership: ResolvedMembership | null = null;
		try {
			membership = await requireClubRole(user.id, args.clubId, ["admin"]);
		} catch (error) {
			if (!OFFICER_DENIALS.has(error instanceof Error ? error.message : "")) {
				throw error;
			}
		}
		if (membership) {
			return { actorMemberId: membership.id, viaManager: true, via: "officer" };
		}
	}

	// Resolve the CALLER once, here, and reuse it for both remaining arms. The
	// two used to call `resolveWriteActor` separately with different defaults,
	// which put three copies of the same (memberId, clubId) membership lookup in
	// one request on the anonymous self-service path this codebase calls "the
	// dominant path in this product" (#576 review).
	//
	// `?? null`, not the self arm's old `?? args.memberId`: this asks "who is
	// CALLING". Defaulting the caller to the SUBJECT would make every anonymous
	// write self-assert as its own target, so writing the TMOD's row would grant
	// TMOD powers over it — wrong, and useless for the panel. The self arm keeps
	// the subject default below, for a caller who asserted nothing.
	let caller = await resolveWriteActor({
		clubId: args.clubId,
		sessionUserId: user?.id ?? null,
		claimedActorMemberId: args.claimedActorMemberId ?? null,
	});

	// TMOD arm (#576), resolved BEFORE the self arm — self first would swallow it,
	// since a TMOD writing their own row satisfies the self test.
	//
	// THE TRUST MODEL, stated because it is a widening and should not be
	// discovered later: on the anonymous path this is an HONOUR-SYSTEM claim.
	// `resolveWriteActor` club-scopes the asserted id, but nothing proves the
	// caller is that person — and the id is not secret: `loadMeetingDetail` ships
	// it as `assigneeId` on the public payload. So this arm is reachable by any
	// visitor who reads the agenda. It is the same basis on which
	// `resolveMeetingAgendaAuthz` already lets a self-asserted TMOD assign roles
	// and edit meeting meta, so it is consistent with the product's identity
	// model (#317) for WRITES that land in the activity feed. It is deliberately
	// NOT trusted for anything else: the contact roster needs a real session
	// (`loadTmodPanelData`), and the unrestricted clear stays on the officer arm.
	//
	// Skipped entirely when there is no caller to match, which is what keeps the
	// slot join off the request for a caller who asserted nothing.
	if (caller) {
		const tmodMemberId = await loadTmodMemberId(args.meetingId);
		if (tmodMemberId && caller === tmodMemberId) {
			return { actorMemberId: caller, viaManager: true, via: "tmod" };
		}
	}
	// Not an officer and not this meeting's TMOD: a plain member, an anonymous
	// roster pick, or a signed-in user with no membership in THIS club. A caller
	// who asserted nothing falls back to the subject default, preserving the
	// pre-#576 anonymous self-write path.
	if (caller === null) {
		caller = await resolveWriteActor({
			clubId: args.clubId,
			sessionUserId: user?.id ?? null,
			claimedActorMemberId: args.memberId,
		});
	}
	const actor = caller;
	if (actor !== args.memberId) throw new Error(SELF_ONLY_MESSAGE);
	return { actorMemberId: actor, viaManager: false, via: "self" };
}

/** Set a member's planned attendance for a meeting. */
export const setPlannedAttendance = createServerFn({ method: "POST" })
	.validator((i: unknown) => planSchema.parse(i))
	.handler(async ({ data }) => {
		const meeting = await loadMeeting(data.meetingId);
		// FIRST, so an archived club cannot be probed through the different errors
		// the checks below return — the existence oracle #544 set out to close.
		await assertClubNotArchived(meeting.clubId);
		assertMeetingNotLocked(meeting.status);
		await requireMemberInClub(data.memberId, meeting.clubId);
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
		return setPlanStatus(db, {
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
