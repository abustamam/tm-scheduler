import { getRequest } from "@tanstack/react-start/server";
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { clubs, members, people, user } from "#/db/schema";
import { auth } from "#/lib/auth";
import { isClubArchived } from "#/lib/club-archive";
import { markImpersonatedWrite } from "./impersonation-actor";
import { getActiveImpersonation } from "./impersonation-logic";
import {
	type MeetingAgendaAuthz,
	resolveMeetingAgendaAuthz,
} from "./meeting-authz-logic";
import { getOpenOfficerPositions } from "./officers-logic";

// IMPORTANT: this module touches `db`/`pg` and must never be imported by a
// client component directly. Only server-function modules import it; the
// TanStack Start compiler then strips it from the client bundle. The
// `getAuthContext` server fn (imported by the layout) lives in its own file
// (auth-context.ts) for the same reason.

export type ClubRole = "admin" | "member";

/** Raw session user (or null) for the current request. Server-only.
 *  Returns null when called outside a request context (e.g. integration tests
 *  or public server fns invoked without a session). */
export async function getSessionUser() {
	try {
		const request = getRequest();
		const session = await auth.api.getSession({ headers: request.headers });
		return session?.user ?? null;
	} catch {
		// No request context (test env, direct call) — treat as unauthenticated.
		return null;
	}
}

/** Like getSessionUser but throws — use inside mutating server fns. */
export async function requireUser() {
	const user = await getSessionUser();
	if (!user) {
		throw new Error("You need to be signed in to do that.");
	}
	return user;
}

/**
 * Resolve the signed-in user's membership in a club (ADR-0008 Phase B / #99):
 * user → Person (`people.user_id`) → the `members` row for that person in this
 * club. Returns the membership's id, role and status, or null when the user has
 * no linked person or no membership in the club.
 */
export async function getMembership(userId: string, clubId: string) {
	const [membership] = await db
		.select({
			id: members.id,
			clubId: members.clubId,
			personId: members.personId,
			clubRole: members.clubRole,
			status: members.status,
		})
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.where(and(eq(people.userId, userId), eq(members.clubId, clubId)))
		.limit(1);
	return membership ?? null;
}

/**
 * A resolved WRITE actor for a club: either a real active membership, or — under
 * a `read_write` impersonation session (#246) — a memberless synthetic
 * effective-admin. The synthetic arm carries `id: null` (the superadmin has no
 * `members` row, so it can never be used as a real `actor_member_id`) and
 * `impersonatedBy` = the real superadmin user id.
 */
type RealMembership = NonNullable<Awaited<ReturnType<typeof getMembership>>>;
export type ResolvedMembership =
	| (RealMembership & { impersonatedBy?: null })
	| {
			id: null;
			clubId: string;
			personId: null;
			clubRole: "admin";
			status: "active";
			impersonatedBy: string;
	  };

/** Reject when a club is soft-archived (ADR-0016 / #186) — archiving locks out
 *  every member and admin. Shared by the real and impersonated write paths. */
async function assertClubNotArchived(clubId: string): Promise<void> {
	const [club] = await db
		.select({ archivedAt: clubs.archivedAt })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	if (club && isClubArchived(club)) {
		throw new Error("This club has been archived.");
	}
}

/**
 * WRITE fallback for a superadmin with an active `read_write` "act as admin"
 * session (#246): grant a memberless effective-admin and mark the request so
 * every `logActivity` in it is attributed to the real superadmin. A `read_only`
 * session does NOT match here — read-only stays write-blind by construction.
 * Throws (memberless) otherwise, so callers keep their normal rejection.
 */
async function requireReadWriteImpersonation(
	userId: string,
	clubId: string,
): Promise<ResolvedMembership> {
	const session = await getActiveImpersonation(userId, clubId);
	if (session?.mode === "read_write") {
		// Parity: a real admin can't act on an archived club, so neither can the
		// impersonating superadmin.
		await assertClubNotArchived(clubId);
		markImpersonatedWrite(userId);
		return {
			id: null,
			clubId,
			personId: null,
			clubRole: "admin",
			status: "active",
			impersonatedBy: userId,
		};
	}
	throw new Error("You're not a member of this club.");
}

/** Any active member may view/claim. Rejects when the club is soft-archived
 *  (ADR-0016 / #186): archiving makes a club inaccessible to every member and
 *  admin. This is the single authed choke point — `requireClubRole` builds on it
 *  — so the one check here covers all authed member/admin operations. A
 *  `read_write` impersonation session resolves to a memberless effective-admin
 *  here (#246); a `read_only` session does not (writes stay blind by construction). */
export async function requireMembership(
	userId: string,
	clubId: string,
): Promise<ResolvedMembership> {
	const membership = await getMembership(userId, clubId);
	if (!membership || membership.status !== "active") {
		return requireReadWriteImpersonation(userId, clubId);
	}
	await assertClubNotArchived(clubId);
	return membership;
}

/**
 * Gate admin actions to the given club roles. Effective-admin (#202): when
 * `admin` is required and the stored `club_role` isn't admin, an elected officer
 * (any open `officer_terms` row) still passes — every officer is a full admin.
 */
export async function requireClubRole(
	userId: string,
	clubId: string,
	roles: ClubRole[],
): Promise<ResolvedMembership> {
	const membership = await requireMembership(userId, clubId);
	// A read-write impersonating superadmin acts with full admin authority (#246):
	// they satisfy any required role, mirroring "everything a club admin can do".
	if (membership.impersonatedBy) {
		return membership;
	}
	if (roles.includes(membership.clubRole)) {
		return membership;
	}
	if (
		roles.includes("admin") &&
		membership.id !== null &&
		(await getOpenOfficerPositions(db, membership.id)).length > 0
	) {
		return membership;
	}
	throw new Error("You don't have permission to do that.");
}

/**
 * READ-surface "can this user manage this club as an admin?" — for computing the
 * `canManage` / `canEdit` flags that GET loaders return to drive admin
 * affordances (e.g. `getMeeting`, `getMinutes`). True for a real active admin
 * membership OR an active `read_write` impersonation session (#246): a superadmin
 * acting as admin has no membership but should see the admin UI. Deliberately
 * does NOT grant for `read_only` impersonation — read-only keeps those write
 * surfaces hidden. The write itself is still enforced by the mutating guards, so
 * this only decides what affordances render. The impersonation lookup runs only
 * when there's no real membership (zero cost for real members).
 */
export async function canManageClub(
	userId: string,
	clubId: string,
): Promise<boolean> {
	const membership = await getMembership(userId, clubId);
	if (membership) return membership.clubRole === "admin";
	const session = await getActiveImpersonation(userId, clubId);
	return session?.mode === "read_write";
}

/**
 * Read-access grant for a club (#185 / ADR-0020). Returned by the read-only view
 * guards: `via` is `"member"` for a real membership, `"impersonation"` for a
 * superadmin viewing via an active session (then `membership` is null).
 */
export interface ClubViewAccess {
	via: "member" | "impersonation";
	impersonating: boolean;
	/** The real membership when `via === "member"`; null when impersonating. */
	membership: Awaited<ReturnType<typeof getMembership>> | null;
}

/**
 * MEMBER-level READ access (#185): any real active member, OR a superadmin with
 * an active read-only impersonation session for this club. Use in GET server fns
 * where `requireMembership` gated a view. NEVER call from a mutating fn — the
 * write guards stay impersonation-blind so read-only holds by construction.
 */
export async function requireClubViewAccess(
	userId: string,
	clubId: string,
): Promise<ClubViewAccess> {
	const membership = await getMembership(userId, clubId);
	if (membership && membership.status === "active") {
		return { via: "member", impersonating: false, membership };
	}
	if (await getActiveImpersonation(userId, clubId)) {
		return { via: "impersonation", impersonating: true, membership: null };
	}
	throw new Error("You're not a member of this club.");
}

/**
 * ADMIN-level READ access (#185): a real club admin (stored `admin` or any open
 * officer term — effective-admin), OR a superadmin with an active read-only
 * impersonation session. Use in GET server fns where `requireClubRole(["admin"])`
 * gated an admin-only view. NEVER call from a mutating fn.
 */
export async function requireClubAdminView(
	userId: string,
	clubId: string,
): Promise<ClubViewAccess> {
	const membership = await getMembership(userId, clubId);
	if (membership && membership.status === "active") {
		if (membership.clubRole === "admin") {
			return { via: "member", impersonating: false, membership };
		}
		if ((await getOpenOfficerPositions(db, membership.id)).length > 0) {
			return { via: "member", impersonating: false, membership };
		}
	}
	if (await getActiveImpersonation(userId, clubId)) {
		return { via: "impersonation", impersonating: true, membership: null };
	}
	throw new Error("You don't have permission to view this club.");
}

/**
 * Gate a platform-level action to superadmins (ADR-0016 / #183). This is the
 * global `user.is_superadmin` flag (provisioned from SUPERADMIN_EMAILS),
 * ORTHOGONAL to any per-club membership — it deliberately does NOT grant ambient
 * cross-club access (that's deferred to #185). Throws when the user is not a
 * superadmin.
 */
export async function requireSuperadmin(userId: string) {
	const [row] = await db
		.select({ isSuperadmin: user.isSuperadmin })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	if (!row?.isSuperadmin) {
		throw new Error("You don't have permission to do that.");
	}
}

/**
 * Gate a per-meeting agenda write (meta edit + slot management). Allowed when
 * the current session is a club `admin` OR the self-asserted `selfMemberId`
 * holds the meeting's TMOD slot (ADR-0010). Throws when neither path applies.
 * Returns the resolved authz so callers can keep reschedule/cancel/status
 * admin-only (`via === "admin"`).
 */
export async function requireMeetingAgendaEditor(input: {
	meetingId: string;
	selfMemberId?: string | null;
}): Promise<MeetingAgendaAuthz> {
	const user = await getSessionUser();
	const authz = await resolveMeetingAgendaAuthz({
		meetingId: input.meetingId,
		sessionUserId: user?.id ?? null,
		selfMemberId: input.selfMemberId ?? null,
	});
	if (!authz.allowed) {
		throw new Error("You don't have permission to edit this meeting.");
	}
	return authz;
}

/** Fetch a roster member by id (server-only, no auth check). */
export async function getMember(memberId: string) {
	const [member] = await db
		.select()
		.from(members)
		.where(eq(members.id, memberId))
		.limit(1);
	return member ?? null;
}

/** Validate that a memberId exists, belongs to the given clubId, and is active.
 *  Throws otherwise. Gates claiming / reassignment / availability so inactive
 *  (unrenewed) members can't claim or be assigned new roles. */
export async function requireMemberInClub(memberId: string, clubId: string) {
	const member = await getMember(memberId);
	if (!member || member.clubId !== clubId) {
		throw new Error("Member not found in this club.");
	}
	if (member.status === "inactive") {
		throw new Error("That member is inactive — reactivate them first.");
	}
	return member;
}
