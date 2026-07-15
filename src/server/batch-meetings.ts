import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { MAX_BATCH } from "#/lib/meeting-recurrence";
import {
	applyBatchCreateMeetings,
	listClubMeetingDates,
} from "./batch-meetings-logic";
import { requireClubAdminView, requireClubRole, requireUser } from "./guards";

const uuid = z.string().uuid();

const batchCreateSchema = z.object({
	clubId: uuid,
	// Wall-clock datetime-local strings in the club timezone, capped at MAX_BATCH.
	wallTimes: z
		.array(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/))
		.min(1)
		.max(MAX_BATCH),
	location: z.string().trim().optional(),
});

/** Admin only: create many meetings from a recurrence in one transaction, each
 *  with role slots from the club template. AUTHED — requires admin club role. */
export const batchCreateMeetings = createServerFn({ method: "POST" })
	.validator((input: unknown) => batchCreateSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return applyBatchCreateMeetings(data);
	});

/** Admin only: local calendar dates (club tz) that already have a meeting, for
 *  the batch preview's duplicate greying. AUTHED — requires admin club role. */
export const getClubMeetingDates = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubAdminView(currentUser.id, clubId);
		return listClubMeetingDates(clubId);
	});
