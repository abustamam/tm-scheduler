/**
 * `edit_agenda` — add, remove, move and retime one meeting's agenda rows (#966).
 *
 * The request that motivated it: "THR starts the program at 12:15; open with
 * 15 minutes of Introductions." The agenda editor could already do that by
 * hand; nothing on the connector could touch a row.
 *
 * ## Preview, then apply, in the conversation
 *
 * A call WITHOUT `planHash` writes nothing at all — not even the meeting's own
 * agenda copy the editor's page load creates. It reads through
 * `readAgendaSnapshot`, which computes a never-edited meeting's standard
 * agenda in memory (`std:<n>` row ids), and returns the plan: every stored
 * row before and after, with its new start time, stored minutes and note, and
 * the projected end against the booked slot, plus a `planHash`. The SAME call
 * with that hash applies it. No confirm page: `mcp-plan.ts` states the rule (a
 * page when the write is hard to see or hard to undo), and a run sheet is
 * neither.
 *
 * The apply locks the meeting row, re-plans from what is stored now and
 * refuses with `PLAN_STALE` (carrying the fresh plan) when the hash no longer
 * matches. The meeting row, not the club advisory lock (`lock.ts`): every
 * agenda write — the browser editor's included — takes that row `FOR UPDATE`
 * in `ensureAgendaDraft` before touching a row, so it is the lock that
 * actually excludes them. The club lock excludes only other MCP applies, and
 * it belongs to the pending-plan skeleton (`mcp-pending-lifecycle.guard.test.ts`).
 *
 * Only then does it write, and only through the editor's own functions: it
 * stores a never-edited meeting's agenda (`materialiseAgendaForMeeting`) or
 * forks a shared one (`ensureAgendaDraft`), maps the previewed ids onto the
 * stored rows by position with an identity check (`mapPreviewedRows`), and
 * runs `addAgendaRow` / `updateAgendaRow` / `removeAgendaRow` /
 * `placeAgendaRow`, each handed this transaction so the batch commits whole or
 * not at all.
 *
 * ## Running long is a warning, not a refusal
 *
 * The maintainer's call (2026-09-26): the plan says how far past its slot the
 * agenda would run and the edit is still allowed. The flex row (Table Topics)
 * absorbs what it can first, exactly as it does on the printed agenda.
 *
 * ## Refusals
 *
 * A completed or cancelled meeting is refused (`LOCKED`), with the editor's
 * own rule and sentences (`agendaEditable`). A batch with an illegal operation
 * is refused as `VALIDATION` naming the operation's index, before anything is
 * written — except on an apply, where the preview already accepted the batch,
 * so an operation that no longer fits means the agenda moved: `PLAN_STALE`.
 * Authorization is the meeting's own club (`authorizeTokenForMeeting`), the
 * same officer rule every connector tool uses.
 */
import { z } from "zod";
import { db } from "#/db";
import {
	type AgendaEditOp,
	type AgendaEditStep,
	applyAgendaEdits,
	mapPreviewedRows,
	newRowId,
} from "#/lib/agenda-edit-ops";
import { type AgendaRunSheet, agendaRunSheet } from "#/lib/agenda-run-sheet";
import { planHash } from "#/lib/mcp-plan";
import {
	isMeetingLocked,
	MEETING_LOCKED_MESSAGE,
} from "#/lib/meeting-lifecycle";
import {
	MAX_BEAT_MINUTES,
	MAX_TEMPLATE_BEATS,
	MAX_TEMPLATE_DETAIL_CHARS,
	MAX_TEMPLATE_LABEL_CHARS,
} from "#/lib/meeting-template-limits";
import {
	AGENDA_CANCELLED_MESSAGE,
	AGENDA_CONCURRENT_EDIT_MESSAGE,
	AGENDA_DEADLOCK_MESSAGE,
	type AgendaDraftRow,
	type AgendaSnapshot,
	addAgendaRow,
	agendaEditable,
	ensureAgendaDraft,
	materialiseAgendaForMeeting,
	placeAgendaRow,
	ROW_NOT_IN_MEETING_MESSAGE,
	readAgendaSnapshot,
	removeAgendaRow,
	updateAgendaRow,
} from "#/server/meeting-agenda-edit-logic";
import type { DbOrTx } from "#/server/meeting-templates-logic";
import { isDeadlock } from "#/server/pg-errors";
import { authorizeTokenForMeeting } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

export const EDIT_AGENDA_TOOL = "edit_agenda";

/** Operations per call. A whole agenda is at most 200 rows; a batch that
 *  touches more than this is a rebuild, which is what templates are for. */
export const MAX_AGENDA_EDIT_OPS = 50;

/** What an apply says when the agenda moved under a plan the caller holds. */
export const AGENDA_MOVED_MESSAGE =
	"This meeting's agenda changed since that preview. Re-read get_agenda and preview again.";

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
/** A stored row's UUID, or `std:<n>` for a never-edited meeting's derived row. */
const rowId = z.union([z.string().uuid(), z.string().regex(/^std:\d{1,3}$/)]);
const placement = {
	before: rowId.optional().describe("Place it immediately before this row id."),
	after: rowId.optional().describe("Place it immediately after this row id."),
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
	z.object({ op: z.literal("remove"), rowId }).strict(),
	z.object({ op: z.literal("move"), rowId, ...placement }).strict(),
	z
		.object({
			op: z.literal("set"),
			rowId,
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

/** One row at one moment, as the plan shows it. `minutes` is what the clock
 *  gives it; `storedMinutes` and `detail` are what the row holds — the values
 *  an apply writes, so they are in the plan and in its hash (#966 review). */
type PlanRowState = {
	position: number;
	start: string | null;
	minutes: number;
	storedMinutes: number;
	detail: string | null;
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
		| "noted"
		| "retimed"
	)[];
	before: PlanRowState | null;
	after: PlanRowState | null;
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
	/** Whether the plan's row ids are stored or derived (`std:<n>`). */
	idSource: AgendaSnapshot["idSource"];
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

/**
 * The meeting's agenda, refused unless it is editable — the ONE read the
 * preview and the apply share. `lock` takes the meeting row `FOR UPDATE`, so
 * pass it only on a transaction. The rule and both sentences are the editor's
 * (`agendaEditable`), so the two surfaces cannot disagree about which meetings
 * take an edit.
 */
async function loadEditable(
	conn: DbOrTx,
	meetingId: string,
	lock: boolean,
): Promise<AgendaSnapshot> {
	const snap = await readAgendaSnapshot(meetingId, conn, { forUpdate: lock });
	if (!snap) throw new McpError("NOT_FOUND", "Meeting not found.");
	if (!agendaEditable(snap.status)) {
		throw new McpError(
			"LOCKED",
			isMeetingLocked(snap.status)
				? MEETING_LOCKED_MESSAGE
				: AGENDA_CANCELLED_MESSAGE,
		);
	}
	return snap;
}

/**
 * Plan `ops` against `snap`. Throws `VALIDATION` for an illegal batch. Pure
 * over the snapshot, so the preview and the apply's re-plan cannot differ
 * except through what is stored.
 */
function buildPlan(
	snap: AgendaSnapshot,
	ops: AgendaEditOp[],
): { plan: EditPlan; steps: AgendaEditStep[] } {
	const result = applyAgendaEdits(snap.rows, ops, (fields) => ({
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
	const beforeSheet = agendaRunSheet(snap);
	const afterSheet = agendaRunSheet(snap, afterRows);

	const moved = new Set(
		ops.flatMap((op) => (op.op === "move" ? [op.rowId] : [])),
	);
	const state = (
		r: AgendaRunSheet["rows"][number],
		position: number,
	): PlanRowState => ({
		position,
		start: r.start,
		minutes: r.scheduledMinutes,
		storedMinutes: r.minutes,
		detail: r.detail,
	});
	const beforeById = new Map(
		beforeSheet.rows.map((r, position) => [r.rowId, state(r, position)]),
	);
	const beforeLabel = new Map(beforeSheet.rows.map((r) => [r.rowId, r.label]));
	const afterIds = new Set(afterSheet.rows.map((r) => r.rowId));

	const rows: PlanRow[] = [];
	for (const [position, a] of afterSheet.rows.entries()) {
		const b = beforeById.get(a.rowId);
		const after = state(a, position);
		const isNew = result.added.has(a.rowId);
		const changes: PlanRow["changes"] = [];
		if (isNew) changes.push("added");
		if (moved.has(a.rowId)) changes.push("moved");
		if (b) {
			if (beforeLabel.get(a.rowId) !== a.label) changes.push("relabelled");
			// Either number: the clock's (a flex row, a repeat) OR the stored one
			// a `set` writes — which on the flex row or a repeat with no slots is
			// invisible to the clock, and still a write.
			if (
				b.minutes !== after.minutes ||
				b.storedMinutes !== after.storedMinutes
			) {
				changes.push("resized");
			}
			if (b.detail !== after.detail) changes.push("noted");
			if (b.start !== after.start) changes.push("retimed");
		}
		rows.push({
			rowId: isNew ? null : a.rowId,
			label: a.label,
			kind: a.kind,
			changes,
			before: b ?? null,
			after,
		});
	}
	for (const [position, b] of beforeSheet.rows.entries()) {
		if (afterIds.has(b.rowId)) continue;
		rows.push({
			rowId: b.rowId,
			label: b.label,
			kind: b.kind,
			changes: ["removed"],
			before: state(b, position),
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
			meetingId: snap.meetingId,
			idSource: snap.idSource,
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
	const count = (...cs: PlanRow["changes"][number][]) =>
		plan.rows.filter((r) => cs.some((c) => r.changes.includes(c))).length;
	const parts = [
		["added", count("added")],
		["removed", count("removed")],
		["moved", count("moved")],
		["edited", count("relabelled", "resized", "noted")],
	]
		.filter(([, n]) => (n as number) > 0)
		.map(([what, n]) => `${n} ${what}`);
	const end =
		plan.before.endsAt === plan.after.endsAt
			? `still ends ${plan.after.endsAt}`
			: `ends ${plan.after.endsAt} (was ${plan.before.endsAt})`;
	return `${parts.join(", ") || "No row changes"}; ${end}; slot ends ${plan.after.slotEndsAt}.`;
}

/**
 * An error thrown inside the apply, as the caller should see it.
 *
 * Every refusal the editor's functions raise as a bare `Error` is compared by
 * IDENTITY with its exported constant (`mcp/errors.ts`'s one sanctioned
 * exception), never by text. What each means here: the agenda moved under a
 * plan the caller holds, so preview again. A Postgres deadlock raised by any
 * statement in the batch means the same. `copyTemplateForMeeting`'s two
 * refusals are not in this list because neither is reachable from here: "too
 * large to copy" is checked before any write (see the apply), and "no longer
 * exists" cannot happen while the meeting row is locked, because
 * `meetings.template_id` is `ON DELETE RESTRICT`.
 */
function applyError(err: unknown): unknown {
	if (err instanceof McpError) return err;
	const moved = [
		AGENDA_DEADLOCK_MESSAGE,
		AGENDA_CONCURRENT_EDIT_MESSAGE,
		ROW_NOT_IN_MEETING_MESSAGE,
	];
	if (
		isDeadlock(err) ||
		(err instanceof Error && moved.includes(err.message))
	) {
		return new McpError("PLAN_STALE", AGENDA_MOVED_MESSAGE);
	}
	return err;
}

export const editAgendaTool: McpToolDefinition = {
	name: EDIT_AGENDA_TOOL,
	config: {
		title: "Edit agenda rows",
		description:
			"Add, remove, move, rename and retime rows on one meeting's agenda " +
			"(the run sheet get_agenda returns). Without planHash this writes " +
			"nothing at all: it returns a plan with every row's start time before " +
			"and after, the projected end against the booked slot, any warnings, " +
			"and a planHash. Show the plan to the user; call again with the same " +
			"input plus that planHash to apply it. All operations apply or none " +
			"do. Running past the slot is a warning, not a refusal; the flex row " +
			"(Table Topics) stretches or shrinks first. It cannot change the " +
			"meeting's scheduled time, and a completed or cancelled meeting is " +
			"refused.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const ops = args.operations as AgendaEditOp[];
		const meetingId = args.meetingId;
		const { club, user } = await authorizeTokenForMeeting(ctx, meetingId);
		const hashOf = (plan: EditPlan) =>
			planHash({
				tool: EDIT_AGENDA_TOOL,
				clubId: club.clubId,
				userId: user.id,
				plan,
			});

		if (args.planHash === undefined) {
			const snap = await loadEditable(db, meetingId, false);
			const { plan } = buildPlan(snap, ops);
			return {
				applied: false,
				meetingId,
				clubId: club.clubId,
				summary: summarize(plan),
				plan,
				planHash: hashOf(plan),
			};
		}

		const expected = args.planHash;
		let applied: { plan: EditPlan; runSheet: AgendaRunSheet };
		try {
			applied = await db.transaction(async (tx) => {
				// The meeting row first — see the header for why this lock and not
				// the club's.
				const snap = await loadEditable(tx, meetingId, true);
				let planned: ReturnType<typeof buildPlan>;
				try {
					planned = buildPlan(snap, ops);
				} catch (err) {
					// The preview accepted this batch, so an operation that no longer
					// fits (a row it names is gone) means the agenda moved.
					if (err instanceof McpError && err.code === "VALIDATION") {
						throw new McpError("PLAN_STALE", AGENDA_MOVED_MESSAGE, {
							reason: err.message,
						});
					}
					throw err;
				}
				const { plan, steps } = planned;
				const freshHash = hashOf(plan);
				if (freshHash !== expected) {
					throw new McpError(
						"PLAN_STALE",
						"This meeting's agenda changed since that preview. Show the user the fresh plan and ask again.",
						{ plan, planHash: freshHash, summary: summarize(plan) },
					);
				}

				// Store the agenda first when it is not the meeting's own yet: a
				// never-edited meeting gets its copy of the standard agenda, and one
				// on a shared template gets a fork. Checked BEFORE either write, so
				// a fork `copyTemplateForMeeting` would refuse writes nothing.
				const needsFork = snap.idSource === "stored" && !snap.privateCopy;
				if (needsFork && snap.rows.length > MAX_TEMPLATE_BEATS) {
					throw new McpError(
						"VALIDATION",
						`This meeting's agenda is too large to copy (${MAX_TEMPLATE_BEATS} rows maximum).`,
					);
				}
				if (snap.idSource === "derived") {
					await materialiseAgendaForMeeting(tx, meetingId);
				}
				await ensureAgendaDraft(tx, meetingId);

				// Map the previewed ids onto the rows now stored. Identity is
				// checked per position — see `mapPreviewedRows`.
				let live = new Map(snap.rows.map((r) => [r.id, r.id]));
				if (snap.idSource === "derived" || needsFork) {
					const stored = await readAgendaSnapshot(meetingId, tx);
					const mapped = stored && mapPreviewedRows(snap.rows, stored.rows);
					if (!mapped) {
						throw new McpError("PLAN_STALE", AGENDA_MOVED_MESSAGE);
					}
					live = mapped;
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
					if (op.op === "add") {
						const created = await addAgendaRow(
							{ meetingId, afterRowId: null, kind: op.kind ?? "event" },
							tx,
						);
						live.set(newRowId(step.opIndex), created.id);
						// `updateAgendaRow` drops undefined fields itself.
						await updateAgendaRow(
							{
								meetingId,
								rowId: created.id,
								patch: {
									label: op.label,
									minutes: op.minutes,
									detail: op.detail,
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
									label: op.label,
									minutes: op.minutes,
									detail: op.detail,
								},
							},
							tx,
						);
					}
				}

				const after = await readAgendaSnapshot(meetingId, tx);
				if (!after) throw new McpError("NOT_FOUND", "Meeting not found.");
				return { plan, runSheet: agendaRunSheet(after) };
			});
		} catch (err) {
			throw applyError(err);
		}

		return {
			applied: true,
			meetingId,
			clubId: club.clubId,
			summary: summarize(applied.plan),
			plan: applied.plan,
			// Read back from what is now stored, so a caller can check the result
			// against the plan it was shown.
			runSheet: applied.runSheet,
		};
	},
};
