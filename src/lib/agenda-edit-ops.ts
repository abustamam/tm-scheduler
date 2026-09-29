/**
 * `edit_agenda`'s operations, applied to a list of rows IN MEMORY (#966).
 *
 * Pure, and in `lib/`, because it is the half of the tool that decides whether
 * a batch is legal and where every row ends up — the half worth testing
 * without a database. The tool runs it twice: once to build the plan a human
 * reads, and once inside the apply transaction to know where each write lands.
 * The database writes themselves go through the agenda editor's own mutators;
 * this module never touches a row.
 *
 * Operations apply in order, each against the result of the ones before it,
 * and the first illegal one refuses the WHOLE batch — a batch that half
 * applied would leave an agenda nobody asked for.
 *
 * A row this batch adds has no id yet, so a later operation cannot name it. The
 * add carries its own placement instead, which covers every case a caller
 * actually has: "open with Introductions" is one add at the start.
 */
import {
	MAX_TEMPLATE_BEATS,
	MAX_TEMPLATE_DETAIL_CHARS,
	MAX_TEMPLATE_LABEL_CHARS,
} from "./meeting-template-limits";

/** Where a row goes. Exactly one of the three; none means the end. */
export type AgendaEditPlacement = {
	before?: string;
	after?: string;
	at?: "start" | "end";
};

export type AgendaEditOp =
	| ({
			op: "add";
			label: string;
			minutes: number;
			kind?: "event" | "section";
			detail?: string | null;
	  } & AgendaEditPlacement)
	| { op: "remove"; rowId: string }
	| ({ op: "move"; rowId: string } & AgendaEditPlacement)
	| {
			op: "set";
			rowId: string;
			label?: string;
			minutes?: number;
			detail?: string | null;
	  };

/** The row fields the operations read and write. */
export type EditableRow = {
	id: string;
	kind: "section" | "role" | "event";
	label: string;
	detail: string | null;
	minutes: number;
};

/** What happened at one operation, for the apply to replay against the
 *  database: `index` is where the row it touched sits once that operation is
 *  done (null for a remove). */
export type AgendaEditStep = {
	opIndex: number;
	rowId: string;
	index: number | null;
};

export type AgendaEditResult<R extends EditableRow> =
	| {
			ok: true;
			rows: R[];
			steps: AgendaEditStep[];
			/** Ids of rows this batch added, keyed to the op that added them. */
			added: Map<string, number>;
	  }
	| { ok: false; opIndex: number; message: string };

/** The id a not-yet-stored row carries inside a plan. Never a UUID, so it
 *  cannot collide with a caller's row id (the tool's schema requires UUIDs). */
export function newRowId(opIndex: number): string {
	return `new:${opIndex}`;
}

/** Code-point length, the unit the agenda's own caps are stated in. */
function codePoints(value: string): number {
	return [...value].length;
}

function placementCount(p: AgendaEditPlacement): number {
	return (
		(p.before === undefined ? 0 : 1) +
		(p.after === undefined ? 0 : 1) +
		(p.at === undefined ? 0 : 1)
	);
}

/**
 * The index `row` should be inserted at in `rows` (which no longer contains
 * it), or an error sentence.
 */
function resolvePlacement(
	rows: EditableRow[],
	p: AgendaEditPlacement,
	selfId: string | null,
): number | string {
	if (placementCount(p) > 1) {
		return "Give at most one of before, after or at.";
	}
	const anchorId = p.before ?? p.after;
	if (anchorId !== undefined) {
		if (anchorId === selfId) return "A row cannot be placed next to itself.";
		const at = rows.findIndex((r) => r.id === anchorId);
		if (at === -1) return `There is no row ${anchorId} on this agenda.`;
		return p.before !== undefined ? at : at + 1;
	}
	return p.at === "start" ? 0 : rows.length;
}

function checkText(
	label: string | undefined,
	detail: string | null | undefined,
): string | null {
	if (label !== undefined) {
		if (label.trim() === "") return "A label cannot be empty.";
		if (codePoints(label) > MAX_TEMPLATE_LABEL_CHARS) {
			return `That label is too long (max ${MAX_TEMPLATE_LABEL_CHARS} characters).`;
		}
	}
	if (detail != null && codePoints(detail) > MAX_TEMPLATE_DETAIL_CHARS) {
		return `That note is too long (max ${MAX_TEMPLATE_DETAIL_CHARS} characters).`;
	}
	return null;
}

/**
 * Apply `ops` to `rows` (in stored order). `makeRow` builds the stored shape of
 * an added row from the fields the add names.
 */
export function applyAgendaEdits<R extends EditableRow>(
	rows: R[],
	ops: AgendaEditOp[],
	makeRow: (fields: EditableRow) => R,
): AgendaEditResult<R> {
	const out = [...rows];
	const steps: AgendaEditStep[] = [];
	const added = new Map<string, number>();
	const fail = (opIndex: number, message: string) =>
		({ ok: false, opIndex, message }) as const;

	for (const [opIndex, op] of ops.entries()) {
		if (op.op === "add") {
			const bad = checkText(op.label, op.detail);
			if (bad) return fail(opIndex, bad);
			if (out.length >= MAX_TEMPLATE_BEATS) {
				return fail(
					opIndex,
					`This agenda is too long (max ${MAX_TEMPLATE_BEATS} rows).`,
				);
			}
			const at = resolvePlacement(out, op, null);
			if (typeof at === "string") return fail(opIndex, at);
			const id = newRowId(opIndex);
			out.splice(
				at,
				0,
				makeRow({
					id,
					kind: op.kind ?? "event",
					label: op.label,
					detail: op.detail ?? null,
					minutes: op.minutes,
				}),
			);
			added.set(id, opIndex);
			steps.push({ opIndex, rowId: id, index: at });
			continue;
		}

		if (added.has(op.rowId)) {
			return fail(
				opIndex,
				"A row added in this batch cannot be named by a later operation; place it with the add itself.",
			);
		}
		const from = out.findIndex((r) => r.id === op.rowId);
		if (from === -1) {
			return fail(
				opIndex,
				`There is no row ${op.rowId} on this agenda (was it removed earlier in this batch?).`,
			);
		}

		if (op.op === "remove") {
			out.splice(from, 1);
			steps.push({ opIndex, rowId: op.rowId, index: null });
			continue;
		}

		if (op.op === "move") {
			const [row] = out.splice(from, 1);
			if (!row) return fail(opIndex, `There is no row ${op.rowId}.`);
			const at = resolvePlacement(out, op, op.rowId);
			if (typeof at === "string") return fail(opIndex, at);
			out.splice(at, 0, row);
			steps.push({ opIndex, rowId: op.rowId, index: at });
			continue;
		}

		// set
		if (
			op.label === undefined &&
			op.minutes === undefined &&
			op.detail === undefined
		) {
			return fail(
				opIndex,
				"A set names at least one of label, minutes, detail.",
			);
		}
		const bad = checkText(op.label, op.detail);
		if (bad) return fail(opIndex, bad);
		const row = out[from] as R;
		out[from] = {
			...row,
			...(op.label === undefined ? {} : { label: op.label }),
			...(op.minutes === undefined ? {} : { minutes: op.minutes }),
			...(op.detail === undefined ? {} : { detail: op.detail }),
		};
		steps.push({ opIndex, rowId: op.rowId, index: from });
	}

	return { ok: true, rows: out, steps, added };
}

/** The fields `mapPreviewedRows` checks a row's identity by. */
export type IdentityRow = {
	id: string;
	kind: EditableRow["kind"];
	label: string;
	roleKey: string | null;
};

/**
 * Map the rows a plan was built against onto the rows now stored, by
 * POSITION, verifying each pair is the same beat — or null when any is not.
 *
 * Needed when the apply had to store the agenda first: a never-edited
 * meeting's rows were derived in memory (`std:<n>`), and a meeting on a shared
 * template gets its own copy with new ids. Both keep the order verbatim, so
 * position is the mapping — but only while nothing moved in between. A
 * same-length change (two rows swapped, one renamed) keeps every position
 * occupied, so without the check the batch's operations would land on the
 * wrong rows and report success.
 *
 * Identity is the rule `translateRow` (`meeting-agenda-edit-logic.ts`) uses
 * for the same question: same `kind`, and the same label OR the same non-null
 * role key. Either half alone is too weak — `kind` repeats down the whole
 * agenda — and a null role key never counts as a match.
 */
export function mapPreviewedRows(
	previewed: IdentityRow[],
	stored: IdentityRow[],
): Map<string, string> | null {
	if (previewed.length !== stored.length) return null;
	const out = new Map<string, string>();
	for (const [i, before] of previewed.entries()) {
		const now = stored[i];
		if (!now) return null;
		const sameLabel = now.label === before.label;
		const sameRole = before.roleKey !== null && now.roleKey === before.roleKey;
		if (now.kind !== before.kind || !(sameLabel || sameRole)) return null;
		out.set(before.id, now.id);
	}
	return out;
}
