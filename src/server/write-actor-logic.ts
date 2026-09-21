/**
 * Who an `activity_log` row credits (#396).
 *
 * The rule, in one sentence: **the actor is derived from the caller's own active
 * membership in the club being written to whenever they have one, and a
 * client-asserted actor is only ever accepted from a caller who does not — and
 * only if it is a real, active membership of that same club.**
 *
 * Note what that does *not* say: it is not "derived from the session". A magic
 * link makes anyone a session, and a signed-in user with no membership in club C
 * is, on C's public sheet, exactly an anonymous visitor — no better and no worse.
 * The property that holds is club-scoped membership, not the mere presence of a
 * session.
 *
 * Before this, several officer-only server fns took `actorMemberId` straight off
 * the client payload and validated it only as a uuid. `requireClubRole` gated
 * *who may act on which club*; nothing gated *who the resulting row credits*, so
 * an admin of club A could post a row into club A's feed attributed to a member
 * of club B — and the feed rendered that name. Authed paths must therefore never
 * read the actor from `data`; they take it from the membership their guard
 * already resolved (see `outreach.ts` for the shape).
 *
 * The public, no-auth sign-up surfaces (`claimSlot` / `releaseSlot` /
 * `reassignSlot` / `updateSpeakerDetails` / the availability toggles) genuinely
 * have no session: an anonymous visitor picks their name from the roster and the
 * honor system does the rest — that is the product, not a bug. What they get
 * here is (a) club scoping, so the asserted id must be an active member of the
 * club actually being written to, (b) membership precedence, so a caller who is
 * a member here is credited as themselves and cannot assert somebody else's name
 * — matching what the client already does (`useEffectiveMember` lets the session
 * win over the localStorage name-pick) — and (c) impersonation attribution, see
 * `resolveWriteActor`.
 *
 * This module touches `db` and must never be imported by client code.
 */
import {
	NOT_ON_ROSTER_MESSAGE,
	SIGN_IN_REQUIRED_MESSAGE,
	type WriteProof,
} from "#/lib/write-proof";
import { getMembership, getSessionUser, requireMemberInClub } from "./guards";
import { markImpersonatedWrite } from "./impersonation-actor";
import { getActiveImpersonation } from "./impersonation-logic";

export interface WriteActorInput {
	/** The club the write (and its activity row) belongs to. Must already be
	 *  derived server-side — never taken from the client payload. */
	clubId: string;
	/** The signed-in user's id, or null for an anonymous caller. */
	sessionUserId: string | null;
	/** The actor the client asserted, if any. Honoured only for a caller with no
	 *  active membership in `clubId`, and only after club-scoping it. */
	claimedActorMemberId?: string | null;
}

/**
 * Resolve the member id to credit for a write on `clubId`, with the session
 * passed in explicitly (so this is directly testable — see
 * `write-actor.integration.test.ts`). Server fns call `requestWriteActor` below,
 * which reads the session for them.
 *
 * Returns null in two legitimate cases, both of which `logActivity` records
 * honestly rather than as a member:
 *
 *  - a superadmin writing under an active impersonation session (#246). The
 *    request is marked here, so `logActivity` nulls `actor_member_id` and stamps
 *    `impersonated_by` with the real person.
 *  - nobody to credit at all: no membership in this club and no asserted actor.
 *    An honest "system" row, not an error.
 *
 * Throws when the asserted actor is not an active member of `clubId` — the
 * cross-club forgery this exists to stop.
 */
export async function resolveWriteActor(
	input: WriteActorInput,
): Promise<string | null> {
	return (await resolveWriteActorWithProof(input))?.memberId ?? null;
}

/** A resolved actor and how their identity was established. */
export interface ResolvedWriteActor {
	memberId: string;
	proof: WriteProof;
}

/**
 * {@link resolveWriteActor}, but saying WHICH of its two arms answered (#761).
 *
 * Identical resolution order, identical throws, identical impersonation
 * handling — the only new information is the `proof` field, and `resolveWriteActor`
 * is now a projection of this function so the two can never diverge. **No call
 * site changes in #761:** this lays the seam the Phase 1 children (slots,
 * attendance, ballots, the role-card flag) read to decide whether an asserted
 * caller may proceed, per ADR-0026.
 *
 * `proof: "session"` means the member id came from the caller's OWN active
 * membership in `clubId`, resolved from their session. `proof: "asserted"` means
 * it came off the wire and was only club-scoped — a real, active member of this
 * club, and nothing more. Member ids are public identifiers (they ship in the
 * public sheet payload), not credentials, so "asserted" carries exactly the
 * weight of a name written on a paper sign-up sheet.
 *
 * Null still means the two legitimate no-credit cases `resolveWriteActor`
 * documents: an impersonated write, or nobody to credit at all. Neither is an
 * actor, so neither carries a proof.
 */
export async function resolveWriteActorWithProof(
	input: WriteActorInput,
): Promise<ResolvedWriteActor | null> {
	if (input.sessionUserId) {
		const membership = await getMembership(input.sessionUserId, input.clubId);
		if (membership && membership.status === "active") {
			return { memberId: membership.id, proof: "session" };
		}
		// An impersonating superadmin has no membership in this club, so without
		// this branch they fall through to the asserted arm and the write lands
		// under whatever roster name the client sent, with `impersonated_by` NULL.
		// That is exactly the forged row this issue closes, aimed at the one
		// principal ADR-0016/#246 exists to keep attributable. Mark the request
		// (the same marker the authed guards set) and credit nobody; `logActivity`
		// then records the real superadmin.
		//
		// Deliberately BOTH modes, unlike the authed guards, which grant only on
		// `read_write`. That distinction is about *authorization*, and nothing is
		// authorized here — this surface already admits anonymous callers, so a
		// read-only session gains no capability from being recognised; it only
		// loses the ability to launder a write under a member's name. "Read-only
		// stays write-blind" describes what the guards grant, not a licence to
		// mis-attribute a write that happened anyway.
		const session = await getActiveImpersonation(
			input.sessionUserId,
			input.clubId,
		);
		if (session) {
			markImpersonatedWrite(input.sessionUserId);
			return null;
		}
	}
	if (!input.claimedActorMemberId) return null;
	const member = await requireMemberInClub(
		input.claimedActorMemberId,
		input.clubId,
	);
	return { memberId: member.id, proof: "asserted" };
}

/**
 * `resolveWriteActor` with the session read from the current request — the only
 * entry point the public server fns use.
 *
 * There is deliberately no `require…` variant that throws on a null actor. Both
 * ways null arises are legitimate (an impersonated write, or a caller with
 * genuinely nobody to credit), and a throw would block impersonated writes on
 * exactly the surfaces #246 promises full admin parity on. Callers pass the
 * result straight to `logActivity`, which is null-aware by design.
 */
export async function requestWriteActor(input: {
	clubId: string;
	claimedActorMemberId?: string | null;
}): Promise<string | null> {
	const user = await getSessionUser();
	return resolveWriteActor({
		clubId: input.clubId,
		sessionUserId: user?.id ?? null,
		claimedActorMemberId: input.claimedActorMemberId ?? null,
	});
}

/**
 * {@link resolveWriteActorWithProof} with the session read from the current
 * request — what a handler calls when it needs to KNOW which arm answered.
 */
export async function requestWriteActorWithProof(input: {
	clubId: string;
	claimedActorMemberId?: string | null;
}): Promise<ResolvedWriteActor | null> {
	const user = await getSessionUser();
	return resolveWriteActorWithProof({
		clubId: input.clubId,
		sessionUserId: user?.id ?? null,
		claimedActorMemberId: input.claimedActorMemberId ?? null,
	});
}

/** What a proven actor resolves to. `memberId` is null ONLY for an impersonating
 *  superadmin, who has no membership in the club and is credited as themselves
 *  by `logActivity`. */
export interface SessionActor {
	memberId: string | null;
}

/**
 * {@link requireSessionActor} with the session passed in explicitly, so it is
 * directly testable (`write-actor.integration.test.ts`) — the same split
 * `resolveWriteActor` / `requestWriteActor` already use.
 *
 * Note what it does NOT take: a `claimedActorMemberId`. That absence is the
 * whole point. There is no arm here that reads an identity off the wire, so no
 * future edit can add one without changing this signature.
 */
export async function resolveSessionActor(input: {
	clubId: string;
	sessionUserId: string | null | undefined;
}): Promise<SessionActor> {
	if (!input.sessionUserId) throw new Error(SIGN_IN_REQUIRED_MESSAGE);
	const membership = await getMembership(input.sessionUserId, input.clubId);
	if (membership && membership.status === "active") {
		return { memberId: membership.id };
	}
	// Checked AFTER the membership, matching `resolveWriteActorWithProof`'s
	// order: a superadmin who is also a real member of this club acts as
	// themselves rather than disappearing into an impersonated write.
	//
	// `read_write` ONLY, unlike `resolveWriteActorWithProof`, which marks both
	// modes. That difference is the difference between attribution and
	// authorization. There, nothing is authorized — the surface already admits
	// anonymous callers, so recognising a read-only session takes a capability
	// away (the ability to launder a write under a member's name) and grants
	// none. Here a grant IS being made, and ADR-0020's read-only mode is
	// write-blind, so a read-only session must fall through to the refusal below
	// exactly as any other signed-in non-member does.
	const session = await getActiveImpersonation(
		input.sessionUserId,
		input.clubId,
	);
	if (session && session.mode === "read_write") {
		markImpersonatedWrite(input.sessionUserId);
		return { memberId: null };
	}
	throw new Error(NOT_ON_ROSTER_MESSAGE);
}

/**
 * The gate for a write that needs a **proven** actor — a magic-link session
 * bound to a member of this club (#761, ADR-0026).
 *
 * Use it where an asserted name is not enough: removing, overwriting or ruling
 * on someone. It reads the session itself and throws without one, which is what
 * makes it a session gate `write-proof.guard.test.ts` recognises — unlike
 * `requireClubRole` / `requireMembership` / `requireClubAdminView` /
 * `requireSuperadmin`, which take a `userId` argument and therefore prove a
 * session only when that id came from one.
 *
 * Two refusals, deliberately distinct, because they have different fixes:
 * `SIGN_IN_REQUIRED_MESSAGE` (no session — the toast offers "Sign in") and
 * `NOT_ON_ROSTER_MESSAGE` (a session that is not on this roster — signing in
 * again cannot help, so the toast offers nothing and says to ask an officer).
 * Collapsing them into one message would send a member whose email is not on
 * the roster round the magic-link loop forever.
 */
export async function requireSessionActor(input: {
	clubId: string;
}): Promise<SessionActor> {
	const user = await getSessionUser();
	return resolveSessionActor({
		clubId: input.clubId,
		sessionUserId: user?.id ?? null,
	});
}
