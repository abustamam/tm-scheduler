/**
 * `duplicate_agenda_template` — copy a club template into a new enabled one
 * named "Copy of ..." (#1630). The app's `duplicateClubTemplate`.
 */
import { z } from "zod";
import { digest } from "#/lib/mcp-plan";
import {
	duplicateClubTemplate,
	duplicateName,
} from "#/server/club-agendas-logic";
import { authorizeToken } from "../authz-logic";
import type { McpToolDefinition } from "../tool";
import {
	inputOrValidation,
	loadOwnTemplate,
	planFlow,
	planHashField,
} from "./agenda-template-plan";
import {
	REPLACE_TARGET_NOT_LISTED_MESSAGE,
	readTemplateContent,
} from "./list-agenda-templates";

export const DUPLICATE_AGENDA_TEMPLATE_TOOL = "duplicate_agenda_template";

const inputSchema = {
	clubId: z.string().uuid(),
	templateId: z
		.string()
		.uuid()
		.describe("One of the club's own templates (list_agenda_templates)."),
	planHash: planHashField,
};

type DuplicatePlan = {
	clubId: string;
	templateId: string;
	sourceName: string;
	newName: string;
	contentHash: string;
	noop?: undefined;
};

export const duplicateAgendaTemplateTool: McpToolDefinition = {
	name: DUPLICATE_AGENDA_TEMPLATE_TOOL,
	audience: "officer",
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
	},
	config: {
		title: "Duplicate an agenda template",
		description:
			"Copy one of the club's own agenda templates (list_agenda_templates " +
			"gives the ids) into a new, enabled template named 'Copy of <name>'. " +
			"Each call makes another copy. Without planHash this writes nothing " +
			"and returns a plan and a planHash; show the plan to the user, then " +
			"call again with the same input plus that planHash. The result is the " +
			"new template's id.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const clubId = inputOrValidation(
			z.object({ clubId: inputSchema.clubId }),
			input,
		).clubId;
		const { club, user } = await authorizeToken(ctx, clubId);
		const args = inputOrValidation(z.object(inputSchema), input);
		return planFlow<DuplicatePlan, { templateId: string }>({
			tool: DUPLICATE_AGENDA_TEMPLATE_TOOL,
			clubId: club.clubId,
			userId: user.id,
			planHash: args.planHash,
			build: async () => {
				const source = await loadOwnTemplate(club.clubId, args.templateId);
				const content = await readTemplateContent(
					source.id,
					REPLACE_TARGET_NOT_LISTED_MESSAGE,
				);
				return {
					clubId: club.clubId,
					templateId: source.id,
					sourceName: source.name,
					newName: duplicateName(source.name),
					contentHash: digest(content),
				};
			},
			apply: (plan) =>
				duplicateClubTemplate({
					clubId: club.clubId,
					templateId: plan.templateId,
				}),
		});
	},
};
