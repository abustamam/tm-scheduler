// VP Education dashboard server fns (issues #8 / #9). Thin `createServerFn`
// wrappers only — all db logic lives in `reporting-logic.ts` so the compiler
// strips it from the client bundle (server-modules guard).
//
// Gated to clubRole "admin": VP Education holders already resolve to "admin"
// (President / VP Education ⇒ admin, ADR-0008 / src/lib/officers.ts), so this
// covers VPEs without a separate role.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireClubAdminView, requireUser } from "./guards";
import {
	loadAttendanceLapse,
	loadOverdueMembers,
	loadSpeakerRotation,
} from "./reporting-logic";

const clubScoped = z.object({ clubId: z.string().uuid() });

export const getSpeakerRotation = createServerFn({ method: "GET" })
	.validator((input: unknown) => clubScoped.parse(input))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubAdminView(user.id, data.clubId);
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
		await requireClubAdminView(user.id, data.clubId);
		return loadOverdueMembers(data.clubId, data.thresholdDays);
	});

/**
 * Members whose attendance has lapsed (#530).
 *
 * Admin-gated like its neighbours, and for a sharper reason: this reports, for
 * every active member, how many meetings in a row they have missed. That is
 * officer information and must never reach a public or member-facing surface.
 */
export const getAttendanceLapse = createServerFn({ method: "GET" })
	.validator((input: unknown) => clubScoped.parse(input))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubAdminView(user.id, data.clubId);
		return loadAttendanceLapse(data.clubId);
	});
