import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { guestInviteTemplatesSchema } from "#/lib/guest-invite-template";
import { requireClubAdminView, requireClubRole, requireUser } from "./guards";
import {
	applyResetGuestInviteTemplate,
	applyUpdateGuestInviteTemplates,
	loadGuestInviteTemplates,
} from "./guest-invite-template-logic";

// Customizable guest invite drafts (#1547). The db-touching logic lives in
// `guest-invite-template-logic.ts` so it can't drag `#/db` -> `pg` into the
// browser bundle; this module exports ONLY createServerFns + types
// (`server-modules.guard.test.ts`). Gate order mirrors `promo.ts`.
//
// Nothing here SENDS anything. The app drafts, a human sends.

const uuid = z.uuid();

/** The club's saved invite templates; `{}` (all defaults) when none or a stored
 *  value fails the schema. AUTHED, admin view. */
export const getGuestInviteTemplates = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubAdminView(currentUser.id, clubId);
		return loadGuestInviteTemplates(clubId);
	});

const updateSchema = z.object({
	clubId: uuid,
	templates: guestInviteTemplatesSchema,
});

/** Replace the club's invite templates. AUTHED, admin: `requireClubRole`'s
 *  EFFECTIVE admin (a stored admin, or any member with an open officer term,
 *  #202), the rule Promote uses. */
export const updateGuestInviteTemplates = createServerFn({ method: "POST" })
	.validator((input: unknown) => updateSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return applyUpdateGuestInviteTemplates(data.clubId, data.templates);
	});

const resetSchema = z.object({
	clubId: uuid,
	kind: z.enum(["never", "firstRecent", "repeatRecent", "lapsed"]),
});

/** Put one draft back on its built-in text. AUTHED, admin only. */
export const resetGuestInviteTemplate = createServerFn({ method: "POST" })
	.validator((input: unknown) => resetSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return applyResetGuestInviteTemplate(data.clubId, data.kind);
	});
