import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireClubRole, requireMembership, requireUser } from "./guards";
import {
	applyRoleDefinitionCreate,
	applyRoleDefinitionDelete,
	applyRoleDefinitionReorder,
	applyRoleDefinitionUpdate,
	createRoleSchema,
	deleteRoleSchema,
	listRoleDefinitions,
	reorderRolesSchema,
	updateRoleSchema,
} from "./role-definitions-logic";

const uuid = z.string().uuid();

/** The club's role template (ordered), each annotated with how many existing
 *  slots reference it. Backs the admin role-template manager. AUTHED — any
 *  active member of the club may read. */
export const listClubRoles = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireMembership(currentUser.id, clubId);
		return listRoleDefinitions(clubId);
	});

/** Add a custom role to the club template. AUTHED — requires admin/vpe. */
export const createClubRole = createServerFn({ method: "POST" })
	.validator((input: unknown) => createRoleSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin", "vpe"]);
		return applyRoleDefinitionCreate(data);
	});

/** Edit an existing role's fields (name/category/count/speaker flag/description).
 *  AUTHED — requires admin/vpe. */
export const updateClubRole = createServerFn({ method: "POST" })
	.validator((input: unknown) => updateRoleSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin", "vpe"]);
		return applyRoleDefinitionUpdate(data);
	});

/** Persist a new ordering of the club's roles. AUTHED — requires admin/vpe. */
export const reorderClubRoles = createServerFn({ method: "POST" })
	.validator((input: unknown) => reorderRolesSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin", "vpe"]);
		return applyRoleDefinitionReorder(data);
	});

/** Delete a custom role (blocked if referenced by existing meetings).
 *  AUTHED — requires admin/vpe. */
export const deleteClubRole = createServerFn({ method: "POST" })
	.validator((input: unknown) => deleteRoleSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin", "vpe"]);
		return applyRoleDefinitionDelete(data);
	});
