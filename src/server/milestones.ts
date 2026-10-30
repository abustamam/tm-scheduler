// `getMyMilestones` (#1425): the signed-in member's own milestone counts for
// the active club. The membership comes from the session, never from input.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireClubViewAccess, requireUser } from "./guards";
import { loadMilestoneCounts } from "./milestones-logic";

const input = z.object({ clubId: z.string().uuid() });

export const getMyMilestones = createServerFn({ method: "GET" })
	.validator((i: unknown) => input.parse(i))
	.handler(
		async ({
			data,
		}): Promise<{
			memberId: string;
			speechesDelivered: number;
			meetingsAttended: number;
		} | null> => {
			const user = await requireUser();
			const access = await requireClubViewAccess(user.id, data.clubId);
			if (!access.membership) return null;
			const counts = await loadMilestoneCounts(access.membership.id);
			return { memberId: access.membership.id, ...counts };
		},
	);
