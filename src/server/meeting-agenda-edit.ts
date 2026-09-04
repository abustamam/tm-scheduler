/**
 * Server fns for per-meeting agenda editing.
 *
 * Exports ONLY `createServerFn`s and types — a top-level db-touching export
 * here would drag `#/db` → `pg` → `Buffer` into the client bundle and
 * white-screen the page (`server-modules.guard.test.ts` enforces this).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	MAX_BEAT_MINUTES,
	MAX_ROLE_REPEAT_SLOTS,
	MAX_TEMPLATE_DETAIL_CHARS,
	MAX_TEMPLATE_LABEL_CHARS,
} from "#/lib/meeting-template-limits";
import type {
	AgendaDraft,
	AgendaDraftRole,
	AgendaDraftRow,
	ReleasedHolder,
} from "./meeting-agenda-edit-logic";
import {
	addAgendaRole,
	addAgendaRow,
	loadAgendaDraft,
	moveAgendaRow,
	planRoleRemoval,
	removeAgendaRole,
	removeAgendaRow,
	updateAgendaRow,
} from "./meeting-agenda-edit-logic";
import { requireMeetingTemplateEditor } from "./meeting-templates-logic";

export type { AgendaDraft, AgendaDraftRow, AgendaDraftRole, ReleasedHolder };

const meetingInput = z.object({ meetingId: z.string().uuid() });

/**
 * `minutes`'/the marks' beat-timing range, by patch field — for
 * `fallbackMessage` below. Keyed on the field name because that is all a
 * zod issue's `path` gives us to work with.
 */
const RANGE_FIELD_LABELS: Record<string, string> = {
	minutes: "Minutes",
	markGreen: "Green mark",
	markYellow: "Yellow mark",
	markRed: "Red mark",
};

/** The patch's free-text fields' length bounds, by field — for
 *  `fallbackMessage` below. Twice each real cap; see the doc comment on
 *  `patchInput`. */
const LENGTH_FIELD_CAPS: Record<string, { label: string; max: number }> = {
	label: { label: "label", max: MAX_TEMPLATE_LABEL_CHARS * 2 },
	detail: { label: "note", max: MAX_TEMPLATE_DETAIL_CHARS * 2 },
	roleKey: { label: "role reference", max: MAX_TEMPLATE_LABEL_CHARS * 2 },
	repeatsRoleKey: {
		label: "repeat-role reference",
		max: MAX_TEMPLATE_LABEL_CHARS * 2,
	},
	// `roleAddInput`'s and `roleKeyInput`'s own strings, which were unbounded
	// entirely until they were routed through `parse()` below.
	name: { label: "role name", max: MAX_TEMPLATE_LABEL_CHARS * 2 },
};

/**
 * A message for a zod issue that was never given one of its own.
 *
 * None of `patchInput`'s eight bounds below carry a message argument, on
 * purpose: `meeting-templates-authz.guard.test.ts` greps
 * `meeting-agenda-edit.ts` for their literal, message-less shape — a bare
 * `.max(MAX_TEMPLATE…)` for the four text fields, a bare `.int()` then a
 * bare `.max(MAX_BEAT_MINUTES)` for `minutes` and the three marks — to prove
 * the bound itself cannot be silently dropped, and a message argument is
 * part of that literal text (Biome also wraps a `.max(N, "…")` call onto
 * multiple lines once the line is long enough, which breaks the same grep
 * from the formatting side). This is where the sentence those checks can't
 * carry themselves actually comes from, resolved from the issue's own field
 * and failure kind instead of from the schema. `minutes`' range wording
 * matches `updateAgendaRow`'s own check (`meeting-agenda-edit-logic
 * .ts:817`) exactly, since a value that trips one can trip the other — an
 * officer must see the same sentence regardless of which layer catches it.
 * The marks have no logic-layer counterpart to match, so they get their own
 * field name instead.
 */
function fallbackMessage(issue: {
	code: string;
	path: PropertyKey[];
}): string | undefined {
	const field = issue.path.at(-1);
	if (typeof field !== "string") return undefined;
	const rangeLabel = RANGE_FIELD_LABELS[field];
	if (rangeLabel) {
		if (issue.code === "too_big" || issue.code === "too_small") {
			return `${rangeLabel} must be between 0 and ${MAX_BEAT_MINUTES}.`;
		}
		if (issue.code === "invalid_type") {
			// "whole" only for `minutes`, the one field of the four that still
			// carries `.int()` — the three marks back `real()` columns and 2.5 is a
			// value this app itself stores, so telling an officer it must be whole
			// would be describing a rule that is no longer there (#679).
			return field === "minutes"
				? `${rangeLabel} must be a whole number.`
				: `${rangeLabel} must be a number.`;
		}
		return undefined;
	}
	const lengthCap = LENGTH_FIELD_CAPS[field];
	if (lengthCap && issue.code === "too_big") {
		return `Keep the ${lengthCap.label} under ${lengthCap.max} characters.`;
	}
	// `roleAddInput.defaultCount`. Its own range, not `MAX_BEAT_MINUTES`' —
	// it is a slot count, and it carried a bound with no message behind a bare
	// `.parse()`, so tripping it put the whole `ZodError` JSON in the toast.
	if (field === "defaultCount") {
		if (issue.code === "too_big" || issue.code === "too_small") {
			return `A role can have between 0 and ${MAX_ROLE_REPEAT_SLOTS} places.`;
		}
		if (issue.code === "invalid_type") {
			return "Places must be a whole number.";
		}
	}
	return undefined;
}

/**
 * Parse, but fail with a sentence a club officer can read.
 *
 * A raw `ZodError` reaching the client is not the human-readable rejection a
 * bound's own message promises: `ZodError.message` is
 * `JSON.stringify(issues, null, 2)` — the WHOLE issues array, `code` and
 * `path` included, not just the one issue's `message` text — so even a
 * bounded field with a friendly message still surfaces as a JSON dump
 * through a bare `.parse()`. This is what actually extracts it; see the same
 * shape in `action-items.ts` (#522). `fallbackMessage` above supplies the
 * message none of `patchInput`'s bounds can carry themselves.
 */
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
	const result = schema.safeParse(input);
	if (result.success) return result.data;
	const issue = result.error.issues[0];
	throw new Error(
		(issue && fallbackMessage(issue)) ??
			issue?.message ??
			"That change could not be saved.",
	);
}

/** This meeting's editable agenda. Officer-gated: the same authority that may
 *  change a meeting's type may reshape its run of show. */
export const getAgendaDraft = createServerFn({ method: "GET" })
	.validator((input: unknown) => meetingInput.parse(input))
	.handler(async ({ data }): Promise<AgendaDraft | null> => {
		await requireMeetingTemplateEditor(data.meetingId);
		return loadAgendaDraft(data.meetingId);
	});

const addInput = z.object({
	meetingId: z.string().uuid(),
	afterRowId: z.string().uuid().nullable(),
	kind: z.enum(["section", "role", "event"]),
});
const rowInput = z.object({
	meetingId: z.string().uuid(),
	rowId: z.string().uuid(),
});
/**
 * Every string here is bounded at TWICE its real cap, and every number at its
 * real one. Two different jobs, so two different shapes.
 *
 * The strings' true caps are counted in CODE POINTS (`assertWithin`, and
 * `capChars` at the renderer), which zod's `.max()` cannot express — it counts
 * UTF-16 units. But UTF-16 length brackets code points from above:
 * `codePoints <= length <= 2 * codePoints`. So `2 * cap` is the tightest bound
 * that can never reject something the real check would accept, which keeps the
 * friendly "too long (max N characters)" message as the one an officer sees,
 * while stopping a megabyte of text at the edge before it reaches a spread.
 * This is the edge bound, NOT a second copy of the cap — do not tighten it to
 * the cap itself, that would reject legal emoji labels with a zod error.
 *
 * The three marks were `z.number()` with no range at all — `assertMarks` only
 * checks all-three-or-none, never the values — so any number reached the row.
 * Bounded to the same `MAX_BEAT_MINUTES` as `minutes`, since a mark is a minute
 * offset within the beat it belongs to.
 *
 * They do NOT carry `.int()`, and the reason is worth stating because they did
 * until #679 on an argument that was simply wrong about the schema: the note
 * here said a float "reached an `integer` column and came back as a raw
 * Postgres 500". `mark_green/mark_yellow/mark_red` are `real()`. Fractional
 * marks are what this app stores — `EVALUATION_MARKS` is 2 / 2.5 / 3, so every
 * materialised evaluation beat holds a half minute, and a club's Table Topics
 * midpoint is fractional for a quarter of the windows it can state. `.int()`
 * therefore made a legal stored value unwritable through the only path that
 * writes one: the editor's mark inputs rejected 2.5, and Undo on a deleted
 * evaluation row replayed the stored 2.5 and failed validation AFTER
 * `addAgendaRow` had inserted the placeholder, so the officer lost the row.
 * `minutes` keeps `.int()` — that column really is an integer.
 *
 * None of the eight bounds below carries a message argument — see
 * `fallbackMessage` above, and `meeting-templates-authz.guard.test.ts`,
 * which pins that bare shape.
 */
const patchInput = rowInput.extend({
	// Require at least one key: an empty `{}` validates as a well-formed patch,
	// forks the meeting's template on its way in, and then 500s on drizzle's
	// "No values to set" — a confusing failure for what should be a no-op
	// request rejected up front.
	patch: z
		.object({
			label: z
				.string()
				.max(MAX_TEMPLATE_LABEL_CHARS * 2)
				.optional(),
			detail: z
				.string()
				.max(MAX_TEMPLATE_DETAIL_CHARS * 2)
				.nullable()
				.optional(),
			minutes: z.number().int().min(0).max(MAX_BEAT_MINUTES).optional(),
			roleKey: z
				.string()
				.max(MAX_TEMPLATE_LABEL_CHARS * 2)
				.nullable()
				.optional(),
			repeatsRoleKey: z
				.string()
				.max(MAX_TEMPLATE_LABEL_CHARS * 2)
				.nullable()
				.optional(),
			// FRACTIONAL, unlike `minutes` above. These three back `real()` columns
			// and the app's own constants are fractional — `EVALUATION_MARKS` is
			// 2 / 2.5 / 3, so every materialised evaluation beat already stores a
			// half minute, and a club's Table Topics midpoint is fractional for 25%
			// of the windows it can state. `.int()` sat on all three anyway (#679),
			// which made a half-minute mark unwritable through the only path that
			// writes them: the editor's own inputs rejected 2.5, and Undo on a
			// deleted evaluation row replayed the stored 2.5 and failed validation
			// AFTER `addAgendaRow` had already inserted the placeholder — so the
			// officer lost the row. The bound that matters is `MAX_BEAT_MINUTES`,
			// which is kept.
			markGreen: z.number().min(0).max(MAX_BEAT_MINUTES).nullable().optional(),
			markYellow: z.number().min(0).max(MAX_BEAT_MINUTES).nullable().optional(),
			markRed: z.number().min(0).max(MAX_BEAT_MINUTES).nullable().optional(),
			// LAST, after every bounded field. `meeting-templates-authz.guard
			// .test.ts` matches each bound with a `[\s\S]{0,120}` window between the
			// field name and its `.max(...)`; inserting between an existing field and
			// its bound could push one out of that window and fail a guard for a
			// reason unrelated to the change. A boolean has no bound of its own to
			// add, so the end is where it belongs.
			flex: z.boolean().optional(),
		})
		.refine((p) => Object.keys(p).length > 0, {
			message: "Patch must set at least one field.",
		}),
});
const moveInput = rowInput.extend({ direction: z.enum(["up", "down"]) });

/** Add a row to this meeting's agenda. Officer-gated, same as `getAgendaDraft`. */
export const addAgendaRowFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => addInput.parse(input))
	.handler(async ({ data }): Promise<AgendaDraftRow> => {
		await requireMeetingTemplateEditor(data.meetingId);
		return addAgendaRow(data);
	});

/** Edit a row's content. Officer-gated, same as `getAgendaDraft`. */
export const updateAgendaRowFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => parse(patchInput, input))
	.handler(async ({ data }): Promise<void> => {
		await requireMeetingTemplateEditor(data.meetingId);
		return updateAgendaRow(data);
	});

/** Remove a row from this meeting's agenda. Officer-gated, same as `getAgendaDraft`. */
export const removeAgendaRowFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => rowInput.parse(input))
	.handler(async ({ data }): Promise<void> => {
		await requireMeetingTemplateEditor(data.meetingId);
		return removeAgendaRow(data);
	});

/** Reorder a row by one position. Officer-gated, same as `getAgendaDraft`. */
export const moveAgendaRowFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => moveInput.parse(input))
	.handler(async ({ data }): Promise<void> => {
		await requireMeetingTemplateEditor(data.meetingId);
		return moveAgendaRow(data);
	});

/**
 * The role mutators' input. Same two rules as `patchInput`: every string
 * bounded at TWICE its real cap (the tightest bound that can never reject a
 * value the code-point check would accept — see that schema's docblock), every
 * number at its real one, and no message argument on any of them, because
 * `fallbackMessage` supplies it and `meeting-templates-authz.guard.test.ts`
 * pins the bare shape.
 *
 * `name` and `roleKey` were unbounded entirely while `defaultCount` between
 * them carried both a bound AND a comment stating the rule — an unbounded
 * string feeding a code-point spread is #519's shape, and the asymmetry was
 * the tell.
 */
const roleAddInput = z.object({
	meetingId: z.string().uuid(),
	name: z
		.string()
		.min(1)
		.max(MAX_TEMPLATE_LABEL_CHARS * 2),
	category: z.enum(["leadership", "speaker", "evaluator", "functionary"]),
	// Bounded here too, not just in `addAgendaRole`'s own check: an unbounded
	// validator lets an over-cap value reach the handler and surface as a
	// 500 (an unhandled throw) where a 400 (a validation rejection) belongs.
	// The inner check in `addAgendaRole` stays — this is the fast, honest
	// rejection at the edge, not a replacement for it.
	defaultCount: z.number().int().min(0).max(MAX_ROLE_REPEAT_SLOTS),
	isSpeakerRole: z.boolean(),
});
const roleKeyInput = z.object({
	meetingId: z.string().uuid(),
	roleKey: z
		.string()
		.min(1)
		.max(MAX_TEMPLATE_LABEL_CHARS * 2),
});

/** Add a role to this meeting's agenda. Officer-gated, same as `getAgendaDraft`. */
export const addAgendaRoleFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => parse(roleAddInput, input))
	.handler(async ({ data }): Promise<AgendaDraftRole> => {
		await requireMeetingTemplateEditor(data.meetingId);
		return addAgendaRole(data);
	});

/** Who removing this role would release, without removing anything.
 *  Officer-gated, same as `getAgendaDraft`. */
export const planRoleRemovalFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => parse(roleKeyInput, input))
	.handler(async ({ data }): Promise<ReleasedHolder[]> => {
		await requireMeetingTemplateEditor(data.meetingId);
		return planRoleRemoval(data);
	});

/** Remove a role from this meeting's agenda. Officer-gated, same as
 *  `getAgendaDraft`. Attributes the removal to the calling officer's own
 *  membership, for `activity_log`. */
export const removeAgendaRoleFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => parse(roleKeyInput, input))
	.handler(async ({ data }): Promise<ReleasedHolder[]> => {
		const { membership } = await requireMeetingTemplateEditor(data.meetingId);
		return removeAgendaRole({ ...data, actorMemberId: membership.id });
	});
