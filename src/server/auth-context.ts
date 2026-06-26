import { createServerFn } from "@tanstack/react-start";
import { and, asc, eq } from "drizzle-orm";
import { db } from "#/db";
import { clubMemberships, clubs } from "#/db/schema";
import { getSessionUser } from "./guards";

/**
 * Auth context for the app shell + route guards: the signed-in user (or null)
 * and the clubs they belong to, with their role in each. Imported by the
 * client layout, so this file must contain ONLY the server fn (no stray
 * db-touching exports) — the compiler strips the handler from the client.
 */
export const getAuthContext = createServerFn({ method: "GET" }).handler(
	async () => {
		const user = await getSessionUser();
		if (!user) {
			return { user: null, clubs: [] as const };
		}
		const myClubs = await db
			.select({
				clubId: clubs.id,
				name: clubs.name,
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
		return {
			user: { id: user.id, name: user.name, email: user.email },
			clubs: myClubs,
		};
	},
);
