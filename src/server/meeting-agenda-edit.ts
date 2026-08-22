/**
 * Server fns for per-meeting agenda editing.
 *
 * Exports ONLY `createServerFn`s and types — a top-level db-touching export
 * here would drag `#/db` → `pg` → `Buffer` into the client bundle and
 * white-screen the page (`server-modules.guard.test.ts` enforces this).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { AgendaDraft, AgendaDraftRow } from "./meeting-agenda-edit-logic";
import {
	addAgendaRow,
	loadAgendaDraft,
	moveAgendaRow,
	removeAgendaRow,
	updateAgendaRow,
} from "./meeting-agenda-edit-logic";
import { requireMeetingTemplateEditor } from "./meeting-templates-logic";

export type { AgendaDraft };

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
	patch: z.object({
		label: z.string().optional(),
		detail: z.string().nullable().optional(),
		minutes: z.number().int().optional(),
		roleKey: z.string().nullable().optional(),
		repeatsRoleKey: z.string().nullable().optional(),
		markGreen: z.number().nullable().optional(),
		markYellow: z.number().nullable().optional(),
		markRed: z.number().nullable().optional(),
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
