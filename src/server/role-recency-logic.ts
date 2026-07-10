// Role-recency lookup for the VPE/TM assign picker (#146): "when did this member
// last hold this role". Split out from the createServerFn modules (the
// server-modules guard forbids db-touching exports there) so it is
// integration-testable by mocking `#/db`.
import { and, eq, lt, max, ne } from "drizzle-orm";
import { db } from "#/db";
import { meetings, roleSlots } from "#/db/schema";

/** One member's most-recent prior assignment to one role definition. */
export interface RoleRecencyRow {
	roleDefinitionId: string;
	memberId: string;
	lastServedAt: Date;
}

/**
 * For every (roleDefinitionId, memberId) pair in a club, the most recent meeting
 * date at which that member was assigned that role — counting only assignments in
 * non-cancelled meetings scheduled strictly before `before` (the target meeting's
 * date). Slot status is irrelevant: for a past meeting the assignment happened.
 */
export async function loadRoleRecency(input: {
	clubId: string;
	before: Date;
}): Promise<RoleRecencyRow[]> {
	const rows = await db
		.select({
			roleDefinitionId: roleSlots.roleDefinitionId,
			memberId: roleSlots.assignedMemberId,
			lastServedAt: max(meetings.scheduledAt),
		})
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(
			and(
				eq(meetings.clubId, input.clubId),
				ne(meetings.status, "cancelled"),
				lt(meetings.scheduledAt, input.before),
			),
		)
		.groupBy(roleSlots.roleDefinitionId, roleSlots.assignedMemberId);

	// Drop pairs with no assignee (open slots) or no date; narrow the nullable
	// columns for the caller.
	return rows.flatMap((r) =>
		r.memberId && r.lastServedAt
			? [
					{
						roleDefinitionId: r.roleDefinitionId,
						memberId: r.memberId,
						lastServedAt: r.lastServedAt,
					},
				]
			: [],
	);
}

/** Transport shape for the picker: roleDefinitionId → memberId → ISO date. */
export type RoleRecencyIndex = Record<string, Record<string, string>>;

/**
 * Reshape recency rows into a `roleDefinitionId → memberId → ISO date` lookup for
 * the picker. Values are ISO strings because Dates are serialized to strings
 * across the server-fn boundary; the assign sheet selects the inner map for the
 * open slot's role and revives the dates.
 */
export function indexRoleRecency(rows: RoleRecencyRow[]): RoleRecencyIndex {
	const byRole: RoleRecencyIndex = {};
	for (const r of rows) {
		let forRole = byRole[r.roleDefinitionId];
		if (!forRole) {
			forRole = {};
			byRole[r.roleDefinitionId] = forRole;
		}
		forRole[r.memberId] = r.lastServedAt.toISOString();
	}
	return byRole;
}
