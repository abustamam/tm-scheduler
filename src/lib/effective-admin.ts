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
 * "Is the viewer an effective admin of THIS club?" — stored `club_role =
 * "admin"` OR they hold any elected office (#202).
 *
 * The single definition both resolvers below share, so the club-in-context and
 * club-by-id paths cannot drift into two different answers to the same
 * question. It mirrors the server's `requireClubRole(userId, clubId,
 * ["admin"])`, which is the actual authorization boundary: every read and write
 * on an admin surface re-runs that per club, so what this decides is which page
 * a viewer is offered, not what they may see.
 */
function isEffectiveAdmin(
	context: ClubCtx,
	club: ClubCtx["clubs"][number],
): boolean {
	return club.clubRole === "admin" || context.officerPositions.length > 0;
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
	return isEffectiveAdmin(context, active) ? active : undefined;
}

/**
 * The same question asked about an EXPLICIT club instead of the active one
 * (#685).
 *
 * Why it exists: `/admin/club-settings` is context-scoped while the agenda
 * editor that links to it is URL-scoped (`/club/$clubId/…`). A multi-club admin
 * editing club B's agenda whose active club is A followed that link into A's
 * settings, changed the Table Topics window there, and the agenda they came
 * from was unaffected — which reads as "the setting did nothing". The link now
 * names the club it means, and this is what the route validates it with.
 *
 * Two rules, both load-bearing:
 *
 * - The id **selects among the viewer's OWN clubs** (`context.clubs` is their
 *   membership list). A club they are not in is not found here, so a
 *   caller-supplied id can never widen reach beyond where the context resolver
 *   could already have landed them.
 * - A refusal returns `undefined` and the caller must NOT fall back to the
 *   context-resolved club. Falling back reinstates the original bug in a harder
 *   form: the officer lands on some other club's settings again, now believing
 *   the link is fixed.
 *
 * One honest imprecision, recorded rather than papered over:
 * `context.officerPositions` is resolved for the ACTIVE club only
 * (`auth-context.ts` reads them off the active club's membership id), so for a
 * non-active club the office arm is a permissive signal, not a proof. Narrowing
 * it to `clubId === activeClubId` would lock out exactly the person this fix is
 * for — an officer-by-office of club B whose active club is A — since #202
 * exists because officers are typically NOT stored admins. The permissive
 * direction is safe because it is not the boundary: `requireClubRole` re-checks
 * per club on every read and write the settings page makes, and
 * `requireMeetingTemplateEditor` (the same check) already gated the agenda
 * editor the link is rendered on, so anyone who can SEE the link is admitted by
 * the server for that club.
 */
export function effectiveAdminClubFor<C extends ClubCtx>(
	context: C,
	clubId: string,
): C["clubs"][number] | undefined {
	const club = context.clubs.find((c) => c.clubId === clubId);
	if (!club) return undefined;
	return isEffectiveAdmin(context, club) ? club : undefined;
}
