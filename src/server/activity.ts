import type { db } from "#/db";
import { type activityActionEnum, activityLog } from "#/db/schema";
import { getImpersonatedWriteActor } from "./impersonation-actor";

/**
 * DERIVED from the Postgres enum, never hand-listed.
 *
 * This was a hand-maintained union that duplicated `activity_action`, and it had
 * already drifted: `superadmin_viewed` and `superadmin_acted` existed in the
 * database and not here. #510 hit the same trap from the other side — adding
 * `vote_open`/`vote_close` to the enum left `logActivity` unable to accept them,
 * and only `tsc` caught it.
 *
 * Deriving makes the database the single source of truth, so a new enum value is
 * usable the moment it is added and the two can never disagree again.
 */
type ActivityAction = (typeof activityActionEnum.enumValues)[number];

export interface ActivityInput {
	clubId: string;
	actorMemberId: string | null;
	action: ActivityAction;
	// "club" is for changes to club-level state that aren't tied to a slot,
	// meeting or member — the club logo (#495) is the first.
	targetType: "slot" | "meeting" | "member" | "club";
	targetId?: string | null;
	detail?: unknown;
	/**
	 * Real superadmin behind this write when it happens under a `read_write`
	 * impersonation session (#246). Usually omitted — `logActivity` reads the
	 * request-scoped marker set by the mutating guards. Pass explicitly only to
	 * override that resolution (e.g. in tests).
	 */
	impersonatedBy?: string | null;
}

// Accepts either the main db client or a drizzle transaction so callers can
// pass `tx` when logging inside a transaction for atomic commit.
type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * Append one row to the activity log. Pass a transaction (`tx`) when logging
 * inside the same transaction as the state change so the two commit together.
 */
export async function logActivity(
	conn: DbOrTx,
	input: ActivityInput,
): Promise<void> {
	// A read-write impersonated write is attributed to the real superadmin, not a
	// member: when set, `impersonated_by` carries the identity and `actor_member_id`
	// is null (the superadmin is memberless in the club). The explicit input wins;
	// otherwise read the request-scoped marker the mutating guards set (#246).
	const impersonatedBy =
		input.impersonatedBy !== undefined
			? input.impersonatedBy
			: getImpersonatedWriteActor();
	await conn.insert(activityLog).values({
		clubId: input.clubId,
		actorMemberId: impersonatedBy ? null : (input.actorMemberId ?? null),
		impersonatedBy: impersonatedBy ?? null,
		action: input.action,
		targetType: input.targetType,
		targetId: input.targetId ?? null,
		detail: input.detail ?? null,
	});
}
