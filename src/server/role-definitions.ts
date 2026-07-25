import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireClubRole, requireClubViewAccess, requireUser } from "./guards";
import {
	applyRoleDefinitionCreate,
	applyRoleDefinitionDelete,
	applyRoleDefinitionReorder,
	applyRoleDefinitionSetEnabled,
	applyRoleDefinitionUpdate,
	createRoleSchema,
	deleteRoleSchema,
	listRoleDefinitions,
	reorderRolesSchema,
	setRoleEnabledSchema,
	updateRoleSchema,
} from "./role-definitions-logic";
import { applyTemplateSyncToUpcomingMeetings } from "./slots-logic";

const uuid = z.string().uuid();

/** The club's role template (ordered), each annotated with how many existing
 *  slots reference it. Backs the admin role-template manager. AUTHED — any
 *  active member of the club may read. */
export const listClubRoles = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubViewAccess(currentUser.id, clubId);
		return listRoleDefinitions(clubId);
	});

/** The club's role template (ordered), for the PUBLIC printable role sheet
 *  (#341). Ungated on purpose — role names + responsibilities are non-sensitive
 *  reference content, matching the public print/present routes, and the sheet is
 *  meant to be shareable/handed to guests. Returns the same rows as
 *  `listClubRoles` minus disabled ones (#368, via `onlyEnabled`) — this sheet
 *  OFFERS the club's roles, which a "skeleton crew" club turned some off to
 *  stop offering; the admin-only `listClubRoles` is where a disabled role
 *  stays visible. The extra `slotCount` is harmless here. */
export const getPublicClubRoles = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) =>
		listRoleDefinitions(clubId, { onlyEnabled: true }),
	);

/** Add a custom role to the club template. AUTHED — requires admin. */
export const createClubRole = createServerFn({ method: "POST" })
	.validator((input: unknown) => createRoleSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return applyRoleDefinitionCreate(data);
	});

/** Edit an existing role's fields (name/category/count/speaker flag/description).
 *  AUTHED — requires admin. */
export const updateClubRole = createServerFn({ method: "POST" })
	.validator((input: unknown) => updateRoleSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return applyRoleDefinitionUpdate(data);
	});

/** Turn a role on/off for future meetings without deleting it (#368). Narrow
 *  payload (`{ clubId, roleId, enabled }`) rather than the whole-row shape
 *  `updateClubRole` takes — see `applyRoleDefinitionSetEnabled`. AUTHED —
 *  requires admin. */
export const setClubRoleEnabled = createServerFn({ method: "POST" })
	.validator((input: unknown) => setRoleEnabledSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return applyRoleDefinitionSetEnabled(data);
	});

/** Persist a new ordering of the club's roles. AUTHED — requires admin. */
export const reorderClubRoles = createServerFn({ method: "POST" })
	.validator((input: unknown) => reorderRolesSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return applyRoleDefinitionReorder(data);
	});

/** Delete a custom role (blocked if referenced by existing meetings).
 *  AUTHED — requires admin. */
export const deleteClubRole = createServerFn({ method: "POST" })
	.validator((input: unknown) => deleteRoleSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return applyRoleDefinitionDelete(data);
	});

const syncTemplateSchema = z.object({
	clubId: z.string().uuid(),
	actorMemberId: z.string().uuid().nullable().optional(),
});

/** Backfill missing standard roles onto all upcoming meetings. AUTHED — admin. */
export const syncTemplateToUpcomingMeetings = createServerFn({ method: "POST" })
	.validator((input: unknown) => syncTemplateSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return applyTemplateSyncToUpcomingMeetings({
			clubId: data.clubId,
			actorMemberId: data.actorMemberId ?? null,
		});
	});
