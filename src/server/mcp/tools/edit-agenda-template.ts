/**
 * `edit_agenda_template` — rename, re-describe, enable or disable a club
 * template (#1630). The app's `renameClubTemplate` and `setClubTemplateEnabled`.
 *
 * Preview, then apply (see `planFlow`). The two writes are two transactions
 * (enable first, then rename), so the second can refuse after the first has
 * committed; the error then carries `detail.partiallyApplied` so the agent can
 * tell the officer exactly what changed.
 */
import { z } from "zod";
import { parseClubTemplateFields } from "#/lib/club-template-key";
import {
	renameClubTemplate,
	setClubTemplateEnabled,
} from "#/server/club-agendas-logic";
import { authorizeToken } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";
import {
	inputOrValidation,
	loadOwnTemplate,
	mapLogicError,
	planFlow,
	planHashField,
} from "./agenda-template-plan";

export const EDIT_AGENDA_TEMPLATE_TOOL = "edit_agenda_template";

const inputSchema = {
	clubId: z.string().uuid(),
	templateId: z
		.string()
		.uuid()
		.describe("One of the club's own templates (list_agenda_templates)."),
	name: z.string().max(400).optional().describe("Omit to keep the name."),
	description: z
		.string()
		.max(2000)
		.nullable()
		.optional()
		.describe("Omit to keep the description; null clears it."),
	enabled: z
		.boolean()
		.optional()
		.describe("Omit to keep it. A disabled template is hidden from pickers."),
	planHash: planHashField,
};

type Fields = { name: string; description: string | null; enabled: boolean };

type EditPlan = {
	clubId: string;
	templateId: string;
	from: Fields;
	to: Fields;
	noop?: true;
};

export const editAgendaTemplateTool: McpToolDefinition = {
	name: EDIT_AGENDA_TEMPLATE_TOOL,
	audience: "officer",
	// It can clear a description, as edit_member can clear a field.
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
	},
	config: {
		title: "Edit an agenda template",
		description:
			"Rename a club agenda template, change or clear its description, " +
			"and/or enable or disable it (list_agenda_templates gives the ids). " +
			"Give at least one of name, description (null clears), enabled. " +
			"The club's current default cannot be disabled: clear it first with " +
			"set_default_agenda_template. Meetings that already use the template " +
			"are not changed. Without planHash this writes nothing and returns a " +
			"plan and a planHash; show the plan to the user, then call again with " +
			"the same input plus that planHash.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const clubId = inputOrValidation(
			z.object({ clubId: inputSchema.clubId }),
			input,
		).clubId;
		const { club, user } = await authorizeToken(ctx, clubId);
		const args = inputOrValidation(z.object(inputSchema), input);
		if (
			args.name === undefined &&
			args.description === undefined &&
			args.enabled === undefined
		) {
			throw new McpError(
				"VALIDATION",
				"Give at least one of name, description or enabled.",
			);
		}
		// Each field is checked on its own so the refusal names the field at fault.
		if (args.name !== undefined) {
			const checked = parseClubTemplateFields(args.name, null);
			if ("error" in checked) {
				throw new McpError("VALIDATION", `name: ${checked.error}`);
			}
		}
		if (args.description !== undefined && args.description !== null) {
			const checked = parseClubTemplateFields("x", args.description);
			if ("error" in checked) {
				throw new McpError("VALIDATION", `description: ${checked.error}`);
			}
		}

		return planFlow<EditPlan, unknown>({
			tool: EDIT_AGENDA_TEMPLATE_TOOL,
			clubId: club.clubId,
			userId: user.id,
			planHash: args.planHash,
			build: async () => {
				const current = await loadOwnTemplate(club.clubId, args.templateId);
				if (args.enabled === false && current.isDefault) {
					throw new McpError(
						"VALIDATION",
						"enabled: this template is the club's default, so it cannot be disabled. Clear the default first with set_default_agenda_template (templateId null).",
					);
				}
				const parsed = parseClubTemplateFields(
					args.name ?? current.name,
					args.description === undefined
						? current.description
						: args.description,
				);
				if ("error" in parsed) throw new McpError("VALIDATION", parsed.error);
				const from: Fields = {
					name: current.name,
					description: current.description,
					enabled: current.enabled,
				};
				const to: Fields = {
					name: parsed.name,
					description: parsed.description,
					enabled: args.enabled ?? current.enabled,
				};
				const same =
					from.name === to.name &&
					from.description === to.description &&
					from.enabled === to.enabled;
				return {
					clubId: club.clubId,
					templateId: current.id,
					from,
					to,
					...(same ? { noop: true as const } : {}),
				};
			},
			apply: async (plan) => {
				const partial: string[] = [];
				try {
					if (plan.to.enabled !== plan.from.enabled) {
						await setClubTemplateEnabled({
							clubId: club.clubId,
							templateId: plan.templateId,
							enabled: plan.to.enabled,
						});
						partial.push("enabled");
					}
					if (
						plan.to.name !== plan.from.name ||
						plan.to.description !== plan.from.description
					) {
						await renameClubTemplate({
							clubId: club.clubId,
							templateId: plan.templateId,
							name: plan.to.name,
							description: plan.to.description,
						});
					}
				} catch (err) {
					throw mapLogicError(err, partial.length > 0 ? partial : undefined);
				}
				return {
					templateId: plan.templateId,
					name: plan.to.name,
					description: plan.to.description,
					enabled: plan.to.enabled,
				};
			},
		});
	},
};
