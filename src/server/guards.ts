import { getRequest } from "@tanstack/react-start/server";
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { clubMemberships, members } from "#/db/schema";
import { auth } from "#/lib/auth";

// IMPORTANT: this module touches `db`/`pg` and must never be imported by a
// client component directly. Only server-function modules import it; the
// TanStack Start compiler then strips it from the client bundle. The
// `getAuthContext` server fn (imported by the layout) lives in its own file
// (auth-context.ts) for the same reason.

export type ClubRole = "admin" | "vpe" | "member";

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

export async function getMembership(userId: string, clubId: string) {
	const [membership] = await db
		.select()
		.from(clubMemberships)
		.where(
			and(
				eq(clubMemberships.userId, userId),
				eq(clubMemberships.clubId, clubId),
			),
		)
		.limit(1);
	return membership ?? null;
}

/** Any active member may view/claim. */
export async function requireMembership(userId: string, clubId: string) {
	const membership = await getMembership(userId, clubId);
	if (!membership || membership.status !== "active") {
		throw new Error("You're not a member of this club.");
	}
	return membership;
}

/** Gate admin actions to the given club roles. */
export async function requireClubRole(
	userId: string,
	clubId: string,
	roles: ClubRole[],
) {
	const membership = await requireMembership(userId, clubId);
	if (!roles.includes(membership.clubRole)) {
		throw new Error("You don't have permission to do that.");
	}
	return membership;
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
