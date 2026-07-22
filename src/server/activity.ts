import type { db } from "#/db";
import { activityLog } from "#/db/schema";
import { getImpersonatedWriteActor } from "./impersonation-actor";

type ActivityAction =
	| "claim"
	| "release"
	| "reassign"
	| "availability_set"
	| "availability_clear"
	| "member_add"
	| "member_edit"
	| "member_merge"
	| "member_remove"
	| "meeting_create"
	| "meeting_edit"
	| "outreach_set"
	| "outreach_clear";

export interface ActivityInput {
	clubId: string;
	actorMemberId: string | null;
	action: ActivityAction;
	targetType: "slot" | "meeting" | "member";
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
