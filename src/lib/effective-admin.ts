import type { OfficerPosition } from "./officers";

interface ClubCtx {
	clubs: readonly {
		clubId: string;
		name: string;
		clubNumber: string | null;
		clubRole: "admin" | "member";
	}[];
	activeClubId: string | null;
	officerPositions: readonly OfficerPosition[];
}

/**
 * The club the workspace is acting in, IF the signed-in user is an effective
 * admin there — stored `club_role = "admin"` OR they hold any elected office
 * (#202). Returns `undefined` when they're not an admin, so route `beforeLoad`
 * guards can `if (!effectiveAdminClub(context)) throw redirect(...)`. Scoped to
 * the active club (officer positions are resolved for the active club).
 */
export function effectiveAdminClub<C extends ClubCtx>(
	context: C,
): C["clubs"][number] | undefined {
	const active =
		context.clubs.find((c) => c.clubId === context.activeClubId) ??
		context.clubs[0];
	if (!active) return undefined;
	const isAdmin =
		active.clubRole === "admin" || context.officerPositions.length > 0;
	return isAdmin ? active : undefined;
}
