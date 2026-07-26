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
	if (input.sessionUserId) {
		const membership = await getMembership(input.sessionUserId, input.clubId);
		if (membership && membership.status === "active") return membership.id;
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
	return member.id;
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
