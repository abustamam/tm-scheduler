/**
 * Server fns for agenda templates.
 *
 * Exports ONLY `createServerFn`s and types — a plain top-level db-touching
 * export in this module would drag `#/db` → `pg` → `Buffer` into the client
 * bundle and white-screen the page. All db logic lives in
 * `meeting-templates-logic.ts` (`server-modules.guard.test.ts` enforces this).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { assertClubNotArchived, requireClubRole, requireUser } from "./guards";
import {
	applyTemplateConversion,
	type ConversionPlan,
	listAvailableTemplates,
	type MeetingTemplateSummary,
	planTemplateConversion,
	requireMeetingTemplateEditor,
} from "./meeting-templates-logic";

export type { ConversionPlan, MeetingTemplateSummary };

const clubInput = z.object({ clubId: z.string().uuid() });
const meetingTemplateInput = z.object({
	meetingId: z.string().uuid(),
	templateId: z.string().uuid().nullable(),
});

/** Templates this club may apply. Officer-gated: the picker is an admin
 *  affordance and the list is not public reference content. */
export const listTemplatesForClub = createServerFn({ method: "GET" })
	.validator((input: unknown) => clubInput.parse(input))
	.handler(async ({ data }): Promise<MeetingTemplateSummary[]> => {
		const user = await requireUser();
		await assertClubNotArchived(data.clubId);
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return listAvailableTemplates(data.clubId);
	});

/** What applying a template WOULD do. Read-only — the confirm dialog renders
 *  these counts before anything is destroyed. */
export const previewTemplateForMeeting = createServerFn({ method: "GET" })
	.validator((input: unknown) => meetingTemplateInput.parse(input))
	.handler(async ({ data }): Promise<ConversionPlan> => {
		await requireMeetingTemplateEditor(data.meetingId);
		return planTemplateConversion(data.meetingId, data.templateId);
	});

/** Apply a template to a meeting, or `null` to restore the club's standard
 *  shape. Returns the released holders so the caller can prompt the officer to
 *  message them — they cannot be notified automatically (see the logic module). */
export const applyTemplateToMeeting = createServerFn({ method: "POST" })
	.validator((input: unknown) => meetingTemplateInput.parse(input))
	.handler(async ({ data }): Promise<ConversionPlan> => {
		const { clubId, membership } = await requireMeetingTemplateEditor(
			data.meetingId,
		);
		return applyTemplateConversion({
			meetingId: data.meetingId,
			clubId,
			templateId: data.templateId,
			actorMemberId: membership.id,
		});
	});
