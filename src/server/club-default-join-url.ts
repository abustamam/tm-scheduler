// The "Apply to N upcoming meetings without a link" button on club settings
// (#1534). A separate module from `clubs.ts` only so that file stays untouched;
// the logic is in `clubs-logic.ts`.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	applyDefaultJoinUrlToUpcoming,
	countUpcomingMeetingsWithoutJoinUrl,
} from "./clubs-logic";
import { assertClubNotArchived, requireClubRole, requireUser } from "./guards";

const uuid = z.string().uuid();

/** How many upcoming meetings have no link. AUTHED: club admin. */
export const countMeetingsWithoutJoinUrl = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, clubId, ["admin"]);
		return countUpcomingMeetingsWithoutJoinUrl(clubId);
	});

/** Write the stored default link onto upcoming meetings that have none.
 *  AUTHED: club admin, club not archived. */
export const applyDefaultJoinUrl = createServerFn({ method: "POST" })
	.validator((input: unknown) => z.object({ clubId: uuid }).parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		await assertClubNotArchived(data.clubId);
		return applyDefaultJoinUrlToUpcoming(data.clubId);
	});
