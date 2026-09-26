import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { promoTemplateSchema } from "#/lib/promo-template";
import { requireClubAdminView, requireClubRole, requireUser } from "./guards";
import {
	applyResetPromoTemplate,
	applyUpdatePromoTemplate,
	clubIdForMeeting,
	loadPromoContext,
	loadPromoTemplateState,
	loadPublicFlyer,
} from "./promo-logic";

// Marketing blasts (#931). The db-touching logic lives in `promo-logic.ts` so
// it can't drag `#/db` → `pg` into the browser bundle; this module exports
// ONLY createServerFns + types (`server-modules.guard.test.ts`).
//
// Nothing here SENDS anything. The app drafts, a human sends.
export type { PromoContext, PublicFlyer } from "./promo-logic";

const uuid = z.uuid();

/** The club's blast template for the settings editor, and whether a stored one
 *  failed to parse. AUTHED — admin view (an officer, or a superadmin's
 *  read-only impersonation). */
export const getPromoTemplate = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubAdminView(currentUser.id, clubId);
		return loadPromoTemplateState(clubId);
	});

const updatePromoTemplateSchema = z.object({
	clubId: uuid,
	template: promoTemplateSchema,
});

/** Replace the club's blast template. AUTHED — admin (#931 decision 1). "Admin"
 *  is `requireClubRole`'s EFFECTIVE admin: a stored club admin, or any member
 *  with an open officer term (#202), so a VP Public Relations passes as an
 *  officer. Decision 1 means no role-specific grant beyond that — the rule is
 *  the one every other admin write here uses, not a new PR-only one. */
export const updatePromoTemplate = createServerFn({ method: "POST" })
	.validator((input: unknown) => updatePromoTemplateSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return applyUpdatePromoTemplate(data.clubId, data.template);
	});

/** Put the club back on the seeded default template. AUTHED — admin only. */
export const resetPromoTemplate = createServerFn({ method: "POST" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, clubId, ["admin"]);
		return applyResetPromoTemplate(clubId);
	});

const promoContextSchema = z
	.object({
		clubId: uuid.optional(),
		meetingId: uuid.optional(),
	})
	.refine((v) => v.clubId || v.meetingId, "A club or a meeting is required.");

/**
 * What the Promote sheet drafts from: the club, its template, its upcoming
 * meetings, and which one to open on. Takes a meeting id (the meeting page) or
 * a club id (club settings, which opens on the next meeting). AUTHED — admin
 * view, the same gate as `getGuestInviteContext`.
 */
export const getPromoContext = createServerFn({ method: "GET" })
	.validator((input: unknown) => promoContextSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		const clubId =
			data.clubId ??
			(data.meetingId ? await clubIdForMeeting(data.meetingId) : null);
		if (!clubId) throw new Error("Meeting not found.");
		await requireClubAdminView(currentUser.id, clubId);
		return loadPromoContext(clubId, new Date(), data.meetingId ?? null);
	});

const publicFlyerSchema = z.object({
	clubId: uuid,
	key: z.string().min(1).max(64),
});

/**
 * The PUBLIC `/flyer` route's payload, or null for an unknown or ARCHIVED club
 * or a key naming no meeting. Session-less, like `/word`: a flyer shows only
 * what the public meeting page already shows. Archive-gated inside
 * `loadPublicFlyer` (`isReadableClub`).
 */
export const getPublicFlyer = createServerFn({ method: "GET" })
	.validator((input: unknown) => publicFlyerSchema.parse(input))
	.handler(async ({ data }) => loadPublicFlyer(data.clubId, data.key));
