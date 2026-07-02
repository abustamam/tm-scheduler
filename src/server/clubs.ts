import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	applyClubProfileUpdate,
	clubProfileSchema,
	getClubProfile,
	resolveClubByIdentifier,
} from "./clubs-logic";
import { requireClubRole, requireMembership, requireUser } from "./guards";

const uuid = z.string().uuid();

/** Resolve a club URL segment (slug | club number | UUID) to the club.
 *  PUBLIC — no session required. */
export const getClubByIdentifier = createServerFn({ method: "GET" })
	.validator((identifier: unknown) => z.string().min(1).parse(identifier))
	.handler(async ({ data }) => resolveClubByIdentifier(data));

/** The club's free-text profile fields (district / mission / meeting schedule)
 *  for the settings form. AUTHED — any active member of the club. */
export const getClubProfileSettings = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireMembership(currentUser.id, clubId);
		return getClubProfile(clubId);
	});

/** Set/clear the club's district, mission, and meeting schedule.
 *  AUTHED — requires admin/vpe club role. */
export const updateClubProfile = createServerFn({ method: "POST" })
	.validator((input: unknown) => clubProfileSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin", "vpe"]);
		return applyClubProfileUpdate(data);
	});
