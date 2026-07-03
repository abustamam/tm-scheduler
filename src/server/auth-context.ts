import { createServerFn } from "@tanstack/react-start";
import { and, asc, eq } from "drizzle-orm";
import { db } from "#/db";
import { clubMemberships, clubs, members } from "#/db/schema";
import { getSessionUser } from "./guards";

/**
 * Auth context for the app shell + route guards: the signed-in user (or null)
 * and the clubs they belong to, with their role in each. Also resolves the
 * signed-in user's linked roster member id (`currentMemberId`) for the active
 * club, so views can pass memberId/actorMemberId to slot mutations directly.
 *
 * Imported by the client layout, so this file must contain ONLY the server fn
 * (no stray db-touching exports) — the compiler strips the handler from the client.
 */
export const getAuthContext = createServerFn({ method: "GET" }).handler(
	async () => {
		const user = await getSessionUser();
		if (!user) {
			return { user: null, clubs: [] as const, currentMemberId: null };
		}
		const myClubs = await db
			.select({
				clubId: clubs.id,
				name: clubs.name,
				clubNumber: clubs.clubNumber,
				clubRole: clubMemberships.clubRole,
			})
			.from(clubMemberships)
			.innerJoin(clubs, eq(clubs.id, clubMemberships.clubId))
			.where(
				and(
					eq(clubMemberships.userId, user.id),
					eq(clubMemberships.status, "active"),
				),
			)
			.orderBy(asc(clubs.name));

		// Resolve the signed-in user's linked roster member for the active club
		// (clubs[0] — matching how the workspace picks the active club).
		let currentMemberId: string | null = null;
		const activeClubId = myClubs[0]?.clubId;
		if (activeClubId) {
			const [memberRow] = await db
				.select({ id: members.id })
				.from(members)
				.where(
					and(eq(members.userId, user.id), eq(members.clubId, activeClubId)),
				)
				.limit(1);
			currentMemberId = memberRow?.id ?? null;
		}

		return {
			user: { id: user.id, name: user.name, email: user.email },
			clubs: myClubs,
			currentMemberId,
		};
	},
);
