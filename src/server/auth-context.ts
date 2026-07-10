import { createServerFn } from "@tanstack/react-start";
import { getCookie, setCookie } from "@tanstack/react-start/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { clubs, members, people } from "#/db/schema";
import { ACTIVE_CLUB_COOKIE, resolveActiveClubId } from "#/lib/active-club";
import { getSessionUser } from "./guards";

/**
 * Auth context for the app shell + route guards: the signed-in user (or null)
 * and the clubs they belong to, with their role in each. Resolves the currently
 * active club (`activeClubId`, cookie-backed, defaulting to their first club)
 * and the signed-in user's linked roster member id (`currentMemberId`) for that
 * club, so views can pass memberId/actorMemberId to slot mutations directly.
 *
 * Imported by the client layout, so this file must contain ONLY server fns
 * (no stray db-touching exports) — the compiler strips the handlers from the client.
 */
export const getAuthContext = createServerFn({ method: "GET" }).handler(
	async () => {
		const user = await getSessionUser();
		if (!user) {
			return {
				user: null,
				clubs: [] as const,
				currentMemberId: null,
				activeClubId: null,
			};
		}
		// Resolve the signed-in user → Person (people.user_id) → their active
		// memberships, reading role + the member id per club (ADR-0008 Phase B).
		const myMemberships = await db
			.select({
				memberId: members.id,
				clubId: clubs.id,
				name: clubs.name,
				clubNumber: clubs.clubNumber,
				clubRole: members.clubRole,
			})
			.from(members)
			.innerJoin(people, eq(people.id, members.personId))
			.innerJoin(clubs, eq(clubs.id, members.clubId))
			.where(and(eq(people.userId, user.id), eq(members.status, "active")))
			.orderBy(asc(clubs.name));

		const myClubs = myMemberships.map((m) => ({
			clubId: m.clubId,
			name: m.name,
			clubNumber: m.clubNumber,
			clubRole: m.clubRole,
		}));

		// Active club = the cookie's club (if still a member) else their first.
		// getCookie can throw off a request context (tests) — tolerate that.
		let cookieClub: string | undefined;
		try {
			cookieClub = getCookie(ACTIVE_CLUB_COOKIE);
		} catch {
			cookieClub = undefined;
		}
		const activeClubId = resolveActiveClubId(
			myClubs.map((c) => c.clubId),
			cookieClub,
		);

		// The signed-in user's roster member for the active club.
		const currentMemberId =
			myMemberships.find((m) => m.clubId === activeClubId)?.memberId ?? null;

		return {
			user: { id: user.id, name: user.name, email: user.email },
			clubs: myClubs,
			currentMemberId,
			activeClubId,
		};
	},
);

/**
 * Persist the user's active-club choice (issue #10). Sets a year-long cookie;
 * `getAuthContext` re-validates it against live memberships on read, so this is
 * a plain setter (a bad value simply falls back to the default). The client
 * invalidates the router afterward to re-run loaders with the new active club.
 */
export const setActiveClub = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		z.object({ clubId: z.string().uuid() }).parse(input),
	)
	.handler(async ({ data }) => {
		setCookie(ACTIVE_CLUB_COOKIE, data.clubId, {
			path: "/",
			httpOnly: true,
			sameSite: "lax",
			maxAge: 60 * 60 * 24 * 365,
		});
		return { ok: true as const };
	});
