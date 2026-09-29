import { describe, expect, it } from "vitest";
import {
	type AgendaEditOp,
	applyAgendaEdits,
	type EditableRow,
	newRowId,
} from "./agenda-edit-ops";
import {
	MAX_TEMPLATE_BEATS,
	MAX_TEMPLATE_DETAIL_CHARS,
	MAX_TEMPLATE_LABEL_CHARS,
} from "./meeting-template-limits";

const row = (id: string, minutes = 5): EditableRow => ({
	id,
	kind: "event",
	label: id.toUpperCase(),
	detail: null,
	minutes,
});

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const base = () => [row(A), row(B), row(C)];
const run = (ops: AgendaEditOp[], rows = base()) =>
	applyAgendaEdits(rows, ops, (f) => f);
const ids = (r: ReturnType<typeof run>) => (r.ok ? r.rows.map((x) => x.id) : r);

describe("applyAgendaEdits (#966)", () => {
	it("adds at the start, the THR opening block", () => {
		const r = run([
			{ op: "add", label: "Introductions", minutes: 15, at: "start" },
		]);
		expect(ids(r)).toEqual([newRowId(0), A, B, C]);
		if (!r.ok) throw new Error("expected ok");
		expect(r.rows[0]).toMatchObject({
			label: "Introductions",
			minutes: 15,
			kind: "event",
			detail: null,
		});
		expect(r.steps).toEqual([{ opIndex: 0, rowId: newRowId(0), index: 0 }]);
		expect(r.added.get(newRowId(0))).toBe(0);
	});

	it("adds at the end by default, and before / after an anchor", () => {
		expect(ids(run([{ op: "add", label: "x", minutes: 1 }]))).toEqual([
			A,
			B,
			C,
			newRowId(0),
		]);
		expect(
			ids(run([{ op: "add", label: "x", minutes: 1, before: B }])),
		).toEqual([A, newRowId(0), B, C]);
		expect(ids(run([{ op: "add", label: "x", minutes: 1, after: B }]))).toEqual(
			[A, B, newRowId(0), C],
		);
		expect(
			ids(run([{ op: "add", label: "x", minutes: 1, kind: "section" }])),
		).toContain(newRowId(0));
	});

	it("moves, removes and sets, each against the result of the last", () => {
		const r = run([
			{ op: "move", rowId: C, at: "start" },
			{ op: "remove", rowId: A },
			{ op: "set", rowId: B, label: "Bee", minutes: 9, detail: "note" },
		]);
		expect(ids(r)).toEqual([C, B]);
		if (!r.ok) throw new Error("expected ok");
		expect(r.rows[1]).toMatchObject({
			label: "Bee",
			minutes: 9,
			detail: "note",
		});
		expect(r.steps).toEqual([
			{ opIndex: 0, rowId: C, index: 0 },
			{ opIndex: 1, rowId: A, index: null },
			{ opIndex: 2, rowId: B, index: 1 },
		]);
	});

	it("moves before and after an anchor, measured after lifting the row", () => {
		expect(ids(run([{ op: "move", rowId: A, after: C }]))).toEqual([B, C, A]);
		expect(ids(run([{ op: "move", rowId: C, before: A }]))).toEqual([C, A, B]);
		expect(ids(run([{ op: "move", rowId: A, at: "end" }]))).toEqual([B, C, A]);
	});

	it("does not mutate its input", () => {
		const rows = base();
		run([{ op: "remove", rowId: A }], rows);
		expect(rows.map((r) => r.id)).toEqual([A, B, C]);
	});

	describe("refuses the whole batch at the first illegal operation", () => {
		const cases: [string, AgendaEditOp[], number, RegExp][] = [
			[
				"an unknown row",
				[{ op: "remove", rowId: B.replace("b", "f") }],
				0,
				/no row/,
			],
			[
				"a row removed earlier in the batch",
				[
					{ op: "remove", rowId: B },
					{ op: "set", rowId: B, minutes: 3 },
				],
				1,
				/removed earlier/,
			],
			[
				"a row added earlier in the batch",
				[
					{ op: "add", label: "x", minutes: 1 },
					{ op: "move", rowId: newRowId(0), at: "start" },
				],
				1,
				/added in this batch/,
			],
			[
				"two placements",
				[{ op: "add", label: "x", minutes: 1, before: A, at: "end" }],
				0,
				/at most one/,
			],
			[
				"an unknown anchor",
				[{ op: "move", rowId: A, after: B.replace("b", "e") }],
				0,
				/no row/,
			],
			[
				"placing a row next to itself",
				[{ op: "move", rowId: A, before: A }],
				0,
				/itself/,
			],
			["an empty set", [{ op: "set", rowId: A }], 0, /at least one/],
			["a blank label", [{ op: "set", rowId: A, label: "  " }], 0, /empty/],
			[
				"a label over the cap",
				[
					{
						op: "add",
						label: "x".repeat(MAX_TEMPLATE_LABEL_CHARS + 1),
						minutes: 1,
					},
				],
				0,
				/too long/,
			],
			[
				"a note over the cap",
				[
					{
						op: "set",
						rowId: A,
						detail: "x".repeat(MAX_TEMPLATE_DETAIL_CHARS + 1),
					},
				],
				0,
				/too long/,
			],
		];
		for (const [what, ops, opIndex, message] of cases) {
			it(what, () => {
				const r = run(ops);
				expect(r.ok).toBe(false);
				if (r.ok) return;
				expect(r.opIndex).toBe(opIndex);
				expect(r.message).toMatch(message);
			});
		}
	});

	it("counts the label cap in code points, not UTF-16 units", () => {
		// Each emoji is two UTF-16 units; exactly the cap in code points is legal.
		const label = "😀".repeat(MAX_TEMPLATE_LABEL_CHARS);
		expect(run([{ op: "set", rowId: A, label }]).ok).toBe(true);
	});

	it("refuses an add that would pass the row cap, and allows the last one", () => {
		const full = Array.from({ length: MAX_TEMPLATE_BEATS - 1 }, (_, i) =>
			row(`r${i}`),
		);
		expect(run([{ op: "add", label: "x", minutes: 1 }], full).ok).toBe(true);
		const r = run(
			[
				{ op: "add", label: "x", minutes: 1 },
				{ op: "add", label: "y", minutes: 1 },
			],
			full,
		);
		expect(r).toMatchObject({ ok: false, opIndex: 1 });
	});
});
