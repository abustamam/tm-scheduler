import { createServerFn } from "@tanstack/react-start";
import { and, asc, eq } from "drizzle-orm";
import { db } from "#/db";
import { clubs, members, people } from "#/db/schema";
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

		// The signed-in user's roster member for the active club (clubs[0] —
		// matching how the workspace picks the active club).
		const currentMemberId = myMemberships[0]?.memberId ?? null;

		return {
			user: { id: user.id, name: user.name, email: user.email },
			clubs: myClubs,
			currentMemberId,
		};
	},
);
