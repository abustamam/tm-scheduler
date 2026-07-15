import { createServerFn } from "@tanstack/react-start";
import {
	type ActivityEntry,
	listActivitySchema,
	loadActivity,
} from "./activity-feed-logic";
import { requireClubAdminView, requireUser } from "./guards";

// Re-export the feed types for client/lib consumers (e.g. lib/activity-format).
// These are type-only, so they pull no runtime db code into the client.
export type { ActivityEntry, ListActivityInput } from "./activity-feed-logic";

/** Officer-only (admin) reverse-chron activity feed for a club. */
export const listActivity = createServerFn({ method: "GET" })
	.validator((i: unknown) => listActivitySchema.parse(i))
	.handler(async ({ data }): Promise<ActivityEntry[]> => {
		const user = await requireUser();
		await requireClubAdminView(user.id, data.clubId);
		return loadActivity(data);
	});
