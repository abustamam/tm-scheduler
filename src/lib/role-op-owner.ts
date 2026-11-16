/**
 * Whose queued role write is it (#1638). The offline queue is keyed by meeting,
 * not by user, so a role op queued by one officer must not replay under whoever
 * signs in next on the same laptop: `claimSlot` credits the session, so "give
 * the role to B" would become B claiming it for themselves. The client checks
 * its own state; the SERVER checks again against the session that actually
 * carries the request, because a second tab can replace the shared cookie
 * between the client's check and the request.
 *
 * Pure and client-safe: the hook, `dispatchOp` and the three handlers share it.
 */

/** Thrown instead of replaying a role op under a different member. It stops the
 *  drain like any refusal that is NOT permanent: the op stays queued,
 *  `syncError` shows. */
export const ROLE_OP_OTHER_USER_MESSAGE =
	"Role changes queued on this device by another member are waiting. Sign in as them to sync.";

/** Who queued the op, as the client stamped it. `undefined` is an op queued
 *  before this existed (or a caller that does not say): it is not checked. */
export interface RoleOpQueuedBy {
	/** The member signed in when it was queued; null: nobody or a memberless
	 *  impersonating superadmin. */
	queuedBy?: string | null;
	/** The signed-in USER, the only identity an impersonating superadmin has. */
	queuedByUserId?: string | null;
}

/** Who the session carrying the request is. `memberId: undefined` means the
 *  member could not be resolved (an archived club refuses before it can). */
export interface RoleOpSession {
	memberId: string | null | undefined;
	userId: string | null;
}

/** True when the op was queued by someone other than the session's actor.
 *  By member id; when the member is unknown or null on both sides, by user id
 *  (the impersonator has no member). */
export function roleOpOwnerMismatch(
	queued: RoleOpQueuedBy,
	session: RoleOpSession,
): boolean {
	if (queued.queuedBy === undefined && queued.queuedByUserId === undefined) {
		return false;
	}
	const queuedMember = queued.queuedBy ?? null;
	if (
		session.memberId !== undefined &&
		(queuedMember !== null || session.memberId !== null)
	) {
		return queuedMember !== session.memberId;
	}
	if (queued.queuedByUserId === undefined) return false;
	return queued.queuedByUserId !== session.userId;
}
