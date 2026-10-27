import { asc, eq } from "drizzle-orm";
import { db } from "#/db";
import { members } from "#/db/schema";

/** One option of the activity log's member filter (#1328): names and status only. */
export interface ActivityActorOption {
	id: string;
	name: string;
	status: "active" | "inactive" | "former";
}

/**
 * Every membership of the club, former included, for the activity log's
 * "filter by member" list. A former member's past actions are history that
 * stays (#1239), so they must be reachable. NO contact, and deliberately not in
 * `club-logic.ts`: that module's importers are pinned to one auth gate because
 * it returns contact details.
 */
export async function loadActivityActorOptions(
	clubId: string,
): Promise<ActivityActorOption[]> {
	return db
		.select({ id: members.id, name: members.name, status: members.status })
		.from(members)
		.where(eq(members.clubId, clubId))
		.orderBy(asc(members.name));
}
