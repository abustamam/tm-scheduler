// VP Education dashboard server fns (issues #8 / #9). Thin `createServerFn`
// wrappers only — all db logic lives in `reporting-logic.ts` so the compiler
// strips it from the client bundle (server-modules guard).
//
// Gated to clubRole "admin": VP Education holders already resolve to "admin"
// (President / VP Education ⇒ admin, ADR-0008 / src/lib/officers.ts), so this
// covers VPEs without a separate role.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireClubRole, requireUser } from "./guards";
import { loadOverdueMembers, loadSpeakerRotation } from "./reporting-logic";

const clubScoped = z.object({ clubId: z.string().uuid() });

export const getSpeakerRotation = createServerFn({ method: "GET" })
	.validator((input: unknown) => clubScoped.parse(input))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return loadSpeakerRotation(data.clubId);
	});

export const getOverdueMembers = createServerFn({ method: "GET" })
	.validator((input: unknown) =>
		clubScoped
			.extend({
				thresholdDays: z.number().int().positive().max(365).optional(),
			})
			.parse(input),
	)
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return loadOverdueMembers(data.clubId, data.thresholdDays);
	});
