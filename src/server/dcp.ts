// Distinguished Club Program (DCP) server fns (#207 / ADR-0019). Thin
// `createServerFn` wrappers ONLY — all db logic lives in `dcp-logic.ts` so the
// Start compiler strips it from the client bundle (enforced by
// `server-modules.guard.test.ts`).
//
// Every fn is gated to clubRole "admin". The President already resolves to
// "admin" (effective-admin: any open officer term passes `requireClubRole`
// admin — see guards.ts / #202), so this covers the President without a new role.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	applyEducationSchema,
	applyEducationSuggestions as applyEducationSuggestionsDb,
	getScoreboard as getScoreboardDb,
	getScoreboardSchema,
	listScoreboardYears as listScoreboardYearsDb,
	startScoreboard as startScoreboardDb,
	startScoreboardSchema,
	updateBaseMemberCount as updateBaseMemberCountDb,
	updateBaseSchema,
	updateGoal as updateGoalDb,
	updateGoalSchema,
} from "./dcp-logic";
import { requireClubRole, requireUser } from "./guards";

const clubScoped = z.object({ clubId: z.string().uuid() });

export const getScoreboard = createServerFn({ method: "GET" })
	.validator((i: unknown) => getScoreboardSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return getScoreboardDb(data);
	});

export const getScoreboardYears = createServerFn({ method: "GET" })
	.validator((i: unknown) => clubScoped.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return listScoreboardYearsDb(data.clubId);
	});

export const startScoreboard = createServerFn({ method: "POST" })
	.validator((i: unknown) => startScoreboardSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return startScoreboardDb(data);
	});

export const updateGoal = createServerFn({ method: "POST" })
	.validator((i: unknown) => updateGoalSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return updateGoalDb(data, user.id);
	});

export const applyEducationSuggestions = createServerFn({ method: "POST" })
	.validator((i: unknown) => applyEducationSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return applyEducationSuggestionsDb(data, user.id);
	});

export const updateBaseMemberCount = createServerFn({ method: "POST" })
	.validator((i: unknown) => updateBaseSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return updateBaseMemberCountDb(data);
	});
