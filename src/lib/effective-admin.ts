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

/**
 * The same question asked about an EXPLICIT club id instead of the active one
 * (#685) — for `/admin/club-settings?club=<uuid>`, whose caller already knows
 * which club it means.
 *
 * ## Why the office arm is narrower here, and why that costs nothing
 *
 * `effectiveAdminClub` above admits on `officerPositions.length > 0` without
 * looking at which club it was handed. That is sound for it — the club it
 * resolves IS the active club, and `auth-context.ts` reads officer positions off
 * the active club's membership id (`getOpenOfficerPositions(db,
 * currentMemberId)`), so the two always describe the same club. `OfficerPosition`
 * is a bare enum with no club on it, so there is nothing else to filter by.
 *
 * Reusing that arm for an arbitrary club is unsound in a way that is not
 * theoretical: an officer of club A who is a plain member of club B would pass
 * for B. That matters because this guard is the admin boundary for the settings
 * READS — all four (`getClubProfileSettings`, `loadClubReminderSettings`,
 * `loadClubAgendaSettings`, `loadClubTimezoneSettings`) gate on
 * `requireClubViewAccess`, which is member-level, and
 * `loadClubReminderSettings`'s own docblock says so ("any member with view
 * access — the route itself is admin-gated"). Only the WRITES run
 * `requireClubRole(…, ["admin"])`. So a permissive arm here renders club B's
 * real settings, not an error page.
 *
 * Restricting it to the active club costs nothing in practice, which is the
 * measured half rather than the hopeful half: `club.$clubId.tsx`'s `beforeLoad`
 * calls `publicShellDecision`, and for a signed-in member of the viewed club
 * whose active club differs it calls `setActiveClub` and re-runs on the same
 * URL. Every surface that can produce an explicit club id here therefore sits
 * under a route that has ALREADY made that club active. The narrow arm only
 * declines in the stale-tab case (another tab switched the active club after
 * this page rendered), and there it declines with a `/dashboard` bounce rather
 * than by showing the wrong club's settings.
 *
 * ## The other two rules
 *
 * - The id **selects among the viewer's OWN clubs** (`context.clubs` is their
 *   membership list), so a caller-supplied id can never reach a club they are
 *   not in.
 * - A refusal returns `undefined` and the caller must NOT fall back to the
 *   context-resolved club. Falling back reinstates #685 in a harder form: the
 *   officer lands on some other club's settings again, now believing the link
 *   is fixed.
 *
 * @param clubId a club UUID. NOT a slug — `resolveClubOrRedirect` canonicalises
 *   `/club/$clubId` to the club's SLUG, so a caller reading that URL segment
 *   must resolve it to `clubUuid` first or every lookup here misses.
 */
export function effectiveAdminClubFor<C extends ClubCtx>(
	context: C,
	clubId: string,
): C["clubs"][number] | undefined {
	const club = context.clubs.find((c) => c.clubId === clubId);
	if (!club) return undefined;
	const byOffice =
		clubId === context.activeClubId && context.officerPositions.length > 0;
	return club.clubRole === "admin" || byOffice ? club : undefined;
}
