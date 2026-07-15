import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireClubRole, requireUser } from "./guards";
import {
	deleteRecurrenceRule,
	getRecurrenceRule,
	type RecurrenceRuleInput,
	saveRecurrenceRule,
} from "./recurrence-rule-logic";

const uuid = z.string().uuid();

const saveSchema = z
	.object({
		clubId: uuid,
		mode: z.enum(["interval", "monthly"]),
		weekday: z.number().int().min(0).max(6),
		intervalWeeks: z.number().int().min(1).max(52).nullable(),
		anchorDate: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/)
			.nullable(),
		ordinals: z.array(z.enum(["1", "2", "3", "4", "5", "last"])).nullable(),
		timeOfDay: z.string().regex(/^\d{2}:\d{2}$/),
		location: z.string().trim().max(200).nullable().default(null),
		// Config form bound: 1..12 (the DB check allows up to MAX_BATCH=52).
		keepAhead: z.number().int().min(1).max(12),
		enabled: z.boolean(),
	})
	.superRefine((v, ctx) => {
		if (v.mode === "interval" && (v.intervalWeeks == null || !v.anchorDate)) {
			ctx.addIssue({
				code: "custom",
				message: "Interval rules need intervalWeeks and anchorDate.",
			});
		}
		if (v.mode === "monthly" && (!v.ordinals || v.ordinals.length === 0)) {
			ctx.addIssue({
				code: "custom",
				message: "Monthly rules need at least one ordinal.",
			});
		}
	});

/** VPE/admin: read the club's standing recurrence rule (or null). AUTHED — admin. */
export const getClubRecurrenceRule = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, clubId, ["admin"]);
		return getRecurrenceRule(clubId);
	});

/** VPE/admin: create/update the rule; reconciles + tops up. AUTHED — admin. */
export const saveClubRecurrenceRule = createServerFn({ method: "POST" })
	.validator((input: unknown) => saveSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		const input: RecurrenceRuleInput = {
			mode: data.mode,
			weekday: data.weekday,
			intervalWeeks: data.intervalWeeks,
			anchorDate: data.anchorDate,
			ordinals: data.ordinals,
			timeOfDay: data.timeOfDay,
			location: data.location,
			keepAhead: data.keepAhead,
			enabled: data.enabled,
		};
		return saveRecurrenceRule(data.clubId, input);
	});

/** VPE/admin: delete the rule (existing meetings are kept). AUTHED — admin. */
export const deleteClubRecurrenceRule = createServerFn({ method: "POST" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, clubId, ["admin"]);
		await deleteRecurrenceRule(clubId);
		return { ok: true };
	});
