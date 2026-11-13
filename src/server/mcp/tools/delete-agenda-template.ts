/**
 * `delete_agenda_template` — delete one of the club's own templates (#1630).
 * The app's `deleteClubTemplate`.
 *
 * The plan carries the template's rows (so the conversation keeps a copy of
 * what is deleted) and a content hash. The delete passes that hash to the
 * logic, which compares it under the club lock: a #909 replace landing between
 * this tool's re-plan and the delete's lock deletes nothing and answers
 * `PLAN_STALE` with a fresh plan.
 */
import { z } from "zod";
import { digest } from "#/lib/mcp-plan";
import { deleteClubTemplate } from "#/server/club-agendas-logic";
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
	type TemplateRow,
	toTemplateRow,
} from "./list-agenda-templates";

export const DELETE_AGENDA_TEMPLATE_TOOL = "delete_agenda_template";

const inputSchema = {
	clubId: z.string().uuid(),
	templateId: z
		.string()
		.uuid()
		.describe("One of the club's own templates (list_agenda_templates)."),
	planHash: planHashField,
};

type DeletePlan = {
	clubId: string;
	templateId: string;
	name: string;
	isDefault: boolean;
	rows: TemplateRow[];
	contentHash: string;
	noop?: undefined;
};

export const deleteAgendaTemplateTool: McpToolDefinition = {
	name: DELETE_AGENDA_TEMPLATE_TOOL,
	audience: "officer",
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
	},
	config: {
		title: "Delete an agenda template",
		description:
			"Delete one of the club's own agenda templates (list_agenda_templates " +
			"gives the ids). Deleting does not change meetings that already use " +
			"the template, which keep their own copy of the agenda. If it was the " +
			"club's default, new meetings go back to the standard agenda. It " +
			"cannot be undone; the plan lists every row being deleted. Without " +
			"planHash this writes nothing and returns a plan and a planHash; show " +
			"the plan to the user, then call again with the same input plus that " +
			"planHash.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const clubId = inputOrValidation(
			z.object({ clubId: inputSchema.clubId }),
			input,
		).clubId;
		const { club, user } = await authorizeToken(ctx, clubId);
		const args = inputOrValidation(z.object(inputSchema), input);
		return planFlow<DeletePlan, { wasDefault: boolean }>({
			tool: DELETE_AGENDA_TEMPLATE_TOOL,
			clubId: club.clubId,
			userId: user.id,
			planHash: args.planHash,
			build: async () => {
				const own = await loadOwnTemplate(club.clubId, args.templateId);
				const content = await readTemplateContent(
					own.id,
					REPLACE_TARGET_NOT_LISTED_MESSAGE,
				);
				return {
					clubId: club.clubId,
					templateId: own.id,
					name: own.name,
					isDefault: own.isDefault,
					rows: content.beats.map(toTemplateRow),
					contentHash: digest(content),
				};
			},
			apply: (plan) =>
				deleteClubTemplate({
					clubId: club.clubId,
					templateId: plan.templateId,
					expectContentHash: plan.contentHash,
					expectIsDefault: plan.isDefault,
				}),
		});
	},
};
