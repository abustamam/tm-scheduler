import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireClubRole, requireUser } from "./guards";
import { loadSeasonGrid } from "./season-grid-logic";

// Re-export the payload types so client code keeps importing them from
// `#/server/season-grid`. The db-touching `loadSeasonGrid` lives in
// `season-grid-logic.ts` (never imported by client routes) so it can't leak
// `#/db` into the browser bundle — see `server-modules.guard.test.ts`.
export type {
	SeasonGridCell,
	SeasonGridCount,
	SeasonGridData,
	SeasonGridMeeting,
	SeasonGridMember,
	SeasonGridRow,
	SlotStatus,
} from "./season-grid-logic";

export const getSeasonGrid = createServerFn({ method: "GET" })
	.validator((input: unknown) =>
		z
			.object({
				clubId: z.string().uuid(),
				count: z.union([z.literal(4), z.literal(8), z.literal("all")]),
			})
			.parse(input),
	)
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin", "vpe"]);
		return loadSeasonGrid(data);
	});
