/**
 * WHO may write a member's meeting-scoped attendance answer — the D6 actor
 * ladder (2026-08-11), widened to three arms by #576 and shared with
 * `availability.ts` by #675.
 *
 * It lived inside `attendance-plan.ts` until #675, private to that
 * `createServerFn` module because `server-modules.guard.test.ts` lets such a
 * module export only `createServerFn`s and types. That privacy cost two things
 * at once. It was unreachable from vitest, so `attendance-plan-authz.guard.test.ts`
 * could only pin the ladder's SHAPE against the source text; and it was
 * unreachable from the OTHER session-less writer that needed exactly this
 * decision, so `markUnavailableReleasing` shipped with no subject check at all.
 * `requireMemberInClub` proves the SUBJECT is on the roster and
 * `requestWriteActor` resolves who to CREDIT — neither proves the caller IS the
 * subject — so any caller could assert an `actorMemberId`, release every role a
 * member held and mark them not coming, with no undo (#675).
 *
 * Moving it here rather than copying it is the point: a second copy of a
 * three-arm authorization ladder is how the two drift, and the arm ORDER is
 * load-bearing in a way a copy would not preserve (see `resolveActor`).
 *
 * WHAT THIS DOES NOT DO, stated because the name invites the wrong reading. It
 * binds a caller who ASSERTS an identity, not an anonymous one who asserts
 * nothing: with no session and no `claimedActorMemberId` the fallback below
 * resolves the caller TO the subject, so `actor === args.memberId` holds and the
 * write is admitted. That is the product's identity model (#317) — the same
 * honour system `claimSlot` and `releaseSlot` run on — not an oversight, and it
 * is why the guard earns its place by making a dishonest assertion fail loudly
 * rather than by making forgery impossible.
 *
 * This module touches `db` and must never be imported by client code.
 */
import {
	getSessionUser,
	NO_PERMISSION_MESSAGE,
	NOT_A_MEMBER_MESSAGE,
	type ResolvedMembership,
	requireClubRole,
} from "./guards";
import { loadTmodMemberId } from "./meeting-authz-logic";
import { resolveWriteActor } from "./write-actor-logic";

/** The rejection an asserted non-manager caller gets when they name a subject
 *  that is not themselves. Exported so a test compares against THIS string
 *  rather than a copy of it — it was module-private while the ladder lived in a
 *  server-fn module, which is exactly what made the rule unassertable. */
export const SELF_ONLY_MESSAGE =
	"You can only change your own planned attendance.";

/** Which arm of D6 admitted the caller, plus who to credit. The capability flag
 *  is REPORTED rather than inferred: `actorMemberId === null` happens to mean
 *  "impersonating superadmin" today only because a read-only session falls
 *  through and is rejected below, which is an accident of ordering, not an
 *  invariant a caller should re-derive. */
export interface ResolvedActor {
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
export async function resolveActor(args: {
	/** ALWAYS the meeting's OWN club, read from the meeting row by the caller
	 *  (#396) — never a club id taken off the request payload. */
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
