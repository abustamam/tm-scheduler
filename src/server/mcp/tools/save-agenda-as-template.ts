/**
 * `save_agenda_as_template` — save one meeting's agenda as a club template (#1628).
 *
 * The app never edits a template directly: an officer edits a meeting's agenda
 * and chooses "Save as club template". The connector mirrors that: shape a
 * meeting with `edit_agenda`, then save it here. This calls the app's own seam,
 * `saveMeetingAgendaAsClubTemplate`, and adds nothing to it.
 *
 * Preview, then apply, in the conversation (the `edit_agenda` shape). A call
 * WITHOUT `planHash` writes nothing, not even the meeting's own stored copy: it
 * reads through `readAgendaSnapshot` and returns the plan. The plan carries a
 * CONTENT hash of what will be saved (and, for a replace, of what will be
 * overwritten), so a change to any copied field, not only the rows a person
 * reads, makes the plan stale. The apply re-plans, compares, then calls the
 * seam. The re-plan runs outside the seam's transaction: an agenda edit landing
 * between them is saved as it then stands, the same window the app's dialog has.
 * A replace's TARGET is not in that window: the seam compares the target's
 * content hash under its own locks and refuses a changed target (PLAN_STALE).
 */

import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetingTemplates } from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import { parseClubTemplateFields } from "#/lib/club-template-key";
import { digest, planHash } from "#/lib/mcp-plan";
import { meetingRefusal } from "#/lib/meeting-lifecycle";
import { MAX_TEMPLATE_BEATS } from "#/lib/meeting-template-limits";
import {
	AGENDA_DEADLOCK_MESSAGE,
	plannedMaterialisation,
	readAgendaSnapshot,
} from "#/server/meeting-agenda-edit-logic";
import {
	CLUB_TEMPLATE_CHANGED_MESSAGE,
	CLUB_TEMPLATE_GONE_MESSAGE,
	SAVE_CANCELLED_MESSAGE,
	saveMeetingAgendaAsClubTemplate,
	TemplateTooLargeError,
} from "#/server/meeting-templates-logic";
import { authorizeTokenForMeeting } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";
import {
	REPLACE_TARGET_NOT_LISTED_MESSAGE,
	readTemplateContent,
	type TemplateRow,
	toTemplateRow,
} from "./list-agenda-templates";

export const SAVE_AGENDA_AS_TEMPLATE_TOOL = "save_agenda_as_template";

export const TEMPLATE_PLAN_STALE_MESSAGE =
	"The agenda or the template changed since that preview. Show the user the fresh plan and ask again.";

const inputSchema = {
	meetingId: z.string().uuid(),
	target: z.discriminatedUnion("mode", [
		z
			.object({
				mode: z.literal("new"),
				name: z.string().max(400),
				description: z.string().max(2000).nullable().optional(),
			})
			.strict(),
		z
			.object({ mode: z.literal("replace"), templateId: z.string().uuid() })
			.strict(),
	]),
	planHash: z
		.string()
		.min(1)
		.max(200)
		.optional()
		.describe(
			"Omit to preview. Pass the planHash a preview returned to apply that plan.",
		),
};

type SavePlan = {
	meetingId: string;
	mode: "new" | "replace";
	source: { rows: TemplateRow[]; contentHash: string };
	target:
		| { name: string; description: string | null }
		| {
				templateId: string;
				name: string;
				currentRows: TemplateRow[];
				currentContentHash: string;
		  };
};

type TargetReplace = Extract<
	SavePlan["target"],
	{ currentContentHash: string }
>;

type Target = z.infer<typeof inputSchema.target>;

/** `schema.parse`, with a failure told as `VALIDATION` rather than a thrown zod error. */
function inputOrValidation<T extends z.ZodType>(
	schema: T,
	input: unknown,
): z.infer<T> {
	const parsed = schema.safeParse(input);
	if (!parsed.success) {
		throw new McpError(
			"VALIDATION",
			parsed.error.issues
				.map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
				.join("; "),
		);
	}
	return parsed.data;
}

/** The trimmed fields the seam will store for a "new" target, or `VALIDATION`. */
function validNewFields(target: { name: string; description?: string | null }) {
	const parsed = parseClubTemplateFields(
		target.name,
		target.description ?? null,
	);
	if ("error" in parsed) throw new McpError("VALIDATION", parsed.error);
	return parsed;
}

/** The plan, refused for everything the preview and the apply both refuse. */
async function buildPlan(
	meetingId: string,
	clubId: string,
	target: Target,
): Promise<SavePlan> {
	// Input validation first, so an invalid request is never reported as stale.
	const checked =
		target.mode === "new"
			? { mode: "new" as const, ...validNewFields(target) }
			: target;

	const snap = await readAgendaSnapshot(meetingId, db);
	if (!snap || snap.clubId !== clubId) {
		throw new McpError("NOT_FOUND", "Meeting not found.");
	}
	// `meetingRefusal` first: an unknown status throws a plain Error (INTERNAL).
	if (meetingRefusal(snap.status, "record") === "cancelled") {
		throw new McpError("LOCKED", SAVE_CANCELLED_MESSAGE, {
			reason: "meeting_cancelled",
			retryable: false,
		});
	}
	if (snap.rows.length === 0) {
		throw new McpError(
			"VALIDATION",
			"This meeting's agenda has no rows to save.",
		);
	}
	if (snap.rows.length > MAX_TEMPLATE_BEATS) {
		throw new McpError(
			"VALIDATION",
			`This meeting's agenda is too large to copy (${MAX_TEMPLATE_BEATS} rows maximum).`,
		);
	}

	let sourceContent: unknown;
	if (snap.templateId !== null) {
		sourceContent = await readTemplateContent(
			snap.templateId,
			"Meeting not found.",
		);
	} else {
		// Never opened: nothing is stored yet, so hash what the seam is about to
		// store (the full derivation, not the snapshot's projection).
		sourceContent = await plannedMaterialisation(db, meetingId);
		if (!sourceContent) throw new McpError("NOT_FOUND", "Meeting not found.");
	}
	const source = {
		rows: snap.rows.map(toTemplateRow),
		contentHash: digest(sourceContent),
	};

	if (checked.mode === "new") {
		return {
			meetingId,
			mode: "new",
			source,
			target: { name: checked.name, description: checked.description },
		};
	}
	// The tenant boundary is the query: this club's own template, never a
	// global one, another club's, or a meeting's private copy.
	const [own] = await db
		.select({ id: meetingTemplates.id })
		.from(meetingTemplates)
		.where(
			and(
				eq(meetingTemplates.id, checked.templateId),
				eq(meetingTemplates.clubId, clubId),
				isNull(meetingTemplates.meetingId),
			),
		)
		.limit(1);
	if (!own) {
		throw new McpError("NOT_FOUND", REPLACE_TARGET_NOT_LISTED_MESSAGE);
	}
	const current = await readTemplateContent(
		own.id,
		REPLACE_TARGET_NOT_LISTED_MESSAGE,
	);
	return {
		meetingId,
		mode: "replace",
		source,
		target: {
			templateId: own.id,
			name: current.name,
			currentRows: current.beats.map(toTemplateRow),
			currentContentHash: digest(current),
		},
	};
}

/** Map what the seam throws, by identity with its exported constants. */
function seamError(err: unknown): unknown {
	if (err instanceof McpError) return err;
	if (err instanceof TemplateTooLargeError) {
		return new McpError("VALIDATION", err.message);
	}
	if (!(err instanceof Error)) return err;
	if (err.message === SAVE_CANCELLED_MESSAGE) {
		return new McpError("LOCKED", err.message, {
			reason: "meeting_cancelled",
			retryable: false,
		});
	}
	if (err.message === CLUB_TEMPLATE_GONE_MESSAGE) {
		return new McpError("NOT_FOUND", REPLACE_TARGET_NOT_LISTED_MESSAGE);
	}
	if (err.message === CLUB_ARCHIVED_MESSAGE) {
		return new McpError("ARCHIVED", CLUB_ARCHIVED_MESSAGE);
	}
	if (err.message === AGENDA_DEADLOCK_MESSAGE) {
		return new McpError("LOCKED", err.message, {
			reason: "deadlock",
			retryable: true,
		});
	}
	return err;
}

export const saveAgendaAsTemplateTool: McpToolDefinition = {
	name: SAVE_AGENDA_AS_TEMPLATE_TOOL,
	audience: "officer",
	// A replace overwrites a template; a repeated "new" makes a second one.
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
	},
	config: {
		title: "Save an agenda as a club template",
		description:
			"Save one meeting's agenda as a club agenda template: target " +
			"{mode:'new', name, description?} makes a new template, " +
			"{mode:'replace', templateId} overwrites one of the club's own " +
			"(list_agenda_templates gives the ids). Saving changes no meeting's " +
			"agenda; the template is built from the meeting's agenda as it is " +
			"now, so use edit_agenda first to shape it. edit_agenda changes that " +
			"meeting for real, so shape a meeting that should carry the change or " +
			"put it back afterwards. A replace overwrites the template and cannot " +
			"be undone; the plan shows what it will overwrite. Without planHash " +
			"this writes nothing and returns a plan and a planHash; show the " +
			"plan to the user, then call again with the same input plus that " +
			"planHash. A cancelled meeting is refused.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		// Authorization, then the rest of the input (the SDK has already checked
		// the whole schema on the wire; this order holds for a direct call too).
		const meetingId = inputOrValidation(
			z.object({ meetingId: inputSchema.meetingId }),
			input,
		).meetingId;
		const { club, user } = await authorizeTokenForMeeting(ctx, meetingId);
		const args = inputOrValidation(z.object(inputSchema), input);
		const hashOf = (plan: SavePlan) =>
			planHash({
				tool: SAVE_AGENDA_AS_TEMPLATE_TOOL,
				clubId: club.clubId,
				userId: user.id,
				plan,
			});

		const plan = await buildPlan(args.meetingId, club.clubId, args.target);
		const fresh = hashOf(plan);
		if (args.planHash === undefined) {
			return {
				applied: false,
				meetingId: args.meetingId,
				clubId: club.clubId,
				plan,
				planHash: fresh,
			};
		}
		if (fresh !== args.planHash) {
			throw new McpError("PLAN_STALE", TEMPLATE_PLAN_STALE_MESSAGE, {
				plan,
				planHash: fresh,
			});
		}

		try {
			const { templateId } = await saveMeetingAgendaAsClubTemplate({
				meetingId: args.meetingId,
				clubId: club.clubId,
				actorMemberId: club.membershipId,
				...(args.target.mode === "new"
					? {
							mode: "new" as const,
							name: args.target.name,
							description: args.target.description ?? null,
						}
					: {
							mode: "replace" as const,
							templateId: args.target.templateId,
							// Checked by the seam under its own locks: the tool's
							// comparison above is outside them.
							expectedTargetContentHash: (plan.target as TargetReplace)
								.currentContentHash,
						}),
			});
			return {
				applied: true,
				meetingId: args.meetingId,
				clubId: club.clubId,
				templateId,
				plan,
			};
		} catch (err) {
			if (
				err instanceof Error &&
				err.message === CLUB_TEMPLATE_CHANGED_MESSAGE
			) {
				// The target changed after the re-plan: show what it is now.
				const latest = await buildPlan(
					args.meetingId,
					club.clubId,
					args.target,
				);
				throw new McpError("PLAN_STALE", TEMPLATE_PLAN_STALE_MESSAGE, {
					plan: latest,
					planHash: hashOf(latest),
				});
			}
			throw seamError(err);
		}
	},
};
