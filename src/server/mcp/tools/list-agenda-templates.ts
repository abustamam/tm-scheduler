/**
 * `list_agenda_templates` — the club's agenda templates, and one template's rows (#1628).
 *
 * Read-only. The club's own templates come from `listClubAgendas` (disabled
 * ones included, so an officer can see what they switched off) and the global
 * ones from `listAvailableTemplates` (enabled only). `templateId` reads one
 * template's rows, and only a template this very listing returned: another
 * club's template or a meeting's private copy is `NOT_FOUND`, checked against
 * the list BEFORE any content is read.
 */
import { z } from "zod";
import { db } from "#/db";
import { listClubAgendas } from "#/server/club-agendas-logic";
import {
	listAvailableTemplates,
	TemplateTooLargeError,
	templateContentForHash,
} from "#/server/meeting-templates-logic";
import { authorizeToken } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

export const LIST_AGENDA_TEMPLATES_TOOL = "list_agenda_templates";

export const TEMPLATE_NOT_LISTED_MESSAGE =
	"Call list_agenda_templates without templateId for this club's template ids.";

/** What a person reads of one agenda row. */
export type TemplateRow = {
	kind: string;
	label: string;
	detail: string | null;
	minutes: number;
	roleKey: string | null;
};

export function toTemplateRow(r: {
	kind: string;
	label: string;
	detail: string | null;
	minutes: number;
	roleKey: string | null;
}): TemplateRow {
	return {
		kind: r.kind,
		label: r.label,
		detail: r.detail,
		minutes: r.minutes,
		roleKey: r.roleKey,
	};
}

const inputSchema = {
	clubId: z.string().uuid(),
	templateId: z
		.string()
		.uuid()
		.optional()
		.describe(
			"Also return this template's rows. Must be an id this listing returns.",
		),
};

export const listAgendaTemplatesTool: McpToolDefinition = {
	name: LIST_AGENDA_TEMPLATES_TOOL,
	audience: "officer",
	annotations: { readOnlyHint: true },
	config: {
		title: "List agenda templates",
		description:
			"List the club's agenda templates (its own, disabled ones included, and " +
			"the enabled global ones), which one is the club default, and, with " +
			"templateId, that template's rows. To make a new template: pick a " +
			"scheduled meeting that should carry the change, get_agenda for its row " +
			"ids, edit_agenda to shape it, then save_agenda_as_template; to leave " +
			"the meeting as it was, reverse the edit with edit_agenda afterwards.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club } = await authorizeToken(ctx, args.clubId);
		const [agendas, available] = await Promise.all([
			listClubAgendas(club.clubId),
			listAvailableTemplates(club.clubId),
		]);
		const templates = [
			...agendas.templates.map((t) => ({
				id: t.id,
				name: t.name,
				description: t.description,
				scope: "club" as const,
				enabled: t.enabled,
				isDefault: t.isDefault,
				rowCount: t.beatCount as number | null,
			})),
			...available
				.filter((t) => t.clubId === null)
				.map((t) => ({
					id: t.id,
					name: t.name,
					description: t.description,
					scope: "global" as const,
					enabled: true,
					isDefault: false,
					rowCount: null as number | null,
				})),
		];
		const out: Record<string, unknown> = {
			clubId: club.clubId,
			adopted: agendas.adopted,
			defaultTemplateId: agendas.templates.find((t) => t.isDefault)?.id ?? null,
			templates,
		};
		if (args.templateId !== undefined) {
			const listed = templates.find((t) => t.id === args.templateId);
			if (!listed) {
				throw new McpError("NOT_FOUND", TEMPLATE_NOT_LISTED_MESSAGE);
			}
			let content: Awaited<ReturnType<typeof templateContentForHash>>;
			try {
				content = await templateContentForHash(db, listed.id);
			} catch (err) {
				if (err instanceof TemplateTooLargeError) {
					throw new McpError("VALIDATION", err.message);
				}
				throw err;
			}
			if (!content)
				throw new McpError("NOT_FOUND", TEMPLATE_NOT_LISTED_MESSAGE);
			out.template = {
				id: listed.id,
				name: listed.name,
				rows: content.beats.map(toTemplateRow),
			};
		}
		return out;
	},
};
