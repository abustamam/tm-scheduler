/**
 * `apply_agenda_template` — put a meeting on an agenda template (#1629).
 *
 * The app's "Change template" on a meeting. Applying replaces the meeting's
 * agenda and can remove role slots, releasing whoever holds them. A call
 * WITHOUT `planHash` writes nothing and returns the plan, naming every person
 * who would be released. The apply runs the app's own seam,
 * `applyTemplateConversion`, with an `expectPlan` hook: the hook rebuilds the
 * plan from the FINAL derivation under the seam's locks (meeting, source
 * template, every slot) and refuses a mismatch before the first write, so what
 * the officer approved is what happens. A claim that lands after the hook
 * waits on the slot locks.
 *
 * `buildApplyPlan` is the ONE builder, run with `db` for the preview and with
 * the transaction for the hook, so the two cannot serialise differently.
 */

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings } from "#/db/schema";
import { digest, planHash } from "#/lib/mcp-plan";
import {
	MEETING_LOCKED_MESSAGE,
	meetingRefusal,
} from "#/lib/meeting-lifecycle";
import { plannedMaterialisation } from "#/server/meeting-agenda-edit-logic";
import {
	applyTemplateConversion,
	CONVERT_CANCELLED_MESSAGE,
	CONVERT_TEMPLATE_GONE_MESSAGE,
	type ConversionPlanDetail,
	type DbOrTx,
	planTemplateConversion,
	type ReleasedHolder,
	TemplateTooLargeError,
	templateContentForHash,
} from "#/server/meeting-templates-logic";
import { isDeadlock } from "#/server/pg-errors";
import { authorizeTokenForMeeting } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";
import {
	REPLACE_TARGET_NOT_LISTED_MESSAGE,
	type TemplateRow,
	toTemplateRow,
} from "./list-agenda-templates";

export const APPLY_AGENDA_TEMPLATE_TOOL = "apply_agenda_template";

export const APPLY_PLAN_STALE_MESSAGE =
	"The meeting or the template changed since that preview. Show the user the fresh plan and ask again.";

const inputSchema = {
	meetingId: z.string().uuid(),
	templateId: z
		.string()
		.uuid()
		.nullable()
		.describe(
			"The template to apply (list_agenda_templates gives the ids), or null to restore the club's standard agenda.",
		),
	planHash: z
		.string()
		.min(1)
		.max(200)
		.optional()
		.describe(
			"Omit to preview. Pass the planHash a preview returned to apply that plan.",
		),
};

export type ApplyPlan = {
	meetingId: string;
	templateId: string | null;
	templateName: string | null;
	templateRows: TemplateRow[] | null;
	templateContentHash: string | null;
	outgoingAgendaHash: string;
	openSlotsRemoved: number;
	claimedSlotsReleased: number;
	slotsWithSpeeches: number;
	slotsAdded: number;
	releasedHolders: ReleasedHolder[];
	releasedRoleNames: string[];
	removedRoleNames: string[];
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Holders in a total order: role, then name, then the member or guest id. */
export function sortHolders(holders: ReleasedHolder[]): ReleasedHolder[] {
	return holders
		.map((h) => ({
			memberId: h.memberId,
			guestId: h.guestId,
			name: h.name,
			roleName: h.roleName,
		}))
		.sort(
			(a, b) =>
				cmp(a.roleName, b.roleName) ||
				cmp(a.name, b.name) ||
				cmp(a.memberId ?? a.guestId ?? "", b.memberId ?? b.guestId ?? ""),
		);
}

/**
 * The plan, on one connection. Everything the plan says is read on `conn`
 * except `detail`, which the caller computed on the same connection.
 */
export async function buildApplyPlan(
	conn: DbOrTx,
	meetingId: string,
	templateId: string | null,
	detail: ConversionPlanDetail,
): Promise<ApplyPlan> {
	const target =
		templateId === null ? null : await templateContentForHash(conn, templateId);
	if (templateId !== null && !target) {
		throw new Error(CONVERT_TEMPLATE_GONE_MESSAGE);
	}
	const [meeting] = await conn
		.select({ templateId: meetings.templateId })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!meeting) throw new McpError("NOT_FOUND", "Meeting not found.");
	// The outgoing agenda, built exactly as save_agenda_as_template's source
	// hash: the stored copy, or what opening the meeting would store.
	const outgoing =
		meeting.templateId !== null
			? await templateContentForHash(conn, meeting.templateId)
			: await plannedMaterialisation(conn, meetingId);
	if (!outgoing) throw new McpError("NOT_FOUND", "Meeting not found.");
	return {
		meetingId,
		templateId,
		templateName: target?.name ?? null,
		templateRows: target ? target.beats.map(toTemplateRow) : null,
		templateContentHash: target ? digest(target) : null,
		outgoingAgendaHash: digest(outgoing),
		openSlotsRemoved: detail.openSlotsRemoved,
		claimedSlotsReleased: detail.claimedSlotsReleased,
		slotsWithSpeeches: detail.slotsWithSpeeches,
		slotsAdded: detail.slotsAdded,
		releasedHolders: sortHolders(detail.releasedHolders),
		releasedRoleNames: [...detail.releasedRoleNames].sort(cmp),
		removedRoleNames: [...detail.removedRoleNames].sort(cmp),
	};
}

/** Thrown by the hook, under the locks, when the locked plan is not the approved one. */
class PlanStaleError extends Error {
	constructor(
		readonly plan: ApplyPlan,
		readonly hash: string,
	) {
		super(APPLY_PLAN_STALE_MESSAGE);
		this.name = "PlanStaleError";
	}
}

function lockedError(status: "completed" | "cancelled", message: string) {
	return new McpError("LOCKED", message, {
		reason: status === "completed" ? "meeting_completed" : "meeting_cancelled",
		retryable: false,
	});
}

/** The meeting refusal both the preview and the apply make before the seam. */
async function assertMeetingOpen(meetingId: string) {
	const [m] = await db
		.select({ status: meetings.status })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!m) throw new McpError("NOT_FOUND", "Meeting not found.");
	const refused = meetingRefusal(m.status, "plan");
	if (refused === "cancelled") {
		throw lockedError("cancelled", CONVERT_CANCELLED_MESSAGE);
	}
	if (refused === "completed") {
		throw lockedError("completed", MEETING_LOCKED_MESSAGE);
	}
}

/** Map what the plan builder or the seam throws, by identity, class or SQLSTATE. */
function mapError(err: unknown): unknown {
	if (err instanceof McpError) return err;
	if (err instanceof TemplateTooLargeError) {
		return new McpError("VALIDATION", err.message);
	}
	if (isDeadlock(err)) {
		return new McpError(
			"LOCKED",
			"Someone else was changing this meeting. Please try again.",
			{ reason: "deadlock", retryable: true },
		);
	}
	if (!(err instanceof Error)) return err;
	if (err.message === CONVERT_TEMPLATE_GONE_MESSAGE) {
		return new McpError("NOT_FOUND", REPLACE_TARGET_NOT_LISTED_MESSAGE);
	}
	if (err.message === CONVERT_CANCELLED_MESSAGE) {
		return lockedError("cancelled", err.message);
	}
	if (err.message === MEETING_LOCKED_MESSAGE) {
		return lockedError("completed", err.message);
	}
	return err;
}

export const applyAgendaTemplateTool: McpToolDefinition = {
	name: APPLY_AGENDA_TEMPLATE_TOOL,
	audience: "officer",
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
	},
	config: {
		title: "Apply an agenda template to a meeting",
		description:
			"Put a meeting on an agenda template (list_agenda_templates gives the " +
			"ids), or pass templateId null to restore the club's standard agenda. " +
			"Applying replaces the meeting's agenda and can remove role slots and " +
			"release the people holding them; the plan names every one. Show that " +
			"list to the user in full before applying. Nothing is sent to anyone " +
			"released: the officer tells them. Without planHash this writes " +
			"nothing and returns a plan and a planHash; call again with the same " +
			"input plus that planHash to apply. A completed or cancelled meeting " +
			"is refused.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const meetingId = (() => {
			const parsed = z
				.object({ meetingId: inputSchema.meetingId })
				.safeParse(input);
			if (!parsed.success) {
				throw new McpError("VALIDATION", "meetingId: must be a uuid");
			}
			return parsed.data.meetingId;
		})();
		const { club, user } = await authorizeTokenForMeeting(ctx, meetingId);
		const parsed = z.object(inputSchema).safeParse(input);
		if (!parsed.success) {
			throw new McpError(
				"VALIDATION",
				parsed.error.issues
					.map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
					.join("; "),
			);
		}
		const args = parsed.data;
		const hashOf = (plan: ApplyPlan) =>
			planHash({
				tool: APPLY_AGENDA_TEMPLATE_TOOL,
				clubId: club.clubId,
				userId: user.id,
				plan,
			});

		try {
			await assertMeetingOpen(meetingId);

			if (args.planHash === undefined) {
				const detail = await planTemplateConversion(meetingId, args.templateId);
				const plan = await buildApplyPlan(
					db,
					meetingId,
					args.templateId,
					detail,
				);
				return {
					applied: false,
					meetingId,
					clubId: club.clubId,
					plan,
					planHash: hashOf(plan),
				};
			}

			let locked: ApplyPlan | null = null;
			try {
				await applyTemplateConversion({
					meetingId,
					clubId: club.clubId,
					templateId: args.templateId,
					actorMemberId: club.membershipId,
					expectPlan: async (final, tx) => {
						const plan = await buildApplyPlan(
							tx,
							meetingId,
							args.templateId,
							final,
						);
						const hash = hashOf(plan);
						if (hash !== args.planHash) throw new PlanStaleError(plan, hash);
						locked = plan;
					},
				});
			} catch (err) {
				if (err instanceof PlanStaleError) {
					throw new McpError("PLAN_STALE", APPLY_PLAN_STALE_MESSAGE, {
						plan: err.plan,
						planHash: err.hash,
					});
				}
				throw err;
			}
			return {
				applied: true,
				meetingId,
				clubId: club.clubId,
				plan: locked,
			};
		} catch (err) {
			throw mapError(err);
		}
	},
};
