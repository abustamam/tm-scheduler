/**
 * The club's members as the near-name matchers see them, shared by
 * `record_attendance` and the guest-book planner (#1658) so the two read the
 * same rows in the same order. Any membership status: the writer's own rule
 * (`requireMemberInMeetingClub`).
 */
import { asc, eq } from "drizzle-orm";
import type { db } from "#/db";
import { members, people } from "#/db/schema";

type Conn =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

export function loadClubMemberMatchRows(conn: Conn, clubId: string) {
	return conn
		.select({
			id: members.id,
			name: members.name,
			preferredName: members.preferredName,
			email: people.email,
			phone: people.phone,
		})
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.where(eq(members.clubId, clubId))
		.orderBy(asc(members.name), asc(members.id));
}
