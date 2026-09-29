// Charter dashboard server fns (#943). Thin `createServerFn` wrappers ONLY —
// all db logic lives in `charter-logic.ts` so the Start compiler strips it from
// the client bundle (enforced by `server-modules.guard.test.ts`).
//
// Admin-only both ways: reads need admin view of the club
// (`requireClubAdminView`: an admin, an open officer, or an impersonating
// superadmin), and every write needs the admin club role (`requireClubRole`
// admin, which also admits open officers). The dashboard names outside
// helpers' contact details, so a plain member reads none of it.
// `charter-authz.guard.test.ts` pins each gate before its call.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	addCharterHelper as addCharterHelperDb,
	addCharterHelperSchema,
	addCharterStep as addCharterStepDb,
	addCharterStepSchema,
	getCharterDashboard as getCharterDashboardDb,
	getCharterSummary as getCharterSummaryDb,
	removeCharterHelper as removeCharterHelperDb,
	removeCharterHelperSchema,
	removeCharterStep as removeCharterStepDb,
	removeCharterStepSchema,
	renameCharterStep as renameCharterStepDb,
	renameCharterStepSchema,
	reorderCharterSteps as reorderCharterStepsDb,
	reorderCharterStepsSchema,
	setCharterStepDone as setCharterStepDoneDb,
	setCharterStepDoneSchema,
	updateCharterTarget as updateCharterTargetDb,
	updateCharterTargetSchema,
} from "./charter-logic";
import { requireClubAdminView, requireClubRole, requireUser } from "./guards";

const clubScoped = z.object({ clubId: z.string().uuid() });

/** The whole dashboard, or null once the club has chartered. */
export const getCharterDashboard = createServerFn({ method: "GET" })
	.validator((i: unknown) => clubScoped.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubAdminView(user.id, data.clubId);
		return getCharterDashboardDb(data.clubId);
	});

/** The officer home card's numbers, or null once the club has chartered. */
export const getCharterSummary = createServerFn({ method: "GET" })
	.validator((i: unknown) => clubScoped.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubAdminView(user.id, data.clubId);
		return getCharterSummaryDb(data.clubId);
	});

export const updateCharterTarget = createServerFn({ method: "POST" })
	.validator((i: unknown) => updateCharterTargetSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return updateCharterTargetDb(data);
	});

export const addCharterStep = createServerFn({ method: "POST" })
	.validator((i: unknown) => addCharterStepSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return addCharterStepDb(data);
	});

export const renameCharterStep = createServerFn({ method: "POST" })
	.validator((i: unknown) => renameCharterStepSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return renameCharterStepDb(data);
	});

export const setCharterStepDone = createServerFn({ method: "POST" })
	.validator((i: unknown) => setCharterStepDoneSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return setCharterStepDoneDb(data);
	});

export const removeCharterStep = createServerFn({ method: "POST" })
	.validator((i: unknown) => removeCharterStepSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return removeCharterStepDb(data);
	});

export const reorderCharterSteps = createServerFn({ method: "POST" })
	.validator((i: unknown) => reorderCharterStepsSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return reorderCharterStepsDb(data);
	});

export const addCharterHelper = createServerFn({ method: "POST" })
	.validator((i: unknown) => addCharterHelperSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return addCharterHelperDb(data);
	});

export const removeCharterHelper = createServerFn({ method: "POST" })
	.validator((i: unknown) => removeCharterHelperSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return removeCharterHelperDb(data);
	});
