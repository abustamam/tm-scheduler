/**
 * Server fns for per-meeting agenda editing.
 *
 * Exports ONLY `createServerFn`s and types — a top-level db-touching export
 * here would drag `#/db` → `pg` → `Buffer` into the client bundle and
 * white-screen the page (`server-modules.guard.test.ts` enforces this).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type {
	AgendaDraft,
	AgendaDraftRole,
	AgendaDraftRow,
	ReleasedHolder,
} from "./meeting-agenda-edit-logic";
import {
	addAgendaRole,
	addAgendaRow,
	loadAgendaDraft,
	moveAgendaRow,
	planRoleRemoval,
	removeAgendaRole,
	removeAgendaRow,
	updateAgendaRow,
} from "./meeting-agenda-edit-logic";
import { requireMeetingTemplateEditor } from "./meeting-templates-logic";

export type { AgendaDraft, AgendaDraftRow, AgendaDraftRole, ReleasedHolder };

const meetingInput = z.object({ meetingId: z.string().uuid() });

/** This meeting's editable agenda. Officer-gated: the same authority that may
 *  change a meeting's type may reshape its run of show. */
export const getAgendaDraft = createServerFn({ method: "GET" })
	.validator((input: unknown) => meetingInput.parse(input))
	.handler(async ({ data }): Promise<AgendaDraft | null> => {
		await requireMeetingTemplateEditor(data.meetingId);
		return loadAgendaDraft(data.meetingId);
	});

const addInput = z.object({
	meetingId: z.string().uuid(),
	afterRowId: z.string().uuid().nullable(),
	kind: z.enum(["section", "role", "event"]),
});
const rowInput = z.object({
	meetingId: z.string().uuid(),
	rowId: z.string().uuid(),
});
const patchInput = rowInput.extend({
	// Require at least one key: an empty `{}` validates as a well-formed patch,
	// forks the meeting's template on its way in, and then 500s on drizzle's
	// "No values to set" — a confusing failure for what should be a no-op
	// request rejected up front.
	patch: z
		.object({
			label: z.string().optional(),
			detail: z.string().nullable().optional(),
			minutes: z.number().int().optional(),
			roleKey: z.string().nullable().optional(),
			repeatsRoleKey: z.string().nullable().optional(),
			markGreen: z.number().nullable().optional(),
			markYellow: z.number().nullable().optional(),
			markRed: z.number().nullable().optional(),
		})
		.refine((p) => Object.keys(p).length > 0, {
			message: "Patch must set at least one field.",
		}),
});
const moveInput = rowInput.extend({ direction: z.enum(["up", "down"]) });

/** Add a row to this meeting's agenda. Officer-gated, same as `getAgendaDraft`. */
export const addAgendaRowFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => addInput.parse(input))
	.handler(async ({ data }): Promise<AgendaDraftRow> => {
		await requireMeetingTemplateEditor(data.meetingId);
		return addAgendaRow(data);
	});

/** Edit a row's content. Officer-gated, same as `getAgendaDraft`. */
export const updateAgendaRowFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => patchInput.parse(input))
	.handler(async ({ data }): Promise<void> => {
		await requireMeetingTemplateEditor(data.meetingId);
		return updateAgendaRow(data);
	});

/** Remove a row from this meeting's agenda. Officer-gated, same as `getAgendaDraft`. */
export const removeAgendaRowFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => rowInput.parse(input))
	.handler(async ({ data }): Promise<void> => {
		await requireMeetingTemplateEditor(data.meetingId);
		return removeAgendaRow(data);
	});

/** Reorder a row by one position. Officer-gated, same as `getAgendaDraft`. */
export const moveAgendaRowFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => moveInput.parse(input))
	.handler(async ({ data }): Promise<void> => {
		await requireMeetingTemplateEditor(data.meetingId);
		return moveAgendaRow(data);
	});

const roleAddInput = z.object({
	meetingId: z.string().uuid(),
	name: z.string().min(1),
	category: z.enum(["leadership", "speaker", "evaluator", "functionary"]),
	defaultCount: z.number().int().min(0),
	isSpeakerRole: z.boolean(),
});
const roleKeyInput = z.object({
	meetingId: z.string().uuid(),
	roleKey: z.string().min(1),
});

/** Add a role to this meeting's agenda. Officer-gated, same as `getAgendaDraft`. */
export const addAgendaRoleFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => roleAddInput.parse(input))
	.handler(async ({ data }): Promise<AgendaDraftRole> => {
		await requireMeetingTemplateEditor(data.meetingId);
		return addAgendaRole(data);
	});

/** Who removing this role would release, without removing anything.
 *  Officer-gated, same as `getAgendaDraft`. */
export const planRoleRemovalFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => roleKeyInput.parse(input))
	.handler(async ({ data }): Promise<ReleasedHolder[]> => {
		await requireMeetingTemplateEditor(data.meetingId);
		return planRoleRemoval(data);
	});

/** Remove a role from this meeting's agenda. Officer-gated, same as
 *  `getAgendaDraft`. Attributes the removal to the calling officer's own
 *  membership, for `activity_log`. */
export const removeAgendaRoleFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => roleKeyInput.parse(input))
	.handler(async ({ data }): Promise<ReleasedHolder[]> => {
		const { membership } = await requireMeetingTemplateEditor(data.meetingId);
		return removeAgendaRole({ ...data, actorMemberId: membership.id });
	});
