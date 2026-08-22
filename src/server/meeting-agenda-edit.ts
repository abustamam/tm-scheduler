/**
 * Server fns for per-meeting agenda editing.
 *
 * Exports ONLY `createServerFn`s and types — a top-level db-touching export
 * here would drag `#/db` → `pg` → `Buffer` into the client bundle and
 * white-screen the page (`server-modules.guard.test.ts` enforces this).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { AgendaDraft } from "./meeting-agenda-edit-logic";
import { loadAgendaDraft } from "./meeting-agenda-edit-logic";
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
