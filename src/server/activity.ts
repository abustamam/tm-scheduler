import type { db as Db } from "#/db";
import { activityLog } from "#/db/schema";

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
	| "meeting_edit";

export interface ActivityInput {
	clubId: string;
	actorMemberId: string | null;
	action: ActivityAction;
	targetType: "slot" | "meeting" | "member";
	targetId?: string | null;
	detail?: unknown;
}

/**
 * Append one row to the activity log. Pass a transaction (`tx`) when logging
 * inside the same transaction as the state change so the two commit together.
 */
export async function logActivity(
	conn: typeof Db,
	input: ActivityInput,
): Promise<void> {
	await conn.insert(activityLog).values({
		clubId: input.clubId,
		actorMemberId: input.actorMemberId ?? null,
		action: input.action,
		targetType: input.targetType,
		targetId: input.targetId ?? null,
		detail: input.detail ?? null,
	});
}
