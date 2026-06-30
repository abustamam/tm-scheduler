import { createServerFn } from "@tanstack/react-start";
import {
	type ActivityEntry,
	listActivitySchema,
	loadActivity,
} from "./activity-feed-logic";
import { requireClubRole, requireUser } from "./guards";

// Re-export the feed types for client/lib consumers (e.g. lib/activity-format).
// These are type-only, so they pull no runtime db code into the client.
export type { ActivityEntry, ListActivityInput } from "./activity-feed-logic";

/** VPE-only (admin/vpe) reverse-chron activity feed for a club. */
export const listActivity = createServerFn({ method: "GET" })
	.validator((i: unknown) => listActivitySchema.parse(i))
	.handler(async ({ data }): Promise<ActivityEntry[]> => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin", "vpe"]);
		return loadActivity(data);
	});
