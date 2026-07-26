/**
 * Who an `activity_log` row credits (#396).
 *
 * The rule, in one sentence: **the actor is derived from the session whenever
 * there is one, and a client-asserted actor is only ever accepted from a caller
 * with no session — and only if it is a real, active membership of the club
 * being written to.**
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
 * club actually being written to, and (b) session precedence, so a signed-in
 * caller is credited as themselves and cannot assert somebody else's name. That
 * matches what the client already does (`useEffectiveMember` lets the session
 * win over the localStorage name-pick), so it changes no working flow.
 *
 * This module touches `db` and must never be imported by client code.
 */
import { getMembership, getSessionUser, requireMemberInClub } from "./guards";

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
 * `write-actor.integration.test.ts`). Server fns call `requestWriteActor` /
 * `requireRequestWriteActor` below, which read the session for them.
 *
 * Returns null when nobody can be resolved: no session membership and no
 * asserted actor. A null actor is a legitimate, honest "system" row (that is
 * also what a `read_write` impersonated write records — `logActivity` nulls the
 * member and stamps `impersonated_by` instead), so it is not an error here.
 *
 * Throws when the asserted actor is not an active member of `clubId` — the
 * cross-club forgery this exists to stop.
 */
export async function resolveWriteActor(
	input: WriteActorInput,
): Promise<string | null> {
	if (input.sessionUserId) {
		const membership = await getMembership(input.sessionUserId, input.clubId);
		// A `read_write` impersonating superadmin has no membership and falls
		// through; `logActivity` attributes that write to them via the
		// request-scoped marker, so whatever we return is discarded anyway.
		if (membership && membership.status === "active") return membership.id;
	}
	if (!input.claimedActorMemberId) return null;
	const member = await requireMemberInClub(
		input.claimedActorMemberId,
		input.clubId,
	);
	return member.id;
}

/** `resolveWriteActor` with the session read from the current request. */
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
 * Like `requestWriteActor`, but for the public sheet actions that are
 * meaningless without an identity (claim/release/reassign): an anonymous caller
 * who sent no name has nothing to credit, and recording an anonymous "someone"
 * against a slot change is exactly the untrustworthy feed this issue is about.
 */
export async function requireRequestWriteActor(input: {
	clubId: string;
	claimedActorMemberId?: string | null;
}): Promise<string> {
	const actor = await requestWriteActor(input);
	if (!actor) {
		throw new Error("Pick your name first so we know who's doing this.");
	}
	return actor;
}
