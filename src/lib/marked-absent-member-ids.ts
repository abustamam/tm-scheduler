import type { PlanStatus } from "#/lib/attendance-panel";

/**
 * The unavailable members who did NOT say so themselves (#1344): the roll marked
 * them Absent, but the PUBLIC plan answers carry no `not_coming` for them.
 *
 * `<MeetingAgenda>` says "You're marked absent." on the viewer's own card only
 * for these ids; for the rest of `unavailableMemberIds` the member said Not
 * coming and the card says "You said you can't make it".
 *
 * Derived from the two public values only. The roll is members-only and the
 * meeting payload reaches signed-out readers, so this list is never read off
 * the roll and never becomes a payload field: `unavailableMemberIds` already
 * folds the roll in (Absent is unavailable whatever the plan says), and
 * `answeredRungs` is the plan answer the payload shows everyone.
 *
 * `answeredRungs` is typed to the whole plan vocabulary rather than the
 * `coming | not_coming` the payload carries today, so a `reached_out` row (the
 * officer's ask, not the member's answer) is covered by this function's own
 * contract, not by an upstream filter staying put. Only `not_coming` subtracts.
 *
 * Pure so a vitest can reach it: the route that calls it cannot be mounted.
 */
export function markedAbsentMemberIds(
	unavailableMemberIds: readonly string[],
	answeredRungs: readonly { memberId: string; status: PlanStatus }[],
): string[] {
	return unavailableMemberIds.filter(
		(id) =>
			!answeredRungs.some(
				(r) => r.memberId === id && r.status === "not_coming",
			),
	);
}
