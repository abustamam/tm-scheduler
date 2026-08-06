// Club action-item server fns (#529). Thin `createServerFn` wrappers only —
// every db-touching function lives in `action-items-logic.ts` so the compiler
// strips it from the client bundle (server-modules guard).
//
// Authorization splits deliberately:
//   READS  gate on club VIEW access — any signed-in member of the club. An open
//          action item is club business ("bring a guest", "renew dues"), and
//          hiding it from the people who must act on it defeats the point.
//   WRITES gate on club admin, consistent with dues (ADR-0017), the DCP
//          scoreboard (ADR-0019) and every minutes mutation (ADR-0014).
// Neither is reachable anonymously: both require a session first.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { ACTION_ITEM_FIELDS } from "#/lib/action-item-limits";
import {
	createActionItem,
	deleteActionItem,
	listActionItems,
	listOpenActionItems,
	reopenActionItem,
	resolveActionItem,
	updateActionItem,
} from "./action-items-logic";
import { requireClubRole, requireClubViewAccess, requireUser } from "./guards";

const clubScoped = z.object({ clubId: z.string().uuid() });

/** An optional owner: a member uuid, or null for "the club collectively". */
const ownerMemberId = z.string().uuid().nullish();
/**
 * An optional target date, as the calendar day the form's date input produced.
 *
 * A bare "YYYY-MM-DD" string all the way to a `date` column — deliberately NOT
 * parsed into a `Date`. `new Date("2026-08-10")` is UTC midnight, which renders
 * as the 9th for every club west of UTC and disagrees between the SSR pass and
 * the hydrated client. A due date is a day, not an instant.
 */
const dueDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a due date from the calendar.")
	.nullish()
	.transform((v) => v ?? null);

/**
 * Parse, but fail with a sentence a club officer can read.
 *
 * A raw `ZodError` reaching the client is not the human-readable rejection this
 * feature promises: `ZodError.message` is `JSON.stringify(issues, null, 2)`, so
 * the admin form's toast would show a multi-line dump of `code`/`origin`/`path`
 * — and for a bad uuid, the internal validation regex. The per-field messages
 * are already written; this is what actually surfaces them.
 */
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
	const result = schema.safeParse(input);
	if (result.success) return result.data;
	throw new Error(
		result.error.issues[0]?.message ?? "That action item could not be saved.",
	);
}

export const getActionItems = createServerFn({ method: "GET" })
	.validator((input: unknown) => parse(clubScoped, input))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubViewAccess(user.id, data.clubId);
		return listActionItems(data.clubId);
	});

export const getOpenActionItems = createServerFn({ method: "GET" })
	.validator((input: unknown) => parse(clubScoped, input))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubViewAccess(user.id, data.clubId);
		return listOpenActionItems(data.clubId);
	});

export const addActionItem = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		parse(
			clubScoped.extend({
				text: ACTION_ITEM_FIELDS.text,
				ownerMemberId,
				dueDate,
			}),
			input,
		),
	)
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return createActionItem({
			clubId: data.clubId,
			text: data.text,
			ownerMemberId: data.ownerMemberId ?? null,
			dueDate: data.dueDate,
		});
	});

export const editActionItem = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		parse(
			clubScoped.extend({
				id: z.string().uuid(),
				text: ACTION_ITEM_FIELDS.text,
				ownerMemberId,
				dueDate,
			}),
			input,
		),
	)
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		await updateActionItem({
			clubId: data.clubId,
			id: data.id,
			text: data.text,
			ownerMemberId: data.ownerMemberId ?? null,
			dueDate: data.dueDate,
		});
	});

export const closeActionItem = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		parse(
			clubScoped.extend({
				id: z.string().uuid(),
				resolution: z.enum(["done", "dropped"]),
			}),
			input,
		),
	)
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		await resolveActionItem({
			clubId: data.clubId,
			id: data.id,
			resolution: data.resolution,
		});
	});

export const restoreActionItem = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		parse(clubScoped.extend({ id: z.string().uuid() }), input),
	)
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		await reopenActionItem({ clubId: data.clubId, id: data.id });
	});

export const removeActionItem = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		parse(clubScoped.extend({ id: z.string().uuid() }), input),
	)
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		await deleteActionItem({ clubId: data.clubId, id: data.id });
	});
