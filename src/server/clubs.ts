import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "#/db";
import {
	assertGeChangeAllowed,
	isClubAgendaAdopted,
} from "./club-agendas-logic";
import {
	getClubCharter,
	markClubChartered,
	markClubCharteredSchema,
	updateCharterDateSchema,
	updateClubCharterDate,
} from "./club-charter-logic";
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
import { isDemoClub } from "./demo-club-flag";
import { DemoError, resetDemoClub } from "./demo-reset-logic";
import { requireClubRole, requireClubViewAccess, requireUser } from "./guards";

const uuid = z.string().uuid();

/** Resolve a club URL segment (slug | club number | UUID) to the club.
 *  PUBLIC — no session required. */
export const getClubByIdentifier = createServerFn({ method: "GET" })
	.validator((identifier: unknown) => z.string().min(1).parse(identifier))
	.handler(async ({ data }) => resolvePublicClubIdentifier(data));

/** The club's free-text profile fields (district / mission / meeting schedule)
 *  for the settings form, plus `isDemo` (#1200): the page shows the demo club's
 *  reset card from it, which is display only, the server's check is the one that
 *  counts (`resetDemoClubFromClub`). AUTHED — any active member of the club. */
export const getClubProfileSettings = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubViewAccess(currentUser.id, clubId);
		const profile = await getClubProfile(clubId);
		if (!profile) return null;
		return { ...profile, isDemo: await isDemoClub(db, clubId) };
	});

const resetDemoClubSchema = z.object({ clubId: uuid });

/** Delete the demo club and build it again from the fixture, from inside it
 *  (#1200): on a presenting laptop the presenter is signed in as the demo
 *  account, not as a superadmin. AUTHED — requires admin club role in `clubId`.
 *
 *  `expectClubId` makes the logic refuse (`NOT_DEMO_CLUB`) unless `clubId` IS the
 *  demo club, so an admin of a real club who calls this deletes nothing. The
 *  actor is re-checked inside the logic's transaction, after its locks. An
 *  unlocked `isDemoClub` check comes first, so an admin of a real club takes no
 *  demo lock and learns nothing about the operator's `DEMO_ACCOUNT_EMAIL`
 *  config: the logic's config refusals run before its own `expectClubId` check. */
export const resetDemoClubFromClub = createServerFn({ method: "POST" })
	.validator((input: unknown) => resetDemoClubSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		if (!(await isDemoClub(db, data.clubId))) {
			throw new DemoError("NOT_DEMO_CLUB");
		}
		return resetDemoClub({
			now: new Date(),
			actor: { kind: "clubAdmin", userId: currentUser.id },
			expectClubId: data.clubId,
		});
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

/** The club's agenda run-of-show settings (#367) for the settings form, plus
 *  `adopted` (#910): whether the club runs its own default agenda, which locks
 *  the General Evaluator checkbox. AUTHED — any active member of the club. */
export const loadClubAgendaSettings = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubViewAccess(currentUser.id, clubId);
		const [settings, adopted] = await Promise.all([
			getClubAgendaSettings(clubId),
			isClubAgendaAdopted(clubId),
		]);
		return { ...settings, adopted };
	});

/** Choose who introduces the functionaries on the generated agenda (#367).
 *  AUTHED — requires admin club role. A CHANGE to that choice is refused while
 *  the club has a default agenda (#910, spec D5): it shapes only the standard
 *  agenda, so the rule holds here and not only in the disabled checkbox. */
export const updateClubAgendaSettings = createServerFn({ method: "POST" })
	.validator((input: unknown) => clubAgendaSettingsSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		await assertGeChangeAllowed(data.clubId, data.geIntroducesFunctionaries);
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

/** The club's charter status, charter date and number (#944), for the settings
 *  page's Charter section. AUTHED — any active member of the club. */
export const loadClubCharter = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubViewAccess(currentUser.id, clubId);
		return getClubCharter(clubId);
	});

/** Mark a chartering club as chartered, with its charter date and club number
 *  (#944). AUTHED — requires admin club role. Moving back to chartering is NOT
 *  here: it is superadmin-only (`revertConsoleClubToChartering`). */
export const markChartered = createServerFn({ method: "POST" })
	.validator((input: unknown) => markClubCharteredSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return markClubChartered(data);
	});

/** Correct a chartered club's charter date (#944). AUTHED — requires admin
 *  club role. */
export const updateCharterDate = createServerFn({ method: "POST" })
	.validator((input: unknown) => updateCharterDateSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return updateClubCharterDate(data);
	});
