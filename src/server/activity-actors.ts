import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	type ActivityActorOption,
	loadActivityActorOptions,
} from "./activity-actors-logic";
import { requireClubAdminView, requireUser } from "./guards";

/**
 * The members the activity log can be filtered to (#1328): every membership,
 * former included. Same gate as `listActivity`, which this sits beside.
 */
export const listActivityActors = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => z.string().uuid().parse(clubId))
	.handler(async ({ data: clubId }): Promise<ActivityActorOption[]> => {
		const user = await requireUser();
		await requireClubAdminView(user.id, clubId);
		return loadActivityActorOptions(clubId);
	});
