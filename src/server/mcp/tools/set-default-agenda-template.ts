/**
 * `set_default_agenda_template` — set or clear the club's default agenda
 * (#1630). The app's `setClubDefaultTemplate`.
 *
 * Setting a default converts upcoming meetings still on the standard agenda
 * and never removes a role or a sign-up: the plan lists, from the same
 * classification the apply runs (`previewDefaultForUpcoming`), which meetings
 * would convert and which are kept, and why. The re-plan runs outside the
 * logic's transactions; a change landing in that window yields a result that
 * differs from the preview, never a lost sign-up, and the tool returns what
 * actually happened.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { clubs } from "#/db/schema";
import { digest } from "#/lib/mcp-plan";
import { localDateKey } from "#/lib/meeting-url";
import {
	previewDefaultForUpcoming,
	type SetDefaultResult,
	setClubDefaultTemplate,
} from "#/server/club-agendas-logic";
import { authorizeToken } from "../authz-logic";
import type { McpToolDefinition } from "../tool";
import {
	disabledTemplateError,
	inputOrValidation,
	loadOwnTemplate,
	planFlow,
	planHashField,
} from "./agenda-template-plan";
import {
	REPLACE_TARGET_NOT_LISTED_MESSAGE,
	readTemplateContent,
} from "./list-agenda-templates";

export const SET_DEFAULT_AGENDA_TEMPLATE_TOOL = "set_default_agenda_template";

const inputSchema = {
	clubId: z.string().uuid(),
	templateId: z
		.string()
		.uuid()
		.nullable()
		.describe(
			"An enabled template of the club's own (list_agenda_templates), or null to clear the default.",
		),
	planHash: planHashField,
};

type PlanMeeting = { meetingId: string; date: string; roles?: string[] };

type SetPlan = {
	clubId: string;
	templateId: string;
	name: string;
	contentHash: string;
	currentDefaultTemplateId: string | null;
	wouldApply: PlanMeeting[];
	keptEdited: PlanMeeting[];
	keptSignups: PlanMeeting[];
	keptRoles: PlanMeeting[];
	noop?: true;
};

type ClearPlan = {
	clubId: string;
	templateId: null;
	currentDefaultTemplateId: string | null;
	noop?: true;
};

/** `SetDefaultResult` as plain JSON (instants as ISO strings), plus `partial`. */
export function serializeSetDefault(result: SetDefaultResult) {
	const iso = <T extends { scheduledAt: Date }>(m: T) => ({
		...m,
		scheduledAt: m.scheduledAt.toISOString(),
	});
	return {
		templateId: result.templateId,
		applied: result.applied.map(iso),
		keptEdited: result.keptEdited.map(iso),
		keptSignups: result.keptSignups.map(iso),
		keptRoles: result.keptRoles.map(iso),
		failed: result.failed.map(iso),
		partial: result.failed.length > 0,
	};
}

export const setDefaultAgendaTemplateTool: McpToolDefinition = {
	name: SET_DEFAULT_AGENDA_TEMPLATE_TOOL,
	audience: "officer",
	// It replaces the agenda of every upcoming meeting still on the standard
	// one, and null clears the default.
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
	},
	config: {
		title: "Set the club's default agenda template",
		description:
			"Set one of the club's own enabled agenda templates as the club " +
			"default (list_agenda_templates gives the ids), or pass templateId " +
			"null to clear the default. Setting a default converts only upcoming " +
			"meetings still on the standard agenda and never removes a role or a " +
			"sign-up; the preview lists which meetings convert and which are " +
			"kept, and why. New meetings start from the default. Without planHash " +
			"this writes nothing and returns a plan and a planHash; show the plan " +
			"to the user, then call again with the same input plus that planHash.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const clubId = inputOrValidation(
			z.object({ clubId: inputSchema.clubId }),
			input,
		).clubId;
		const { club, user } = await authorizeToken(ctx, clubId);
		const args = inputOrValidation(z.object(inputSchema), input);
		const templateId = args.templateId;

		const currentDefault = async () => {
			const [row] = await db
				.select({
					defaultTemplateId: clubs.defaultTemplateId,
					timezone: clubs.timezone,
				})
				.from(clubs)
				.where(eq(clubs.id, club.clubId))
				.limit(1);
			return {
				defaultTemplateId: row?.defaultTemplateId ?? null,
				timezone: row?.timezone ?? "UTC",
			};
		};

		return planFlow<SetPlan | ClearPlan, unknown>({
			tool: SET_DEFAULT_AGENDA_TEMPLATE_TOOL,
			clubId: club.clubId,
			userId: user.id,
			planHash: args.planHash,
			build: async () => {
				if (templateId === null) {
					const { defaultTemplateId } = await currentDefault();
					return {
						clubId: club.clubId,
						templateId: null,
						currentDefaultTemplateId: defaultTemplateId,
						...(defaultTemplateId === null ? { noop: true as const } : {}),
					};
				}
				const own = await loadOwnTemplate(club.clubId, templateId);
				if (!own.enabled) throw disabledTemplateError();
				const content = await readTemplateContent(
					own.id,
					REPLACE_TARGET_NOT_LISTED_MESSAGE,
				);
				const { defaultTemplateId, timezone } = await currentDefault();
				const preview = await previewDefaultForUpcoming(club.clubId, own.id);
				const entry = (m: {
					meetingId: string;
					scheduledAt: Date;
				}): PlanMeeting => ({
					meetingId: m.meetingId,
					date: localDateKey(m.scheduledAt, timezone),
				});
				const withRoles = (m: {
					meetingId: string;
					scheduledAt: Date;
					roles: string[];
				}): PlanMeeting => ({ ...entry(m), roles: [...m.roles].sort() });
				// Already the default and nothing would convert: the kept lists
				// are reports, not writes, so there is nothing to apply.
				const noop =
					defaultTemplateId === own.id && preview.applied.length === 0;
				return {
					clubId: club.clubId,
					templateId: own.id,
					name: own.name,
					contentHash: digest(content),
					currentDefaultTemplateId: defaultTemplateId,
					wouldApply: preview.applied.map(entry),
					keptEdited: preview.keptEdited.map(entry),
					keptSignups: preview.keptSignups.map(withRoles),
					keptRoles: preview.keptRoles.map(withRoles),
					...(noop ? { noop: true as const } : {}),
				};
			},
			apply: async () =>
				serializeSetDefault(
					await setClubDefaultTemplate({
						clubId: club.clubId,
						templateId,
						actorMemberId: club.membershipId,
					}),
				),
		});
	},
};
