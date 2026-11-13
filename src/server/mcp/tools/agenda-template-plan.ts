/**
 * What the five agenda-template management tools share (#1630): the
 * preview-then-apply flow, the club-template lookup, and the one place a logic
 * refusal becomes an `McpError`.
 *
 * Not a tool: every tool still calls `authorizeToken` itself, in its own
 * handler, before anything here runs.
 *
 * Refusals are matched by `===` against the logic module's exported messages,
 * by error class, or by SQLSTATE; never by substring.
 */
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { clubs, meetingTemplates } from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import { planHash } from "#/lib/mcp-plan";
import {
	ALREADY_ADOPTED_MESSAGE,
	CLUB_TEMPLATE_DISABLED_MESSAGE,
	DISABLE_DEFAULT_MESSAGE,
	TemplateChangedError,
} from "#/server/club-agendas-logic";
import {
	CLUB_TEMPLATE_GONE_MESSAGE,
	TemplateTooLargeError,
} from "#/server/meeting-templates-logic";
import { isDeadlock } from "#/server/pg-errors";
import { INTERNAL_MESSAGE, McpError } from "../errors";
import { REPLACE_TARGET_NOT_LISTED_MESSAGE } from "./list-agenda-templates";

export const TEMPLATE_MANAGE_STALE_MESSAGE =
	"The template or the club's agendas changed since that preview. Show the user the fresh plan and ask again.";

/** `schema.parse`, with a failure told as `VALIDATION` rather than a thrown zod error. */
export function inputOrValidation<T extends z.ZodType>(
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

/** The `planHash` field every tool carries. */
export const planHashField = z
	.string()
	.min(1)
	.max(200)
	.optional()
	.describe(
		"Omit to preview. Pass the planHash a preview returned to apply that plan.",
	);

/** One of THIS club's own templates, with whether it is the club's default. */
export type OwnTemplate = {
	id: string;
	name: string;
	description: string | null;
	enabled: boolean;
	isDefault: boolean;
};

/**
 * The club's own template, or `NOT_FOUND`. The tenant boundary is the query:
 * a global template, another club's and a meeting's private copy are all
 * absent.
 */
export async function loadOwnTemplate(
	clubId: string,
	templateId: string,
): Promise<OwnTemplate> {
	const [row] = await db
		.select({
			id: meetingTemplates.id,
			name: meetingTemplates.name,
			description: meetingTemplates.description,
			enabled: meetingTemplates.enabled,
			defaultTemplateId: clubs.defaultTemplateId,
		})
		.from(meetingTemplates)
		.innerJoin(clubs, eq(clubs.id, meetingTemplates.clubId))
		.where(
			and(
				eq(meetingTemplates.id, templateId),
				eq(meetingTemplates.clubId, clubId),
				isNull(meetingTemplates.meetingId),
			),
		)
		.limit(1);
	if (!row) throw new McpError("NOT_FOUND", REPLACE_TARGET_NOT_LISTED_MESSAGE);
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		enabled: row.enabled,
		isDefault: row.defaultTemplateId === row.id,
	};
}

/** Setting a disabled template as the default, refused by the tool's own check. */
export function disabledTemplateError(): McpError {
	return new McpError(
		"VALIDATION",
		"templateId: that template is disabled. Enable it first with edit_agenda_template.",
	);
}

/** The refusal for disabling the club's default; said by the preview and by the logic's own check. */
export const DISABLE_DEFAULT_REFUSAL =
	"enabled: this template is the club's default, so it cannot be disabled. Clear the default first with set_default_agenda_template (templateId null).";

/** The refusal for adopting when the club has a default; likewise said twice. */
export const ALREADY_ADOPTED_REFUSAL =
	"The club already has a default agenda; use set_default_agenda_template.";

/**
 * Map what the logic functions throw. `partiallyApplied` rides on any mapped
 * error, and on an UNMAPPED one too: an earlier write already committed, so a
 * bare `INTERNAL` saying nothing changed would be false.
 */
export function mapLogicError(
	err: unknown,
	partiallyApplied?: string[],
): unknown {
	const mapped = mapKnownLogicError(err, partiallyApplied);
	if (!partiallyApplied || mapped instanceof McpError) return mapped;
	if (mapped instanceof TemplateChangedError) return mapped;
	console.error("[mcp:agenda-template] unhandled error:", err);
	return new McpError("INTERNAL", INTERNAL_MESSAGE, { partiallyApplied });
}

function mapKnownLogicError(
	err: unknown,
	partiallyApplied?: string[],
): unknown {
	const detail = partiallyApplied ? { partiallyApplied } : undefined;
	if (err instanceof McpError) return err;
	if (err instanceof TemplateChangedError) {
		// `planFlow` turns this into PLAN_STALE; it carries what already landed.
		if (partiallyApplied) err.partiallyApplied = partiallyApplied;
		return err;
	}
	if (err instanceof TemplateTooLargeError) {
		return new McpError("VALIDATION", err.message, detail);
	}
	if (isDeadlock(err)) {
		return new McpError(
			"LOCKED",
			"Someone else was changing this club's agendas. Please try again.",
			{ reason: "deadlock", retryable: true, ...detail },
		);
	}
	if (!(err instanceof Error)) return err;
	if (err.message === CLUB_ARCHIVED_MESSAGE) {
		return new McpError("ARCHIVED", CLUB_ARCHIVED_MESSAGE, detail);
	}
	if (err.message === CLUB_TEMPLATE_GONE_MESSAGE) {
		return new McpError("NOT_FOUND", REPLACE_TARGET_NOT_LISTED_MESSAGE, detail);
	}
	if (err.message === DISABLE_DEFAULT_MESSAGE) {
		return new McpError("VALIDATION", DISABLE_DEFAULT_REFUSAL, detail);
	}
	if (err.message === CLUB_TEMPLATE_DISABLED_MESSAGE) {
		return disabledTemplateError();
	}
	if (err.message === ALREADY_ADOPTED_MESSAGE) {
		return new McpError("VALIDATION", ALREADY_ADOPTED_REFUSAL, detail);
	}
	return err;
}

/**
 * Preview, then apply.
 *
 * Without `planHash`: write nothing, answer `{ applied: false, plan, planHash }`
 * (plus `previewExtra`). With it: rebuild the plan; a different hash is
 * `PLAN_STALE` carrying the fresh plan; a `noop` plan writes nothing;
 * otherwise `apply` runs and the answer is `{ applied: true, plan, result }`.
 * `apply` may throw `TemplateChangedError` when a check under the club lock
 * finds the plan out of date, which is the same `PLAN_STALE`.
 */
export async function planFlow<P extends { noop?: boolean }, R>(o: {
	tool: string;
	clubId: string;
	userId: string;
	planHash: string | undefined;
	build: () => Promise<P>;
	apply: (plan: P) => Promise<R>;
	previewExtra?: () => Promise<Record<string, unknown>>;
}) {
	const hashOf = (plan: P) =>
		planHash({
			tool: o.tool,
			clubId: o.clubId,
			userId: o.userId,
			plan,
		});
	const stale = (plan: P, partiallyApplied?: string[]) =>
		new McpError("PLAN_STALE", TEMPLATE_MANAGE_STALE_MESSAGE, {
			plan,
			planHash: hashOf(plan),
			...(partiallyApplied ? { partiallyApplied } : {}),
		});

	try {
		const plan = await o.build();
		const fresh = hashOf(plan);
		if (o.planHash === undefined) {
			return {
				applied: false,
				clubId: o.clubId,
				plan,
				planHash: fresh,
				...(o.previewExtra ? await o.previewExtra() : {}),
			};
		}
		if (fresh !== o.planHash) throw stale(plan);
		if (plan.noop) {
			return { applied: false, noop: true, clubId: o.clubId, plan };
		}
		try {
			const result = await o.apply(plan);
			return { applied: true, clubId: o.clubId, plan, result };
		} catch (err) {
			if (err instanceof TemplateChangedError) {
				throw stale(await o.build(), err.partiallyApplied);
			}
			throw err;
		}
	} catch (err) {
		throw mapLogicError(err);
	}
}
