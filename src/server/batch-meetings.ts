import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { MEETING_FIELDS } from "#/lib/meeting-limits";
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
	// CAPPED like every other meeting write (#525). Missed on the first pass:
	// this path writes one row per date, up to `MAX_BATCH` (52) in a single
	// transaction, and the value is then served to ANONYMOUS readers on the
	// public meeting page. Rejecting is right here — a batch create prefills
	// nothing, so an error costs only the field being typed.
	location: MEETING_FIELDS.location.optional(),
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
