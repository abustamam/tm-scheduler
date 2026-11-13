/**
 * `adopt_standard_agenda` — make the standard agenda the club's own (#1630).
 * The app's `adoptStandardAgenda`: creates "Our standard agenda", makes it the
 * default and applies it to upcoming meetings.
 *
 * There is no per-meeting preview: the template does not exist until the write,
 * and it is a copy of the agenda those meetings already have. The preview
 * carries `upcomingMeetingCount` beside the plan, not inside it, so a meeting
 * created in between does not make the plan stale.
 */
import { count, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { clubs, meetings } from "#/db/schema";
import {
	ADOPTED_TEMPLATE_NAME,
	adoptStandardAgenda,
	upcomingScheduledMeetings,
} from "#/server/club-agendas-logic";
import { authorizeToken } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";
import {
	ALREADY_ADOPTED_REFUSAL,
	inputOrValidation,
	planFlow,
	planHashField,
} from "./agenda-template-plan";
import { serializeSetDefault } from "./set-default-agenda-template";

export const ADOPT_STANDARD_AGENDA_TOOL = "adopt_standard_agenda";

const inputSchema = {
	clubId: z.string().uuid(),
	planHash: planHashField,
};

type AdoptPlan = { clubId: string; templateName: string; noop?: undefined };

export const adoptStandardAgendaTool: McpToolDefinition = {
	name: ADOPT_STANDARD_AGENDA_TOOL,
	audience: "officer",
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
	},
	config: {
		title: "Adopt the standard agenda as the club's own",
		description:
			"Create a club template named 'Our standard agenda' from the standard " +
			"agenda, make it the club default and apply it to upcoming meetings " +
			"still on the standard agenda (it never removes a role or a " +
			"sign-up). Only for a club with no default yet; otherwise use " +
			"set_default_agenda_template. Without planHash this writes nothing " +
			"and returns a plan, a planHash and upcomingMeetingCount; show them to " +
			"the user, then call again with the same input plus that planHash.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const clubId = inputOrValidation(
			z.object({ clubId: inputSchema.clubId }),
			input,
		).clubId;
		const { club, user } = await authorizeToken(ctx, clubId);
		const args = inputOrValidation(z.object(inputSchema), input);
		return planFlow<AdoptPlan, unknown>({
			tool: ADOPT_STANDARD_AGENDA_TOOL,
			clubId: club.clubId,
			userId: user.id,
			planHash: args.planHash,
			build: async () => {
				const [row] = await db
					.select({ defaultTemplateId: clubs.defaultTemplateId })
					.from(clubs)
					.where(eq(clubs.id, club.clubId))
					.limit(1);
				if (row?.defaultTemplateId) {
					throw new McpError("VALIDATION", ALREADY_ADOPTED_REFUSAL);
				}
				return { clubId: club.clubId, templateName: ADOPTED_TEMPLATE_NAME };
			},
			previewExtra: async () => {
				const [n] = await db
					.select({ n: count() })
					.from(meetings)
					.where(upcomingScheduledMeetings(club.clubId));
				return { upcomingMeetingCount: n?.n ?? 0 };
			},
			apply: async () =>
				serializeSetDefault(
					await adoptStandardAgenda({
						clubId: club.clubId,
						actorMemberId: club.membershipId,
					}),
				),
		});
	},
};
