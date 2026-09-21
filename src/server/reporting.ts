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
	loadEvaluatorPairings,
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

/**
 * Evaluator pairing history (#709) — for each speaker, who evaluated them.
 *
 * Admin-gated like its three neighbours, and it takes NO speaker filter on the
 * wire on purpose. `loadEvaluatorPairings` accepts one so a member-facing
 * caller (#681) can reuse the query, but a filter reachable from the client
 * here would be a second, weaker way into the same rows: this fn's gate is
 * club-wide admin, so whatever it accepts it serves for the whole club. The
 * member-facing surface needs its own fn with its own gate — one that proves
 * the caller IS the speaker — not a parameter on this one.
 */
export const getEvaluatorPairings = createServerFn({ method: "GET" })
	.validator((input: unknown) => clubScoped.parse(input))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubAdminView(user.id, data.clubId);
		return loadEvaluatorPairings(data.clubId);
	});
