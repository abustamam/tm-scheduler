import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { members, people } from "#/db/schema";
import { auth } from "#/lib/auth";
import {
	type ClaimOutcome,
	claimPersonForUser,
	clubIdForMember,
	type InvitePrepOutcome,
	prepareMemberInvite,
} from "./account-invite-logic";
import { requireClubRole, requireUser } from "./guards";

// The post-verification landing that finishes linking the picked Person to the
// freshly-signed-in account (see `src/routes/claim.tsx`). Same-origin relative
// path so Better-Auth's magic-link `originCheck` accepts it as a callbackURL.
function claimCallbackURL(memberId: string): string {
	return `/claim?person=${encodeURIComponent(memberId)}`;
}

/**
 * Send an admin-initiated account-invite magic link to a roster member (#266,
 * Part A). Admin-gated. The link goes to the Person's OWN email on file — never
 * an arbitrary address — so acceptance provably links exactly that Person. The
 * server-side `auth.api.signInMagicLink` call is the same secure magic-link path
 * user sign-in uses; `metadata.kind: "invite"` swaps in the invitation email copy.
 */
export const inviteMember = createServerFn({ method: "POST" })
	.validator((i: unknown) =>
		z
			.object({ clubId: z.string().uuid(), memberId: z.string().uuid() })
			.parse(i),
	)
	.handler(async ({ data }): Promise<{ outcome: InvitePrepOutcome }> => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);

		const prep = await prepareMemberInvite(data);
		if (prep.outcome !== "ready") return { outcome: prep.outcome };

		const request = getRequest();
		await auth.api.signInMagicLink({
			body: {
				email: prep.email as string,
				callbackURL: claimCallbackURL(data.memberId),
				metadata: { kind: "invite", clubName: prep.clubName },
			},
			headers: request.headers,
		});
		return { outcome: "ready" };
	});

export interface BulkInviteResult {
	sent: number;
	alreadyJoined: number;
	noEmail: number;
	recentlyInvited: number;
}

/**
 * Invite every not-yet-joined roster member with an email in one action (#266,
 * Part A — the optional bulk case). Admin-gated. Iterates the club's active
 * members, sending one magic link each; already-linked members and members with
 * no email on file are counted and skipped (never resent, never errored). The
 * per-invite `auth.api` call bypasses the HTTP magic-link rate limiter (that
 * limiter runs only in the request `onRequest` path), so a full roster send in
 * one click is fine.
 */
export const inviteAllMembers = createServerFn({ method: "POST" })
	.validator((i: unknown) => z.object({ clubId: z.string().uuid() }).parse(i))
	.handler(async ({ data }): Promise<BulkInviteResult> => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);

		// Candidate memberships: active members whose Person isn't already linked.
		const rows = await db
			.select({ memberId: members.id })
			.from(members)
			.innerJoin(people, eq(people.id, members.personId))
			.where(
				and(
					eq(members.clubId, data.clubId),
					ne(members.status, "inactive"),
					isNull(people.userId),
				),
			);

		const request = getRequest();
		const result: BulkInviteResult = {
			sent: 0,
			alreadyJoined: 0,
			noEmail: 0,
			recentlyInvited: 0,
		};
		for (const row of rows) {
			const prep = await prepareMemberInvite({
				clubId: data.clubId,
				memberId: row.memberId,
				respectCooldown: true,
			});
			if (prep.outcome === "already_joined") {
				result.alreadyJoined += 1;
				continue;
			}
			if (prep.outcome === "no_email") {
				result.noEmail += 1;
				continue;
			}
			if (prep.outcome === "recently_invited") {
				result.recentlyInvited += 1;
				continue;
			}
			await auth.api.signInMagicLink({
				body: {
					email: prep.email as string,
					callbackURL: claimCallbackURL(row.memberId),
					metadata: { kind: "invite", clubName: prep.clubName },
				},
				headers: request.headers,
			});
			result.sent += 1;
		}
		return result;
	});

export interface FinishClaimResult {
	outcome: ClaimOutcome;
	/** The club to land in after a successful link (null when unresolved). */
	clubId: string | null;
}

/**
 * Finish an account claim/invite-accept: bind the picked Person to the current
 * signed-in account (#266). Called by the `/claim` landing after magic-link
 * sign-in — for BOTH the admin invite and the public "This is me" claim. Requires
 * a session (the magic link proved email ownership); the linking rule lives in
 * `claimPersonForUser` and is idempotent + refuses to steal another user's link.
 */
export const finishAccountClaim = createServerFn({ method: "POST" })
	.validator((i: unknown) => z.object({ memberId: z.string().uuid() }).parse(i))
	.handler(async ({ data }): Promise<FinishClaimResult> => {
		const user = await requireUser();
		const outcome = await claimPersonForUser({
			memberId: data.memberId,
			userId: user.id,
		});
		const clubId = await clubIdForMember(data.memberId);
		return { outcome, clubId };
	});
