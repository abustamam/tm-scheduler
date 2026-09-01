import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	applyClubAgendaSettingsUpdate,
	applyClubProfileUpdate,
	applyClubTimezoneUpdate,
	clubAgendaSettingsSchema,
	clubProfileSchema,
	clubTimezoneSchema,
	getClubAgendaSettings,
	getClubProfile,
	getClubTimezoneSettings,
	getPublicClubProfile,
	resolvePublicClubIdentifier,
} from "./clubs-logic";
import { requireClubRole, requireClubViewAccess, requireUser } from "./guards";

const uuid = z.string().uuid();

/** Resolve a club URL segment (slug | club number | UUID) to the club.
 *  PUBLIC — no session required. */
export const getClubByIdentifier = createServerFn({ method: "GET" })
	.validator((identifier: unknown) => z.string().min(1).parse(identifier))
	.handler(async ({ data }) => resolvePublicClubIdentifier(data));

/** The club's free-text profile fields (district / mission / meeting schedule)
 *  for the settings form. AUTHED — any active member of the club. */
export const getClubProfileSettings = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubViewAccess(currentUser.id, clubId);
		return getClubProfile(clubId);
	});

/** The club's public-facing profile (district / mission / meeting schedule) for
 *  the "About this club" block a guest sees on the public club page (#318).
 *  PUBLIC — no session required, mirroring `getPublicClubRoles`. Returns a
 *  narrower shape than `getClubProfileSettings`; see `getPublicClubProfile`. */
export const getPublicClubProfileFn = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => getPublicClubProfile(clubId));

/** Set/clear the club's district, mission, and meeting schedule.
 *  AUTHED — requires admin club role. */
export const updateClubProfile = createServerFn({ method: "POST" })
	.validator((input: unknown) => clubProfileSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return applyClubProfileUpdate(data);
	});

/** The club's agenda run-of-show settings (#367) for the settings form.
 *  AUTHED — any active member of the club. */
export const loadClubAgendaSettings = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubViewAccess(currentUser.id, clubId);
		return getClubAgendaSettings(clubId);
	});

/** Choose who introduces the functionaries on the generated agenda (#367).
 *  AUTHED — requires admin club role. */
export const updateClubAgendaSettings = createServerFn({ method: "POST" })
	.validator((input: unknown) => clubAgendaSettingsSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return applyClubAgendaSettingsUpdate(data);
	});

/** The club's timezone and the zones it may be set to, for the settings form
 *  (#547). AUTHED — any active member of the club. */
export const loadClubTimezoneSettings = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubViewAccess(currentUser.id, clubId);
		return getClubTimezoneSettings(clubId);
	});

/** Set the club's timezone — the zone every club-local boundary is measured in
 *  (#547). AUTHED — requires admin club role. */
export const updateClubTimezone = createServerFn({ method: "POST" })
	.validator((input: unknown) => clubTimezoneSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return applyClubTimezoneUpdate(data);
	});
