/**
 * `edit_agenda` — add, remove, move and retime one meeting's agenda rows (#966).
 *
 * The request that motivated it: "THR starts the program at 12:15; open with
 * 15 minutes of Introductions." The agenda editor could already do that by
 * hand; nothing on the connector could touch a row.
 *
 * ## Preview, then apply, in the conversation
 *
 * A call WITHOUT `planHash` writes nothing. It returns the plan — every stored
 * row before and after, with its new start time, and the projected end against
 * the booked slot — and a `planHash`. The SAME call with that hash applies it.
 * No confirm page: `mcp-plan.ts` states the rule (a page when the write is hard
 * to see or hard to undo), and a run sheet is neither — the plan IS the whole
 * of what changes, and the editor undoes any of it in a click.
 *
 * The apply locks the meeting row, re-plans from what is stored now and refuses
 * with `PLAN_STALE` (carrying the fresh plan) when the hash no longer matches.
 * The meeting row, not the club advisory lock (`lock.ts`): every agenda write
 * — the browser editor's included — takes that row `FOR UPDATE` in
 * `ensureAgendaDraft` before touching a row, so it is the lock that actually
 * excludes them. The club lock excludes only other MCP applies, and it belongs
 * to the pending-plan skeleton (`mcp-pending-lifecycle.guard.test.ts`). Only then does it write, and only through the
 * editor's own mutators (`addAgendaRow`, `updateAgendaRow`, `removeAgendaRow`,
 * `placeAgendaRow`), each handed this transaction so the batch commits whole
 * or not at all.
 *
 * ## Running long is a warning, not a refusal
 *
 * The maintainer's call (2026-09-26): the plan says how far past its slot the
 * agenda would run and the edit is still allowed. The flex row (Table Topics)
 * absorbs what it can first, exactly as it does on the printed agenda.
 *
 * ## Refusals
 *
 * A completed or cancelled meeting is refused (`LOCKED`), as in the editor. A
 * batch with an illegal operation is refused as `VALIDATION` naming the
 * operation's index, before anything is written. Authorization is the
 * meeting's own club (`authorizeTokenForMeeting`), the same officer rule every
 * connector tool uses.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings } from "#/db/schema";
import {
	type AgendaEditOp,
	type AgendaEditStep,
	applyAgendaEdits,
	newRowId,
} from "#/lib/agenda-edit-ops";
import { planHash } from "#/lib/mcp-plan";
import {
	isMeetingLocked,
	MEETING_LOCKED_MESSAGE,
} from "#/lib/meeting-lifecycle";
import {
	MAX_BEAT_MINUTES,
	MAX_TEMPLATE_DETAIL_CHARS,
	MAX_TEMPLATE_LABEL_CHARS,
} from "#/lib/meeting-template-limits";
import {
	type AgendaDraft,
	type AgendaDraftRow,
	type AgendaRunSheet,
	addAgendaRow,
	agendaRunSheet,
	ensureAgendaDraft,
	loadAgendaDraft,
	placeAgendaRow,
	removeAgendaRow,
	updateAgendaRow,
} from "#/server/meeting-agenda-edit-logic";
import { authorizeTokenForMeeting } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

export const EDIT_AGENDA_TOOL = "edit_agenda";

/** Operations per call. A whole agenda is at most 200 rows; a batch that
 *  touches more than this is a rebuild, which is what templates are for. */
export const MAX_AGENDA_EDIT_OPS = 50;

/** Said for a cancelled meeting. The locked sentence is the shared export. */
export const CANCELLED_AGENDA_MESSAGE =
	"A cancelled meeting's agenda cannot be edited.";

// Strings are bounded at twice their real cap, which is counted in code points
// by `applyAgendaEdits` — the same edge-bound rule `meeting-agenda-edit.ts`
// states for the editor's own inputs.
const label = z
	.string()
	.min(1)
	.max(MAX_TEMPLATE_LABEL_CHARS * 2);
const detail = z
	.string()
	.max(MAX_TEMPLATE_DETAIL_CHARS * 2)
	.nullable();
const minutes = z.number().int().min(0).max(MAX_BEAT_MINUTES);
const placement = {
	before: z
		.string()
		.uuid()
		.optional()
		.describe("Place it immediately before this row id."),
	after: z
		.string()
		.uuid()
		.optional()
		.describe("Place it immediately after this row id."),
	at: z
		.enum(["start", "end"])
		.optional()
		.describe("Place it first or last. Omit all three for last."),
};

const opSchema = z.discriminatedUnion("op", [
	z
		.object({
			op: z.literal("add"),
			label,
			minutes,
			kind: z
				.enum(["event", "section"])
				.optional()
				.describe(
					"`event` (default) is a timed item; `section` is a heading band.",
				),
			detail: detail.optional(),
			...placement,
		})
		.strict(),
	z.object({ op: z.literal("remove"), rowId: z.string().uuid() }).strict(),
	z
		.object({ op: z.literal("move"), rowId: z.string().uuid(), ...placement })
		.strict(),
	z
		.object({
			op: z.literal("set"),
			rowId: z.string().uuid(),
			label: label.optional(),
			minutes: minutes.optional(),
			detail: detail.optional(),
		})
		.strict(),
]);

const inputSchema = {
	meetingId: z.string().uuid(),
	operations: z
		.array(opSchema)
		.min(1)
		.max(MAX_AGENDA_EDIT_OPS)
		.describe(
			"Applied in order, all or none. {op:'add', label, minutes, kind?, " +
				"detail?, before?|after?|at?}, {op:'remove', rowId}, {op:'move', " +
				"rowId, before?|after?|at?}, {op:'set', rowId, label?, minutes?, " +
				"detail?}. Row ids come from get_agenda's runSheet. A row added in " +
				"this call cannot be named by a later operation.",
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

/** One stored row's before and after, as the plan shows it. */
type PlanRow = {
	/** Null for a row this batch adds. */
	rowId: string | null;
	label: string;
	kind: AgendaDraftRow["kind"];
	/** What changes about it. Empty for an untouched row whose time holds. */
	changes: (
		| "added"
		| "removed"
		| "moved"
		| "relabelled"
		| "resized"
		| "retimed"
	)[];
	before: { position: number; start: string | null; minutes: number } | null;
	after: { position: number; start: string | null; minutes: number } | null;
};

type PlanTotals = Pick<
	AgendaRunSheet,
	| "startsAt"
	| "endsAt"
	| "slotMinutes"
	| "slotEndsAt"
	| "totalMinutes"
	| "overByMinutes"
>;

type EditPlan = {
	meetingId: string;
	operations: AgendaEditOp[];
	rows: PlanRow[];
	before: PlanTotals;
	after: PlanTotals;
	warnings: string[];
};

function totals(sheet: AgendaRunSheet): PlanTotals {
	return {
		startsAt: sheet.startsAt,
		endsAt: sheet.endsAt,
		slotMinutes: sheet.slotMinutes,
		slotEndsAt: sheet.slotEndsAt,
		totalMinutes: sheet.totalMinutes,
		overByMinutes: sheet.overByMinutes,
	};
}

function refuseUneditable(status: string): void {
	if (isMeetingLocked(status)) {
		throw new McpError("LOCKED", MEETING_LOCKED_MESSAGE);
	}
	if (status === "cancelled") {
		throw new McpError("LOCKED", CANCELLED_AGENDA_MESSAGE);
	}
}

/**
 * Plan `ops` against `draft`. Throws `VALIDATION` for an illegal batch. Pure
 * over the draft, so the preview and the apply's re-plan cannot differ except
 * through what is stored.
 */
function buildPlan(
	meetingId: string,
	draft: AgendaDraft,
	ops: AgendaEditOp[],
): { plan: EditPlan; steps: AgendaEditStep[] } {
	const result = applyAgendaEdits(draft.rows, ops, (fields) => ({
		...fields,
		sortOrder: 0,
		roleKey: null,
		repeatsRoleKey: null,
		flex: false,
		handoff: false,
		markGreen: null,
		markYellow: null,
		markRed: null,
		clubGoverned: false,
	}));
	if (!result.ok) {
		throw new McpError(
			"VALIDATION",
			`operations[${result.opIndex}]: ${result.message}`,
			{ opIndex: result.opIndex },
		);
	}
	// `agendaRunSheet` orders by `sortOrder`, so the simulated list's order has
	// to be written into it — the renumber the mutators do on the real rows.
	const afterRows = result.rows.map((r, i) => ({ ...r, sortOrder: i }));
	const beforeSheet = agendaRunSheet(draft);
	const afterSheet = agendaRunSheet(draft, afterRows);

	const moved = new Set(
		ops.flatMap((op) => (op.op === "move" ? [op.rowId] : [])),
	);
	const beforeById = new Map(
		beforeSheet.rows.map((r, position) => [r.rowId, { r, position }]),
	);
	const afterById = new Map(
		afterSheet.rows.map((r, position) => [r.rowId, { r, position }]),
	);

	const rows: PlanRow[] = [];
	for (const [position, a] of afterSheet.rows.entries()) {
		const b = beforeById.get(a.rowId);
		const isNew = result.added.has(a.rowId);
		const changes: PlanRow["changes"] = [];
		if (isNew) changes.push("added");
		if (moved.has(a.rowId)) changes.push("moved");
		if (b && b.r.label !== a.label) changes.push("relabelled");
		if (b && b.r.scheduledMinutes !== a.scheduledMinutes) {
			changes.push("resized");
		}
		if (b && b.r.start !== a.start) changes.push("retimed");
		rows.push({
			rowId: isNew ? null : a.rowId,
			label: a.label,
			kind: a.kind,
			changes,
			before: b
				? {
						position: b.position,
						start: b.r.start,
						minutes: b.r.scheduledMinutes,
					}
				: null,
			after: { position, start: a.start, minutes: a.scheduledMinutes },
		});
	}
	for (const [position, b] of beforeSheet.rows.entries()) {
		if (afterById.has(b.rowId)) continue;
		rows.push({
			rowId: b.rowId,
			label: b.label,
			kind: b.kind,
			changes: ["removed"],
			before: { position, start: b.start, minutes: b.scheduledMinutes },
			after: null,
		});
	}

	const warnings: string[] = [];
	if (afterSheet.overByMinutes > 0) {
		warnings.push(
			`The agenda would run ${afterSheet.overByMinutes} min past its ` +
				`${afterSheet.slotMinutes}-min slot: it ends ${afterSheet.endsAt} ` +
				`and the slot ends ${afterSheet.slotEndsAt}. This does not block the edit.`,
		);
	}

	return {
		plan: {
			meetingId,
			operations: ops,
			rows,
			before: totals(beforeSheet),
			after: totals(afterSheet),
			warnings,
		},
		steps: result.steps,
	};
}

/** A one-line account of the plan, for a caller to read out. */
function summarize(plan: EditPlan): string {
	const count = (c: PlanRow["changes"][number]) =>
		plan.rows.filter((r) => r.changes.includes(c)).length;
	const parts = [
		["added", count("added")],
		["removed", count("removed")],
		["moved", count("moved")],
		["edited", count("relabelled") + count("resized")],
	]
		.filter(([, n]) => (n as number) > 0)
		.map(([what, n]) => `${n} ${what}`);
	const end =
		plan.before.endsAt === plan.after.endsAt
			? `still ends ${plan.after.endsAt}`
			: `ends ${plan.after.endsAt} (was ${plan.before.endsAt})`;
	return `${parts.join(", ") || "No row changes"}; ${end}; slot ends ${plan.after.slotEndsAt}.`;
}

export const editAgendaTool: McpToolDefinition = {
	name: EDIT_AGENDA_TOOL,
	config: {
		title: "Edit agenda rows",
		description:
			"Add, remove, move, rename and retime rows on one meeting's agenda " +
			"(the run sheet get_agenda returns). Without planHash this writes " +
			"NOTHING: it returns a plan with every row's start time before and " +
			"after, the projected end against the booked slot, any warnings, and " +
			"a planHash. Show the plan to the user; call again with the same input " +
			"plus that planHash to apply it. All operations apply or none do. " +
			"Running past the slot is a warning, not a refusal; the flex row " +
			"(Table Topics) stretches or shrinks first. It cannot change the " +
			"meeting's scheduled time, and a completed or cancelled meeting is " +
			"refused.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const ops = args.operations as AgendaEditOp[];
		const { club, user } = await authorizeTokenForMeeting(ctx, args.meetingId);
		const hashOf = (plan: EditPlan) =>
			planHash({
				tool: EDIT_AGENDA_TOOL,
				clubId: club.clubId,
				userId: user.id,
				plan,
			});

		if (args.planHash === undefined) {
			// The same read the editor's page load does — including building the
			// meeting its own copy of the standard agenda on first read, which is
			// what gives a never-edited meeting row ids at all.
			// Status first, so a refused meeting is not given a copy on the way.
			const [meeting] = await db
				.select({ status: meetings.status })
				.from(meetings)
				.where(eq(meetings.id, args.meetingId))
				.limit(1);
			if (!meeting) throw new McpError("NOT_FOUND", "Meeting not found.");
			refuseUneditable(meeting.status);
			const draft = await loadAgendaDraft(args.meetingId);
			if (!draft) throw new McpError("NOT_FOUND", "Meeting not found.");
			const { plan } = buildPlan(args.meetingId, draft, ops);
			return {
				applied: false,
				meetingId: args.meetingId,
				clubId: club.clubId,
				summary: summarize(plan),
				plan,
				planHash: hashOf(plan),
			};
		}

		const expected = args.planHash;
		const applied = await db.transaction(async (tx) => {
			// The meeting row first: every editor write takes it `FOR UPDATE` in
			// `ensureAgendaDraft` before touching a row, so holding it here is what
			// keeps a browser edit from landing between this re-plan and the writes.
			const [meeting] = await tx
				.select({ status: meetings.status })
				.from(meetings)
				.where(eq(meetings.id, args.meetingId))
				.for("update")
				.limit(1);
			if (!meeting) throw new McpError("NOT_FOUND", "Meeting not found.");
			refuseUneditable(meeting.status);

			const draft = await loadAgendaDraft(args.meetingId, tx);
			if (!draft) throw new McpError("NOT_FOUND", "Meeting not found.");
			const { plan, steps } = buildPlan(args.meetingId, draft, ops);
			const freshHash = hashOf(plan);
			if (freshHash !== expected) {
				throw new McpError(
					"PLAN_STALE",
					"This meeting's agenda changed since that preview. Show the user the fresh plan and ask again.",
					{ plan, planHash: freshHash, summary: summarize(plan) },
				);
			}

			// A meeting still pointing at a SHARED template gets its private copy
			// on the first write. The copy keeps every row's order verbatim, so the
			// previewed ids map onto it by position — done once here rather than
			// per write, because the mutators' own translation is by `sortOrder`
			// and the first add in this batch renumbers every row after it.
			const { templateId } = await ensureAgendaDraft(tx, args.meetingId);
			const live = new Map(draft.rows.map((r) => [r.id, r.id]));
			if (templateId !== draft.templateId) {
				const forked = await loadAgendaDraft(args.meetingId, tx);
				if (!forked || forked.rows.length !== draft.rows.length) {
					throw new McpError(
						"PLAN_STALE",
						"This meeting's agenda changed while it was being copied. Preview again.",
					);
				}
				draft.rows.forEach((r, i) => {
					const copy = forked.rows[i];
					if (copy) live.set(r.id, copy.id);
				});
			}
			const liveId = (id: string): string => {
				const found = live.get(id);
				// Unreachable: the plan above resolved every id against these rows.
				if (!found) throw new Error(`Row ${id} did not resolve.`);
				return found;
			};

			for (const step of steps) {
				const op = ops[step.opIndex];
				if (!op) continue;
				const meetingId = args.meetingId;
				if (op.op === "add") {
					const created = await addAgendaRow(
						{ meetingId, afterRowId: null, kind: op.kind ?? "event" },
						tx,
					);
					live.set(newRowId(step.opIndex), created.id);
					await updateAgendaRow(
						{
							meetingId,
							rowId: created.id,
							patch: {
								label: op.label,
								minutes: op.minutes,
								...(op.detail === undefined ? {} : { detail: op.detail }),
							},
						},
						tx,
					);
					await placeAgendaRow(
						{ meetingId, rowId: created.id, index: step.index ?? 0 },
						tx,
					);
				} else if (op.op === "remove") {
					await removeAgendaRow({ meetingId, rowId: liveId(op.rowId) }, tx);
				} else if (op.op === "move") {
					await placeAgendaRow(
						{ meetingId, rowId: liveId(op.rowId), index: step.index ?? 0 },
						tx,
					);
				} else {
					await updateAgendaRow(
						{
							meetingId,
							rowId: liveId(op.rowId),
							patch: {
								...(op.label === undefined ? {} : { label: op.label }),
								...(op.minutes === undefined ? {} : { minutes: op.minutes }),
								...(op.detail === undefined ? {} : { detail: op.detail }),
							},
						},
						tx,
					);
				}
			}

			const after = await loadAgendaDraft(args.meetingId, tx);
			if (!after) throw new McpError("NOT_FOUND", "Meeting not found.");
			return { plan, runSheet: agendaRunSheet(after) };
		});

		return {
			applied: true,
			meetingId: args.meetingId,
			clubId: club.clubId,
			summary: summarize(applied.plan),
			plan: applied.plan,
			// Read back from what is now stored, so a caller can check the result
			// against the plan it was shown.
			runSheet: applied.runSheet,
		};
	},
};
