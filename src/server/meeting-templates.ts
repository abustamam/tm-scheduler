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
import {
	CLUB_TEMPLATE_DESCRIPTION_MAX,
	CLUB_TEMPLATE_NAME_MAX,
} from "#/lib/club-template-key";
import { assertClubNotArchived, requireClubRole, requireUser } from "./guards";
import {
	type AvailableTemplate,
	applyTemplateConversion,
	type ConversionPlan,
	listAvailableTemplates,
	type MeetingTemplateSummary,
	planTemplateConversion,
	requireMeetingTemplateEditor,
	saveMeetingAgendaAsClubTemplate,
} from "./meeting-templates-logic";

export type { AvailableTemplate, ConversionPlan, MeetingTemplateSummary };

const clubInput = z.object({ clubId: z.string().uuid() });
const meetingTemplateInput = z.object({
	meetingId: z.string().uuid(),
	templateId: z.string().uuid().nullable(),
});

/** Templates this club may apply. Officer-gated: the picker is an admin
 *  affordance and the list is not public reference content. */
export const listTemplatesForClub = createServerFn({ method: "GET" })
	.validator((input: unknown) => clubInput.parse(input))
	.handler(async ({ data }): Promise<AvailableTemplate[]> => {
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

/**
 * The zod bounds are loose ceilings on the WIRE, twice the logic's own
 * code-point limits: the logic trims and counts code points, which is the
 * number an officer sees, and it is where the readable refusal comes from.
 * These only stop an absurd payload reaching it.
 */
const saveClubTemplateInput = z.discriminatedUnion("mode", [
	z.object({
		meetingId: z.string().uuid(),
		mode: z.literal("new"),
		name: z.string().max(CLUB_TEMPLATE_NAME_MAX * 2),
		description: z
			.string()
			.max(CLUB_TEMPLATE_DESCRIPTION_MAX * 2)
			.nullable(),
	}),
	z.object({
		meetingId: z.string().uuid(),
		mode: z.literal("replace"),
		templateId: z.string().uuid(),
	}),
]);

/** Save this meeting's current agenda as a club template, new or replacing
 *  one of the club's own (#909). The club and the actor come from the gate —
 *  never from the client — and no meeting's agenda changes. */
export const saveAgendaAsClubTemplate = createServerFn({ method: "POST" })
	.validator((input: unknown) => {
		const result = saveClubTemplateInput.safeParse(input);
		if (result.success) return result.data;
		throw new Error(
			"That template could not be saved. Check the name and try again.",
		);
	})
	.handler(async ({ data }): Promise<{ templateId: string }> => {
		const { clubId, membership } = await requireMeetingTemplateEditor(
			data.meetingId,
		);
		return saveMeetingAgendaAsClubTemplate(
			data.mode === "new"
				? {
						mode: "new",
						meetingId: data.meetingId,
						clubId,
						actorMemberId: membership.id,
						name: data.name,
						description: data.description,
					}
				: {
						mode: "replace",
						meetingId: data.meetingId,
						clubId,
						actorMemberId: membership.id,
						templateId: data.templateId,
					},
		);
	});
