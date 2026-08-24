# Agenda Table Editor Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the per-meeting agenda editor from a stack of form cards into a table with a running clock, per-section subtotals and an always-honest time budget, so an officer can re-time a meeting and see the consequence as they type.

**Architecture:** The editor computes its clock by calling the same three pure functions the print route calls (`resolveAgendaRows` → `applyFlex` → `buildTimeline`), in the browser, from a draft payload that gains the fields those functions need. No second derivation exists, so the editor and the printed agenda cannot disagree. A new pure `src/lib/agenda-budget.ts` turns timed rows into totals, subtotals and display bands. The component stays presentational — every mutation is a prop — so it remains reachable from vitest without the Start runtime.

**Tech Stack:** TanStack Start (React 19), Drizzle/Postgres, zod, Vitest + Testing Library, Biome (tabs, double quotes), Tailwind v4 + shadcn/ui, `sonner` for toasts.

**Spec:** `docs/superpowers/specs/2026-08-24-agenda-editor-design.md`

## Global Constraints

- **Import alias is `#/*` → `src/*`.** Use it, not relative paths across directories.
- **Biome formats with tabs and double quotes**, import organization on. Run `bun run fix` before committing; read the gate with `bunx biome check --diagnostic-level=error`.
- **`bun run typecheck` is the only thing that type-checks.** `bun run build` and `bun run test` both transpile without checking. Run it before claiming a task green.
- **Integration tests need a database or they silently SKIP.** Export `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test"` (on this maintainer's Mac the test DB is on port **5433**). A green run with no DB proves nothing.
- **Do not run `bun run fix` mid-merge** — it writes even when it exits non-zero and will reorder imports inside an unresolved conflict hunk.
- **Never hand-edit `src/routeTree.gen.ts`.** No task here changes routing.
- **Existing limits, exact values:** `MAX_BEAT_MINUTES = 600`, `MAX_TEMPLATE_LABEL_CHARS = 120`, `MAX_TEMPLATE_DETAIL_CHARS = 400`, `MAX_ROLE_REPEAT_SLOTS = 20`, `TABLE_TOPICS_MIN = 5`, `TABLE_TOPICS_MAX = 25`, `FLEX_TOLERANCE_MINUTES = 2`. All exported already — import them, never retype the number.
- **Numbers live in `src/lib/`,** never in a component or a server-fn module. A constant in a module that imports `#/db` cannot be imported by a unit test.
- **The `flex` boolean is load-bearing for correctness, not just for the pin control.** `buildTemplateRows` reads `row.flex` to mark the row `applyFlex` resizes. Ship the pipeline without it on the payload and `applyFlex` is a permanent no-op that fails in the direction that looks fine.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/agenda-template-rows.ts` (modify) | Gains `buildTemplateRowsWithSource`, which returns each emitted row **with the stored beat it came from and its iteration index**. `buildTemplateRows` becomes a one-line wrapper over it, so there is still exactly one implementation. |
| `src/lib/agenda-timing.ts` (modify) | Gains `timelineEnd` — the clock time the agenda finishes — reusing the private formatter rather than exposing it. |
| `src/lib/agenda-budget.ts` (create) | Pure. Timed rows + provenance + slot length → totals, signed delta, end time, per-section subtotals, and the display bands the table renders. |
| `src/server/meeting-agenda-edit-logic.ts` (modify) | `loadAgendaDraft` returns `flex` per row plus the meeting's slots, start instant, timezone, length and run-of-show variant. `updateAgendaRow` accepts `flex`. |
| `src/server/meeting-agenda-edit.ts` (modify) | `flex` in the `patchInput` zod object. |
| `src/components/agenda/agenda-editor.tsx` (rewrite) | The table. Presentational; all mutations are props. |
| `src/routes/club.$clubId.meeting.$meetingId_.agenda.tsx` (modify) | Wires the added props; keeps `router.invalidate()` for structural mutations only. |
| `src/routes/agenda-editor-wiring.guard.test.ts` (modify) | Extended for the added prop expressions. |

**Why the provenance refactor exists (Task 1), since the spec does not name it.** The table must know which stored beat each rendered row came from, in order to (a) send an edit to the right beat and (b) band rows by iteration. `buildTemplateRows` returns `AgendaRow[]`, and `AgendaRow` carries no id and no iteration index. Re-deriving the mapping in the component would duplicate the block-grouping logic and reintroduce the second side D1 exists to remove. So the mapping comes out of the one function that already computes it.

---

## Task 1: Row provenance from the template expander

**Files:**
- Modify: `src/lib/agenda-template-rows.ts`
- Test: `src/lib/agenda-template-rows.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export type SourcedAgendaRow = { row: AgendaRow; beatId: string; iteration: number; iterationCount: number }` and `export function buildTemplateRowsWithSource(beats: TemplateBeatRow[], roles: TemplateRoleRow[], slots: AgendaSlot[]): SourcedAgendaRow[]`. `buildTemplateRows` keeps its exact current signature and behaviour.

`TemplateBeatRow` has no `id` field today. It gains one, because the editor addresses a beat by id.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/agenda-template-rows.test.ts`:

```ts
describe("buildTemplateRowsWithSource", () => {
	it("tags each row with its beat and iteration, and interleaves a repeat block", () => {
		const beats: TemplateBeatRow[] = [
			{
				id: "b-speech",
				sortOrder: 0,
				kind: "role",
				label: "Contest speech",
				detail: null,
				minutes: 7,
				roleKey: "contestant",
				repeatsRoleKey: "contestant",
				flex: false,
				markGreen: null,
				markYellow: null,
				markRed: null,
			},
			{
				id: "b-silence",
				sortOrder: 1,
				kind: "event",
				label: "One minute of silence",
				detail: null,
				minutes: 1,
				roleKey: null,
				repeatsRoleKey: "contestant",
				flex: false,
				markGreen: null,
				markYellow: null,
				markRed: null,
			},
		];
		const roles: TemplateRoleRow[] = [
			{ key: "contestant", name: "Contestant", isSpeakerRole: true },
		];
		const slots: AgendaSlot[] = [0, 1, 2].map((i) => ({
			id: `s${i}`,
			roleName: "Contestant",
			roleKey: "contestant",
			category: "speaker",
			isSpeakerRole: true,
			slotIndex: i,
			assigneeName: `Speaker ${i + 1}`,
			speechTitle: null,
			projectLevel: null,
			minMinutes: null,
			maxMinutes: null,
			evaluatesSlotId: null,
			evaluates: null,
		}));

		const out = buildTemplateRowsWithSource(beats, roles, slots);

		// Two beats x three contestants, INTERLEAVED: the speech beat owns
		// positions 0, 2, 4 — there is no contiguous run of its rows.
		expect(out.map((e) => e.beatId)).toEqual([
			"b-speech",
			"b-silence",
			"b-speech",
			"b-silence",
			"b-speech",
			"b-silence",
		]);
		expect(out.map((e) => e.iteration)).toEqual([0, 0, 1, 1, 2, 2]);
		expect(out.every((e) => e.iterationCount === 3)).toBe(true);
	});

	it("reports iteration 0 of 1 for a non-repeating beat", () => {
		const beats: TemplateBeatRow[] = [
			{
				id: "b-open",
				sortOrder: 0,
				kind: "event",
				label: "Call to order",
				detail: null,
				minutes: 5,
				roleKey: null,
				repeatsRoleKey: null,
				flex: false,
				markGreen: null,
				markYellow: null,
				markRed: null,
			},
		];
		const out = buildTemplateRowsWithSource(beats, [], []);
		expect(out).toHaveLength(1);
		expect(out[0]?.beatId).toBe("b-open");
		expect(out[0]?.iteration).toBe(0);
		expect(out[0]?.iterationCount).toBe(1);
	});

	it("buildTemplateRows stays byte-identical to the sourced rows' .row", () => {
		const beats: TemplateBeatRow[] = [
			{
				id: "b1",
				sortOrder: 0,
				kind: "section",
				label: "OPENING",
				detail: null,
				minutes: 0,
				roleKey: null,
				repeatsRoleKey: null,
				flex: false,
				markGreen: null,
				markYellow: null,
				markRed: null,
			},
		];
		expect(buildTemplateRows(beats, [], [])).toEqual(
			buildTemplateRowsWithSource(beats, [], []).map((e) => e.row),
		);
	});
});
```

Add `buildTemplateRowsWithSource` to the existing import at the top of that test file, and `id: "…"` to every `TemplateBeatRow` literal already in it (the field becomes required).

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/agenda-template-rows.test.ts`
Expected: FAIL — `buildTemplateRowsWithSource is not a function`, plus type errors on the missing `id`.

- [ ] **Step 3: Implement**

In `src/lib/agenda-template-rows.ts`, add `id: string;` as the first field of `TemplateBeatRow`. Then rename the existing `buildTemplateRows` body to `buildTemplateRowsWithSource`, changing every `out.push(emitted)` to push a sourced entry, and add the wrapper:

```ts
/** One emitted row plus the stored beat and repeat iteration it came from.
 *
 *  The editor needs this and cannot re-derive it: `AgendaRow` carries no id,
 *  and re-running the block grouping in a component would duplicate the very
 *  logic this module exists to own. */
export type SourcedAgendaRow = {
	row: AgendaRow;
	beatId: string;
	/** 0 for a non-repeating beat; the slot index within the block otherwise. */
	iteration: number;
	/** 1 for a non-repeating beat; the block's slot count otherwise. */
	iterationCount: number;
};

export function buildTemplateRowsWithSource(
	beats: TemplateBeatRow[],
	roles: TemplateRoleRow[],
	slots: AgendaSlot[],
): SourcedAgendaRow[] {
	const rolesByKey = new Map(roles.map((r) => [r.key, r]));
	const ordered = [...beats].sort((a, b) => a.sortOrder - b.sortOrder);
	const out: SourcedAgendaRow[] = [];

	let i = 0;
	while (i < ordered.length) {
		const row = ordered[i];
		if (!row) break;

		if (row.repeatsRoleKey == null) {
			if (row.kind === "role" && row.roleKey != null) {
				const owned = slotsForRole(slots, row.roleKey).slice(
					0,
					MAX_ROLE_REPEAT_SLOTS,
				);
				const emitted = toRow(row, rolesByKey, owned, 0, 0);
				if (emitted) {
					out.push({
						row: emitted,
						beatId: row.id,
						iteration: 0,
						iterationCount: 1,
					});
				}
			} else {
				const emitted = toRow(row, rolesByKey, [], 0, 0);
				if (emitted) {
					out.push({
						row: emitted,
						beatId: row.id,
						iteration: 0,
						iterationCount: 1,
					});
				}
			}
			i += 1;
			continue;
		}

		const repeatKey = row.repeatsRoleKey;
		const block: TemplateBeatRow[] = [];
		while (i < ordered.length) {
			const next = ordered[i];
			if (!next || next.repeatsRoleKey !== repeatKey) break;
			block.push(next);
			i += 1;
		}

		const repeated = slotsForRole(slots, repeatKey).slice(
			0,
			MAX_ROLE_REPEAT_SLOTS,
		);
		repeated.forEach((s, n) => {
			for (const blockRow of block) {
				const bound = blockRow.roleKey === repeatKey ? [s] : [];
				const emitted = toRow(blockRow, rolesByKey, bound, n, repeated.length);
				if (emitted) {
					out.push({
						row: emitted,
						beatId: blockRow.id,
						iteration: n,
						iterationCount: repeated.length,
					});
				}
			}
		});
	}

	return out;
}

/** The rows alone. Kept as the name every renderer already imports — one
 *  implementation, two views of it. */
export function buildTemplateRows(
	beats: TemplateBeatRow[],
	roles: TemplateRoleRow[],
	slots: AgendaSlot[],
): AgendaRow[] {
	return buildTemplateRowsWithSource(beats, roles, slots).map((e) => e.row);
}
```

Move the original `buildTemplateRows` docblock onto `buildTemplateRowsWithSource` — it documents the block-grouping rules, which now live there.

- [ ] **Step 4: Fix every other construction site of `TemplateBeatRow`**

`id` is now required. Run `bun run typecheck` and add an `id` to each failing literal. Expect hits in `src/lib/agenda-parity.test.ts`, `src/lib/agenda-template-slides.test.ts`, and wherever `loadTemplateBeats` builds the row (it selects from `meeting_template_beats`, which already has `id` — add it to the select).

- [ ] **Step 5: Run the full agenda suite**

Run: `bunx vitest run src/lib/agenda-template-rows.test.ts src/lib/agenda-parity.test.ts src/lib/agenda-template-slides.test.ts && bun run typecheck`
Expected: PASS. The pre-existing tests passing unchanged is the proof the wrapper is faithful.

- [ ] **Step 6: Commit**

```bash
git add src/lib/agenda-template-rows.ts src/lib/agenda-template-rows.test.ts
git add -u
git commit -m "feat(agenda): expose row provenance from the template expander"
```

---

## Task 2: `timelineEnd`

**Files:**
- Modify: `src/lib/agenda-timing.ts`
- Test: `src/lib/agenda-timing.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function timelineEnd(rows: { minutes: number }[], startsAt: Date | string, timeZone: string): string`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/agenda-timing.test.ts`:

```ts
describe("timelineEnd", () => {
	it("returns the clock time after every row's duration", () => {
		// 6:45 PM America/Chicago on 2026-09-10.
		const start = new Date("2026-09-10T23:45:00.000Z");
		const rows = [{ minutes: 25 }, { minutes: 39 }, { minutes: 28 }];
		expect(timelineEnd(rows, start, "America/Chicago")).toBe("8:17");
	});

	it("returns the start itself for an empty agenda", () => {
		const start = new Date("2026-09-10T23:45:00.000Z");
		expect(timelineEnd([], start, "America/Chicago")).toBe("6:45");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/agenda-timing.test.ts`
Expected: FAIL — `timelineEnd is not a function`.

- [ ] **Step 3: Implement**

Append to `src/lib/agenda-timing.ts` (both helpers it needs are already private in that file):

```ts
/**
 * The clock time an agenda FINISHES — its start plus every row's duration.
 *
 * A separate export rather than a second return value from `buildTimeline`,
 * so the print route's call site is untouched, and rather than exporting
 * `formatClock`, which would put a formatter on this module's public surface
 * for one caller.
 */
export function timelineEnd(
	rows: { minutes: number }[],
	startsAt: Date | string,
	timeZone: string,
): string {
	const start = typeof startsAt === "string" ? new Date(startsAt) : startsAt;
	const total = rows.reduce((sum, r) => sum + r.minutes, 0);
	return formatClock(startMinutesInZone(start, timeZone) + total);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/lib/agenda-timing.test.ts`
Expected: PASS (2 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda-timing.ts src/lib/agenda-timing.test.ts
git commit -m "feat(agenda): add timelineEnd for the agenda budget readout"
```

---

## Task 3: `agenda-budget.ts` — totals, subtotals and bands

**Files:**
- Create: `src/lib/agenda-budget.ts`
- Test: `src/lib/agenda-budget.test.ts`

**Interfaces:**
- Consumes: `SourcedAgendaRow` (Task 1), `timelineEnd` (Task 2), `TimelineRow` from `#/lib/agenda-timing`.
- Produces:

```ts
export type SectionSubtotal = { label: string; minutes: number };
export type AgendaBudget = {
	totalMinutes: number;
	slotMinutes: number;
	/** Signed; positive is over. NEVER deadbanded. */
	deltaMinutes: number;
	endsAt: string;
	sections: SectionSubtotal[];
};
export type BudgetEntry = { row: TimelineRow; beatId: string; iteration: number; iterationCount: number };
export type EditorBand =
	| { kind: "row"; entry: BudgetEntry }
	| {
			kind: "iteration";
			iteration: number;
			iterationCount: number;
			entries: BudgetEntry[];
			editable: boolean;
			startsAt: string;
			endsAt: string;
			minutes: number;
	  };
export function summarizeAgenda(entries: BudgetEntry[], slotMinutes: number, startsAt: Date | string, timeZone: string): AgendaBudget;
export function groupIntoBands(entries: BudgetEntry[]): EditorBand[];
```

- [ ] **Step 1: Write the failing test**

Create `src/lib/agenda-budget.test.ts`. `CONTEST` is the real seeded shape at four contestants; keep these literals — they are the absolute assertions the spec requires, not values re-derived from the code under test.

```ts
import { describe, expect, it } from "vitest";
import {
	type BudgetEntry,
	groupIntoBands,
	summarizeAgenda,
} from "./agenda-budget";

const TZ = "America/Chicago";
/** 6:45 PM America/Chicago, 2026-09-10 — MCF's club contest. */
const START = new Date("2026-09-10T23:45:00.000Z");

/** One entry, defaulted. `section` marks a band row. */
function entry(
	over: Partial<BudgetEntry["row"]> & { minutes: number },
	src: Partial<Omit<BudgetEntry, "row">> = {},
): BudgetEntry {
	return {
		row: {
			who: "x",
			detail: "",
			marks: null,
			time: "0:00",
			...over,
		} as BudgetEntry["row"],
		beatId: src.beatId ?? "b",
		iteration: src.iteration ?? 0,
		iterationCount: src.iterationCount ?? 1,
	};
}

/** The seeded speech contest with four contestants, in emission order. */
function contest(): BudgetEntry[] {
	const out: BudgetEntry[] = [
		entry({ who: "OPENING", minutes: 0, section: true }, { beatId: "s1" }),
		entry({ who: "Call to order", minutes: 5 }, { beatId: "o1" }),
		entry({ who: "Welcome and introductions", minutes: 5 }, { beatId: "o2" }),
		entry({ who: "Judges' briefing", minutes: 10 }, { beatId: "o3" }),
		entry({ who: "Contest rules and timing", minutes: 5 }, { beatId: "o4" }),
		entry({ who: "SPEECHES", minutes: 0, section: true }, { beatId: "s2" }),
	];
	for (let n = 0; n < 4; n += 1) {
		out.push(
			entry(
				{ who: `Contest speech ${n + 1}`, minutes: 7 },
				{ beatId: "sp", iteration: n, iterationCount: 4 },
			),
			entry(
				{ who: "One minute of silence", minutes: 1 },
				{ beatId: "si", iteration: n, iterationCount: 4 },
			),
		);
	}
	out.push(
		entry({ who: "Two minutes of silence", minutes: 2 }, { beatId: "t1" }),
		entry({ who: "Contestant interviews", minutes: 5 }, { beatId: "t2" }),
		entry(
			{ who: "RESULTS AND CLOSING", minutes: 0, section: true },
			{ beatId: "s3" },
		),
		entry({ who: "Tallying", minutes: 10 }, { beatId: "r1" }),
		entry({ who: "Timers' report", minutes: 3 }, { beatId: "r2" }),
		entry({ who: "Results and certificates", minutes: 10 }, { beatId: "r3" }),
		entry({ who: "Closing remarks", minutes: 5 }, { beatId: "r4" }),
	);
	return out;
}

describe("summarizeAgenda", () => {
	it("costs MCF's 2026-09-10 contest at 92 minutes against a 90-minute slot", () => {
		const b = summarizeAgenda(contest(), 90, START, TZ);
		expect(b.totalMinutes).toBe(92);
		expect(b.slotMinutes).toBe(90);
		expect(b.deltaMinutes).toBe(2);
		expect(b.endsAt).toBe("8:17");
	});

	it("subtotals each section band", () => {
		const b = summarizeAgenda(contest(), 90, START, TZ);
		expect(b.sections).toEqual([
			{ label: "OPENING", minutes: 25 },
			{ label: "SPEECHES", minutes: 39 },
			{ label: "RESULTS AND CLOSING", minutes: 28 },
		]);
	});

	it("reports the delta EXACTLY inside the +/-2 tolerance, never softened", () => {
		// The whole point of D5: applyFlex's status would read "exact" at +2,
		// so a readout derived from `status` would say nothing about this meeting.
		const b = summarizeAgenda(contest(), 90, START, TZ);
		expect(b.deltaMinutes).toBe(2);
		expect(b.deltaMinutes).not.toBe(0);
	});

	it("signs the delta negative when the agenda ends early", () => {
		const b = summarizeAgenda(contest(), 100, START, TZ);
		expect(b.deltaMinutes).toBe(-8);
		expect(b.endsAt).toBe("8:17");
	});

	it("counts rows before the first section into no section", () => {
		const b = summarizeAgenda(
			[
				entry({ who: "Stray", minutes: 4 }),
				entry({ who: "OPENING", minutes: 0, section: true }),
				entry({ who: "Call to order", minutes: 5 }),
			],
			90,
			START,
			TZ,
		);
		expect(b.sections).toEqual([{ label: "OPENING", minutes: 5 }]);
		expect(b.totalMinutes).toBe(9);
	});
});

describe("groupIntoBands", () => {
	it("bands a repeat block by iteration and marks only the first editable", () => {
		const bands = groupIntoBands(contest());
		const iters = bands.filter((b) => b.kind === "iteration");
		expect(iters).toHaveLength(4);
		expect(iters.map((b) => b.kind === "iteration" && b.editable)).toEqual([
			true,
			false,
			false,
			false,
		]);
		expect(iters.map((b) => b.kind === "iteration" && b.minutes)).toEqual([
			8, 8, 8, 8,
		]);
	});

	it("keeps every non-repeating row a plain band, in order", () => {
		const bands = groupIntoBands(contest());
		expect(bands[0]).toEqual({ kind: "row", entry: contest()[0] });
		expect(bands.filter((b) => b.kind === "row")).toHaveLength(13);
	});

	it("produces no iteration band at a single arity", () => {
		const one = [
			entry(
				{ who: "Contest speech", minutes: 7 },
				{ beatId: "sp", iteration: 0, iterationCount: 1 },
			),
		];
		expect(groupIntoBands(one)).toEqual([{ kind: "row", entry: one[0] }]);
	});

	it("produces nothing at all for an empty block", () => {
		expect(groupIntoBands([])).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/agenda-budget.test.ts`
Expected: FAIL — cannot resolve `./agenda-budget`.

- [ ] **Step 3: Implement**

Create `src/lib/agenda-budget.ts`:

```ts
// src/lib/agenda-budget.ts
//
// The agenda editor's numbers. Pure, and in `lib/` rather than in the
// component or a server-fn module for the reason CLAUDE.md records twice: a
// constant living behind an unmountable surface can have its bounds raised
// with the whole suite green (#519's corollary, #522's repeat of it).
import type { TimelineRow } from "./agenda-timing";
import { timelineEnd } from "./agenda-timing";

/** One section band's own total. */
export type SectionSubtotal = { label: string; minutes: number };

export type AgendaBudget = {
	totalMinutes: number;
	slotMinutes: number;
	/**
	 * Signed; positive is over. NEVER deadbanded — `applyFlex`'s `status`
	 * collapses anything within FLEX_TOLERANCE_MINUTES to "exact", which is
	 * right for a banner and wrong for a readout. A contest 2 minutes over
	 * would otherwise report nothing at all.
	 */
	deltaMinutes: number;
	endsAt: string;
	sections: SectionSubtotal[];
};

/** A timed row plus where it came from — `SourcedAgendaRow` after timing. */
export type BudgetEntry = {
	row: TimelineRow;
	beatId: string;
	iteration: number;
	iterationCount: number;
};

/**
 * What the table renders: either a standalone row, or one iteration of a
 * repeat block.
 *
 * Banding is by ITERATION, not by beat, because the beats INTERLEAVE — a
 * two-beat block over four contestants emits speech, silence, speech,
 * silence…, so the speech beat's rows are positions 0, 2, 4, 6 and no
 * contiguous run of them exists to group.
 */
export type EditorBand =
	| { kind: "row"; entry: BudgetEntry }
	| {
			kind: "iteration";
			iteration: number;
			iterationCount: number;
			entries: BudgetEntry[];
			/** Only iteration 0 is editable; its cells write the shared beats. */
			editable: boolean;
			startsAt: string;
			endsAt: string;
			minutes: number;
	  };

export function summarizeAgenda(
	entries: BudgetEntry[],
	slotMinutes: number,
	startsAt: Date | string,
	timeZone: string,
): AgendaBudget {
	const rows = entries.map((e) => e.row);
	const totalMinutes = rows.reduce((sum, r) => sum + r.minutes, 0);

	const sections: SectionSubtotal[] = [];
	for (const r of rows) {
		if (r.section === true) {
			sections.push({ label: r.who, minutes: 0 });
			continue;
		}
		// Rows before the first band belong to no section, deliberately: an
		// agenda may legally open without one, and inventing an "(untitled)"
		// band would put a heading on the printed page's behalf that nothing
		// stored asked for.
		const current = sections.at(-1);
		if (current) current.minutes += r.minutes;
	}

	return {
		totalMinutes,
		slotMinutes,
		deltaMinutes: totalMinutes - slotMinutes,
		endsAt: timelineEnd(rows, startsAt, timeZone),
		sections,
	};
}

export function groupIntoBands(entries: BudgetEntry[]): EditorBand[] {
	const out: EditorBand[] = [];
	let i = 0;
	while (i < entries.length) {
		const head = entries[i];
		if (!head) break;
		if (head.iterationCount <= 1) {
			out.push({ kind: "row", entry: head });
			i += 1;
			continue;
		}
		// Consecutive entries sharing this iteration index form one band. The
		// expander emits a whole block per iteration before moving on, so this
		// run is exactly one iteration of it.
		const group: BudgetEntry[] = [];
		const iteration = head.iteration;
		while (i < entries.length) {
			const next = entries[i];
			if (
				!next ||
				next.iterationCount <= 1 ||
				next.iteration !== iteration ||
				next.iterationCount !== head.iterationCount
			) {
				break;
			}
			group.push(next);
			i += 1;
		}
		const minutes = group.reduce((sum, e) => sum + e.row.minutes, 0);
		out.push({
			kind: "iteration",
			iteration,
			iterationCount: head.iterationCount,
			entries: group,
			editable: iteration === 0,
			startsAt: group[0]?.row.time ?? "",
			endsAt: group.at(-1)?.row.time ?? "",
			minutes,
		});
	}
	return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/lib/agenda-budget.test.ts && bun run typecheck`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda-budget.ts src/lib/agenda-budget.test.ts
git commit -m "feat(agenda): pure budget and banding derivation for the editor"
```

---

## Task 4: `flex` on the draft, read and write

**Files:**
- Modify: `src/server/meeting-agenda-edit-logic.ts`
- Modify: `src/server/meeting-agenda-edit.ts`
- Modify: `src/components/agenda/agenda-editor.tsx` (the `RowPatch` type only)
- Test: `src/server/meeting-agenda-edit-logic.integration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AgendaDraftRow` gains `flex: boolean`. `updateAgendaRow`'s patch and the client `RowPatch` both accept `flex?: boolean`.

- [ ] **Step 1: Write the failing test**

Append to `src/server/meeting-agenda-edit-logic.integration.test.ts`, following that file's existing seed/cleanup helpers:

```ts
it("round-trips the flex flag on a row", async () => {
	const { meetingId } = await seedTemplatedMeeting();
	const before = await loadAgendaDraft(meetingId);
	const row = before?.rows[0];
	expect(row).toBeDefined();
	expect(row?.flex).toBe(false);

	await updateAgendaRow({
		meetingId,
		rowId: row?.id ?? "",
		patch: { flex: true },
	});

	const after = await loadAgendaDraft(meetingId);
	// Resolved by sortOrder, not by id: the write forks a private copy and
	// mints fresh row ids.
	expect(after?.rows[0]?.flex).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" bunx vitest run src/server/meeting-agenda-edit-logic.integration.test.ts`
Expected: FAIL — `flex` is not a property of `AgendaDraftRow`.
If the run reports the suite SKIPPED, the DB env var is wrong. Fix that before continuing; a skip is not a pass.

- [ ] **Step 3: Implement the read side**

In `src/server/meeting-agenda-edit-logic.ts`:

Add to `AgendaDraftRow`, after `minutes`:

```ts
	/** Whether this row stretches to fill the slot. Required by the CLIENT's
	 *  `applyFlex`, not only by the editor's pin control: `buildTemplateRows`
	 *  reads it to mark the row `applyFlex` resizes, so omitting it here makes
	 *  the browser's `applyFlex` a permanent no-op and silently desyncs the
	 *  editor's clock from the printed agenda. */
	flex: boolean;
```

Add to `loadAgendaDraft`'s beats select, after `minutes`:

```ts
				flex: meetingTemplateBeats.flex,
```

- [ ] **Step 4: Implement the write side**

In the same file, add `"flex"` to `updateAgendaRow`'s `patch` `Pick<…>` union. It needs no validation clause — a boolean has no range.

In `src/server/meeting-agenda-edit.ts`, add to the **end** of `patchInput`'s `patch` object, after `markRed`:

```ts
			flex: z.boolean().optional(),
```

Appending at the end is deliberate: `meeting-templates-authz.guard.test.ts` matches each bounded field with a `[\s\S]{0,120}` window between the field name and its `.max(…)`, and inserting between an existing field and its bound could push one out of range.

In `src/components/agenda/agenda-editor.tsx`, add `| "flex"` to the `RowPatch` `Pick<…>` union.

- [ ] **Step 5: Run tests**

Run:
```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" bunx vitest run \
  src/server/meeting-agenda-edit-logic.integration.test.ts \
  src/server/meeting-templates-authz.guard.test.ts \
  src/server/meeting-agenda-edit.test.ts
bun run typecheck
```
Expected: PASS. The authz guard passing is the check that the zod addition did not break its bound-matching.

- [ ] **Step 6: Commit**

```bash
git add -u
git commit -m "feat(agenda): carry the flex flag on the agenda draft, read and write"
```

---

## Task 5: The rest of the draft payload

**Files:**
- Modify: `src/server/meeting-agenda-edit-logic.ts`
- Test: `src/server/meeting-agenda-edit-logic.integration.test.ts`

**Interfaces:**
- Consumes: Task 4's `AgendaDraftRow.flex`.
- Produces: `AgendaDraft` gains `slots: AgendaSlot[]`, `scheduledAt: string`, `timeZone: string`, `lengthMinutes: number`, `geIntroducesFunctionaries: boolean`.

`scheduledAt` is serialised as an ISO string, not a `Date`: it crosses a server-fn boundary, and `buildTimeline` already accepts `Date | string`.

- [ ] **Step 1: Write the failing test**

```ts
it("carries what the client needs to compute the clock", async () => {
	const { meetingId, clubId } = await seedTemplatedMeeting();
	const draft = await loadAgendaDraft(meetingId);
	expect(draft).not.toBeNull();
	expect(typeof draft?.scheduledAt).toBe("string");
	expect(draft?.timeZone).toBe("America/Chicago");
	expect(draft?.lengthMinutes).toBe(90);
	expect(draft?.geIntroducesFunctionaries).toBe(false);
	expect(Array.isArray(draft?.slots)).toBe(true);
	// Not merely present — the slots must be THIS meeting's, or the repeat
	// block fans across the wrong count and every clock below it is wrong.
	for (const s of draft?.slots ?? []) {
		expect(typeof s.slotIndex).toBe("number");
	}
	expect(clubId).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" bunx vitest run src/server/meeting-agenda-edit-logic.integration.test.ts`
Expected: FAIL — those properties do not exist on `AgendaDraft`.

- [ ] **Step 3: Implement**

Add to the `AgendaDraft` type:

```ts
	/** This meeting's role slots — what the repeat block fans across and where
	 *  the Who column's names come from. */
	slots: AgendaSlot[];
	/** ISO instant; `buildTimeline` accepts a string. */
	scheduledAt: string;
	timeZone: string;
	lengthMinutes: number;
	/** Ignored on the template branch; `resolveAgendaRows` requires it, and
	 *  Phase 2's standard branch is where it starts mattering. */
	geIntroducesFunctionaries: boolean;
```

Widen `loadAgendaDraft`'s first query to join the club and select the extra columns:

```ts
	const [meeting] = await database
		.select({
			templateId: meetings.templateId,
			status: meetings.status,
			scheduledAt: meetings.scheduledAt,
			lengthMinutes: meetings.lengthMinutes,
			clubId: meetings.clubId,
			timeZone: clubs.timezone,
			geIntroducesFunctionaries: clubs.geIntroducesFunctionaries,
		})
		.from(meetings)
		.innerJoin(clubs, eq(clubs.id, meetings.clubId))
		.where(eq(meetings.id, meetingId))
		.limit(1);
```

Load the slots with the loader the meeting page already uses rather than a new query — find it with `grep -rn "AgendaSlot\[\]" src/server/*.ts` and call the existing one, so the editor and the meeting page agree about what a slot is. Add its result to the returned object along with `scheduledAt: meeting.scheduledAt.toISOString()` and the three scalars.

- [ ] **Step 4: Run tests**

Run:
```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" bunx vitest run src/server/meeting-agenda-edit-logic.integration.test.ts
bun run typecheck
```
Expected: PASS. `typecheck` will flag `agenda-editor.test.tsx`'s `draft` fixture as missing the new required fields — fix it there by adding `slots: []`, `scheduledAt: "2026-09-10T23:45:00.000Z"`, `timeZone: "America/Chicago"`, `lengthMinutes: 90`, `geIntroducesFunctionaries: false`, and `flex: false` on each row.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(agenda): carry slots, start, timezone and length on the agenda draft"
```

---

## Task 6: The table — rows, running clock, footer

**Files:**
- Modify: `src/components/agenda/agenda-editor.tsx`
- Test: `src/components/agenda/agenda-editor.test.tsx`

**Interfaces:**
- Consumes: `summarizeAgenda`, `groupIntoBands`, `BudgetEntry` (Task 3); the widened `AgendaDraft` (Tasks 4–5).
- Produces: `AgendaEditor`'s props are unchanged from today. A new non-exported `useAgendaModel(draft)` inside the component file derives `{ bands, budget }`.

This task delivers the table with **all rows flat and every row's own controls** — iteration banding is Task 7, the flex cell is Task 8, undo is Task 9. Split that way so a reviewer can reject the table shape without rejecting the banding.

- [ ] **Step 1: Write the failing test**

Append to `src/components/agenda/agenda-editor.test.tsx`:

```ts
describe("AgendaEditor budget footer", () => {
	it("shows the running clock, the total and the signed delta", () => {
		render(<AgendaEditor draft={draft} {...noopHandlers} />);
		// draft is OPENING (0) + Welcome (5) from a 6:45 PM start, 90-min slot.
		expect(screen.getByTestId("agenda-row-start-0")).toHaveTextContent("6:45");
		expect(screen.getByTestId("agenda-row-start-1")).toHaveTextContent("6:45");
		const footer = screen.getByTestId("agenda-budget");
		expect(footer).toHaveTextContent("6:50");
		expect(footer).toHaveTextContent("5 min");
		expect(footer).toHaveTextContent("slot 90 min");
		expect(footer).toHaveTextContent("85 under");
	});

	it("states the delta inside the +/-2 tolerance and withholds the advice", () => {
		const tight: AgendaDraft = {
			...draft,
			lengthMinutes: 3,
			rows: [{ ...draft.rows[1], minutes: 5 }],
		};
		render(<AgendaEditor draft={tight} {...noopHandlers} />);
		const footer = screen.getByTestId("agenda-budget");
		expect(footer).toHaveTextContent("2 over");
		// flexBannerMessage returns null within the deadband.
		expect(screen.queryByTestId("agenda-budget-advice")).toBeNull();
	});

	it("renders the advisory sentence outside the tolerance", () => {
		const late: AgendaDraft = {
			...draft,
			lengthMinutes: 3,
			rows: [{ ...draft.rows[1], minutes: 20 }],
		};
		render(<AgendaEditor draft={late} {...noopHandlers} />);
		expect(screen.getByTestId("agenda-budget-advice")).toHaveTextContent(
			/runs 17 min long/,
		);
	});

	it("recomputes the clock as you type, before any save", async () => {
		const user = userEvent.setup();
		render(<AgendaEditor draft={draft} {...noopHandlers} />);
		const min = screen.getAllByLabelText("Row minutes")[1];
		await user.clear(min);
		await user.type(min, "30");
		await waitFor(() => {
			expect(screen.getByTestId("agenda-budget")).toHaveTextContent("7:15");
		});
		// No blur yet — the clock moved without a server round-trip.
		expect(noopHandlers.onUpdateRow).not.toHaveBeenCalled();
	});

	it("subtotals each section band", () => {
		render(<AgendaEditor draft={draft} {...noopHandlers} />);
		expect(screen.getByTestId("agenda-section-total-0")).toHaveTextContent("5");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/components/agenda/agenda-editor.test.tsx`
Expected: FAIL — no `agenda-budget` test id.

- [ ] **Step 3: Implement**

Rewrite `AgendaEditor`'s body. Keep the file's existing helpers (`errMessage`, `joinNames`, `isRoleAlreadyGone`, `runAction`, `parseIntOrNull`, `RolesPanel`) and the `reseed()`-on-rejection contract verbatim — its docblock explains a property that a passing test cannot see.

Derive the model with the same three functions the print route calls:

```ts
/** The editor's clock, computed the way the PRINT route computes it — the
 *  same three pure functions in the same order (print.tsx:164-168), never a
 *  second derivation. A parity test cannot see a defect present on both
 *  sides, so the fix is to have only one side. */
function useAgendaModel(draft: AgendaDraft, localRows: AgendaDraftRow[]) {
	return useMemo(() => {
		// `AgendaDraftRow` and `TemplateBeatRow` are field-for-field identical
		// once Tasks 1 and 4 have landed (`id`, `sortOrder`, `kind`, `label`,
		// `detail`, `minutes`, `roleKey`, `repeatsRoleKey`, `flex`, three
		// marks), so this passes straight through with no mapping. If
		// typecheck disagrees, the two types have drifted — reconcile them
		// rather than papering over it with a spread.
		const sourced = buildTemplateRowsWithSource(
			localRows,
			draft.roles,
			draft.slots,
		);
		const flexed = applyFlex(
			sourced.map((e) => e.row),
			draft.lengthMinutes,
		);
		const timed = buildTimeline(
			flexed.rows,
			draft.scheduledAt,
			draft.timeZone,
		);
		const entries: BudgetEntry[] = timed.map((row, i) => ({
			row,
			beatId: sourced[i]?.beatId ?? "",
			iteration: sourced[i]?.iteration ?? 0,
			iterationCount: sourced[i]?.iterationCount ?? 1,
		}));
		return {
			entries,
			bands: groupIntoBands(entries),
			budget: summarizeAgenda(
				entries,
				draft.lengthMinutes,
				draft.scheduledAt,
				draft.timeZone,
			),
			advice: flexBannerMessage(flexed),
		};
	}, [draft, localRows]);
}
```

Hold `localRows` in `AgendaEditor` state, seeded from `draft.rows` and re-seeded whenever `draft.rows` changes identity. A cell's `onChange` updates `localRows`; its `onBlur` commits through `onUpdateRow` exactly as today.

Render a `<table>`: a header row `Start · Activity · Who · Min`, then one `<tr>` per band entry. Section rows span the activity column, carry `data-testid={"agenda-section-total-" + n}` with their subtotal from `budget.sections`, and use `<th scope="rowgroup">`. Ordinary rows carry `data-testid={"agenda-row-start-" + i}` on the Start cell.

The footer:

```tsx
<tfoot data-testid="agenda-budget">
	<tr>
		<td colSpan={4}>
			Ends {budget.endsAt} · {budget.totalMinutes} min · slot{" "}
			{budget.slotMinutes} min ·{" "}
			{budget.deltaMinutes === 0
				? "on time"
				: budget.deltaMinutes > 0
					? `${budget.deltaMinutes} over`
					: `${-budget.deltaMinutes} under`}
		</td>
	</tr>
	{advice ? (
		<tr>
			<td colSpan={4} data-testid="agenda-budget-advice">
				{advice}
			</td>
		</tr>
	) : null}
</tfoot>
```

The delta is printed from `budget.deltaMinutes` and never from `flex.status`, which is deadbanded. `advice` is `flexBannerMessage`'s own sentence, reused so the editor and the print preview cannot contradict each other.

Keep the three "Add row" buttons and `RolesPanel` below the table, unchanged.

- [ ] **Step 4: Run tests**

Run: `bunx vitest run src/components/agenda/agenda-editor.test.tsx && bun run typecheck`
Expected: PASS, including every pre-existing test in that file (they assert `Row label` / `Row minutes` aria-labels, which the table's cells must keep).

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(agenda): table editor with a running clock and time budget"
```

---

## Task 7: Iteration bands

**Files:**
- Modify: `src/components/agenda/agenda-editor.tsx`
- Test: `src/components/agenda/agenda-editor.test.tsx`

**Interfaces:**
- Consumes: `EditorBand` from Task 3, the table from Task 6.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Add a repeat-block fixture and:

```ts
describe("AgendaEditor repeat blocks", () => {
	it("edits band 1 and writes the shared beat exactly once", async () => {
		const user = userEvent.setup();
		const onUpdateRow = vi.fn().mockResolvedValue(undefined);
		render(
			<AgendaEditor
				draft={contestDraft}
				{...noopHandlers}
				onUpdateRow={onUpdateRow}
			/>,
		);
		const min = screen.getByTestId("agenda-band-0-minutes-speech");
		await user.clear(min);
		await user.type(min, "5");
		await user.tab();
		await waitFor(() => expect(onUpdateRow).toHaveBeenCalledTimes(1));
		expect(onUpdateRow).toHaveBeenCalledWith("b-speech", { minutes: 5 });
	});

	it("collapses iterations 2..N and exposes no control on them", async () => {
		render(<AgendaEditor draft={contestDraft} {...noopHandlers} />);
		const rest = screen.getByTestId("agenda-band-rest");
		expect(rest).toHaveTextContent("7:18");
		expect(rest).toHaveTextContent("7:42");
		expect(
			within(rest).queryByLabelText("Row minutes"),
		).toBeNull();
	});

	it("expands iterations 2..N on request, still read-only", async () => {
		const user = userEvent.setup();
		render(<AgendaEditor draft={contestDraft} {...noopHandlers} />);
		await user.click(screen.getByRole("button", { name: /show contestants/i }));
		expect(screen.getByTestId("agenda-row-start-8")).toHaveTextContent("7:26");
		expect(screen.queryByTestId("agenda-band-1-minutes-speech")).toBeNull();
	});

	it("shows no band at a single arity", () => {
		render(<AgendaEditor draft={oneContestantDraft} {...noopHandlers} />);
		expect(screen.queryByTestId("agenda-band-rest")).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/components/agenda/agenda-editor.test.tsx`
Expected: FAIL — no `agenda-band-rest`.

- [ ] **Step 3: Implement**

Render `bands` rather than `entries`. For `kind: "row"`, the Task 6 row. For `kind: "iteration"`:

- `editable === true` (iteration 0): a band header naming the iteration and its multiplier (`CONTESTANT 1 · ×{iterationCount}`), then that iteration's rows with full controls. Each control's `onUpdateRow` targets `entry.beatId`, which is the shared beat — hence one call, not `iterationCount` calls.
- `editable === false`: collect every non-editable iteration into ONE collapsed summary row, `data-testid="agenda-band-rest"`, reading `CONTESTANT 2–{n} · {first.startsAt}–{last.endsAt} · same as ↑1 · {sum} min`, with a disclosure button labelled "Show contestants 2–{n}". Expanded, render their rows with the same Start cells and testids as ordinary rows but **no inputs** — plain text.

The collapsed default must carry the span, so no timing information is lost while collapsed.

- [ ] **Step 4: Run tests**

Run: `bunx vitest run src/components/agenda/agenda-editor.test.tsx && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(agenda): band repeated agenda rows by iteration"
```

---

## Task 8: The flex row is a computed cell with a pin

**Files:**
- Modify: `src/components/agenda/agenda-editor.tsx`
- Test: `src/components/agenda/agenda-editor.test.tsx`

**Interfaces:**
- Consumes: `RowPatch.flex` (Task 4).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

```ts
describe("AgendaEditor flex row", () => {
	const flexDraft: AgendaDraft = {
		...draft,
		lengthMinutes: 40,
		rows: [
			{ ...draft.rows[1], id: "fixed", minutes: 10, flex: false },
			{ ...draft.rows[1], id: "topics", label: "Table Topics", minutes: 10, flex: true },
		],
	};

	it("renders the flex row's minutes as computed text, not an input", () => {
		render(<AgendaEditor draft={flexDraft} {...noopHandlers} />);
		const cell = screen.getByTestId("agenda-row-minutes-1");
		// 40-minute slot minus the 10-minute fixed row.
		expect(cell).toHaveTextContent("25");
		expect(cell).toHaveTextContent(/stretches 5.25/);
		expect(within(cell).queryByRole("spinbutton")).toBeNull();
	});

	it("pinning writes flex:false and nothing else", async () => {
		const user = userEvent.setup();
		const onUpdateRow = vi.fn().mockResolvedValue(undefined);
		render(
			<AgendaEditor draft={flexDraft} {...noopHandlers} onUpdateRow={onUpdateRow} />,
		);
		await user.click(screen.getByRole("button", { name: /^pin$/i }));
		expect(onUpdateRow).toHaveBeenCalledWith("topics", { flex: false });
	});

	it("a pinned row is an ordinary editable cell with an unpin control", () => {
		const pinned: AgendaDraft = {
			...flexDraft,
			rows: flexDraft.rows.map((r) => ({ ...r, flex: false })),
		};
		render(<AgendaEditor draft={pinned} {...noopHandlers} />);
		expect(screen.getAllByLabelText("Row minutes")).toHaveLength(2);
		expect(screen.queryByRole("button", { name: /^pin$/i })).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/components/agenda/agenda-editor.test.tsx`
Expected: FAIL — the flex row still renders a number input.

- [ ] **Step 3: Implement**

In the Min cell, branch on the row's stored `flex`:

```tsx
{sourceRow.flex ? (
	<span data-testid={`agenda-row-minutes-${i}`}>
		{entry.row.minutes}
		<span className="text-muted-foreground text-xs">
			{" "}stretches {TABLE_TOPICS_MIN}–{TABLE_TOPICS_MAX}
		</span>
		<Button
			type="button"
			variant="ghost"
			size="sm"
			disabled={!editable}
			onClick={() =>
				void runAction(() => onUpdateRow(entry.beatId, { flex: false }))
			}
		>
			Pin
		</Button>
	</span>
) : (
	/* the ordinary number input from Task 6 */
)}
```

`entry.row.minutes` here is the POST-`applyFlex` value, which is the whole reason the cell cannot be an input: `applyFlex` overwrites it, so a typed value would be discarded on the next render. Import `TABLE_TOPICS_MIN` / `TABLE_TOPICS_MAX` from `#/lib/agenda-runsheet`; do not retype 5 and 25.

The reverse control is `Make stretchy`, and its gate is one expression. `schema.ts` states the rule the database does not enforce: **at most one flex beat per template.** So:

```tsx
const someRowStretches = localRows.some((r) => r.flex);
// Offered on a non-flex row only when no other row is already the stretchy
// one. Without this gate an officer can author two, which `applyFlex` then
// splits between — legal in the database, meaningless on the page.
{!sourceRow.flex && !someRowStretches ? (
	<Button
		type="button"
		variant="ghost"
		size="sm"
		disabled={!editable}
		onClick={() =>
			void runAction(() => onUpdateRow(entry.beatId, { flex: true }))
		}
	>
		Make stretchy
	</Button>
) : null}
```

A flex row shows `Pin`; a non-flex row shows `Make stretchy` when no other row holds the flag, and nothing otherwise.

- [ ] **Step 4: Run tests**

Run: `bunx vitest run src/components/agenda/agenda-editor.test.tsx && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(agenda): render the stretchy row as a computed cell with a pin"
```

---

## Task 9: Undo on row deletion

**Files:**
- Modify: `src/components/agenda/agenda-editor.tsx`
- Modify: `src/routes/club.$clubId.meeting.$meetingId_.agenda.tsx`
- Test: `src/components/agenda/agenda-editor.test.tsx`

**Interfaces:**
- Consumes: the existing `onAddRow` and `onUpdateRow` props.
- Produces: `AgendaEditorProps.onAddRow` narrows its return type from `Promise<unknown>` to `Promise<AgendaDraftRow>` — the server fn already returns the full row, the prop type merely discarded it.

- [ ] **Step 1: Write the failing test**

```ts
describe("AgendaEditor delete undo", () => {
	it("offers undo and restores every field to the original position", async () => {
		const user = userEvent.setup();
		const onRemoveRow = vi.fn().mockResolvedValue(undefined);
		const onAddRow = vi.fn().mockResolvedValue({ ...draft.rows[1], id: "new" });
		const onUpdateRow = vi.fn().mockResolvedValue(undefined);
		render(
			<AgendaEditor
				draft={draft}
				{...noopHandlers}
				onRemoveRow={onRemoveRow}
				onAddRow={onAddRow}
				onUpdateRow={onUpdateRow}
			/>,
		);
		await user.click(screen.getAllByLabelText("Remove row")[1]);
		await waitFor(() => expect(onRemoveRow).toHaveBeenCalledWith("r2"));

		await user.click(await screen.findByRole("button", { name: /undo/i }));

		// Re-inserted after its ORIGINAL predecessor, not appended.
		await waitFor(() => expect(onAddRow).toHaveBeenCalledWith("r1", "role"));
		expect(onUpdateRow).toHaveBeenCalledWith("new", {
			label: "Welcome",
			detail: null,
			minutes: 5,
			roleKey: "toastmaster",
			repeatsRoleKey: null,
			flex: false,
			markGreen: null,
			markYellow: null,
			markRed: null,
		});
	});

	it("does not confirm before deleting", async () => {
		const user = userEvent.setup();
		const onRemoveRow = vi.fn().mockResolvedValue(undefined);
		render(
			<AgendaEditor draft={draft} {...noopHandlers} onRemoveRow={onRemoveRow} />,
		);
		await user.click(screen.getAllByLabelText("Remove row")[1]);
		expect(onRemoveRow).toHaveBeenCalledTimes(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/components/agenda/agenda-editor.test.tsx`
Expected: FAIL — no undo control appears.

- [ ] **Step 3: Implement**

Capture the row and its predecessor id before deleting, then toast:

```ts
async function remove(row: AgendaDraftRow, previousId: string | null) {
	const snapshot = { ...row };
	setPending(true);
	const ok = await runAction(() => onRemoveRow(row.id));
	setPending(false);
	if (!ok) return;
	toast("Row deleted", {
		duration: 10_000,
		action: {
			label: "Undo",
			onClick: () => {
				void runAction(async () => {
					const created = await onAddRow(previousId, snapshot.kind);
					await onUpdateRow(created.id, {
						label: snapshot.label,
						detail: snapshot.detail,
						minutes: snapshot.minutes,
						roleKey: snapshot.roleKey,
						repeatsRoleKey: snapshot.repeatsRoleKey,
						flex: snapshot.flex,
						markGreen: snapshot.markGreen,
						markYellow: snapshot.markYellow,
						markRed: snapshot.markRed,
					});
				});
			},
		},
	});
}
```

Change `onAddRow`'s prop type to `(afterRowId: string | null, kind: AgendaDraftRow["kind"]) => Promise<AgendaDraftRow>` and, in the route, return the server fn's value:

```ts
onAddRow={async (afterRowId, kind) => {
	const created = await addAgendaRowFn({ data: { meetingId, afterRowId, kind } });
	await refresh();
	return created;
}}
```

- [ ] **Step 4: Run tests**

Run: `bunx vitest run src/components/agenda/agenda-editor.test.tsx && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(agenda): undo a deleted agenda row"
```

---

## Task 10: Route wiring, invalidate policy, guards and parity

**Files:**
- Modify: `src/routes/club.$clubId.meeting.$meetingId_.agenda.tsx`
- Modify: `src/routes/agenda-editor-wiring.guard.test.ts`
- Create: `src/lib/agenda-editor-parity.test.ts`
- Test: `src/server/meeting-agenda-edit-logic.integration.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

Add to `src/routes/agenda-editor-wiring.guard.test.ts`, inside the existing route describe block:

```ts
it("invalidates after STRUCTURAL mutations only", () => {
	const src = readSource(AGENDA_ROUTE);
	// Pure edits must not reload the route: the server's answer is the value
	// just sent, and re-fetching per keystroke-commit is the cost this
	// redesign removes.
	const update = src.match(/onUpdateRow=\{[\s\S]*?\n\t\t\t\t\}\}/)?.[0] ?? "";
	expect(update.length).toBeGreaterThan(0);
	expect(
		update,
		"onUpdateRow must NOT call refresh() — pure edits keep local state",
	).not.toMatch(/refresh\(\)/);
	for (const fn of ["onAddRow", "onRemoveRow", "onMoveRow", "onAddRole"]) {
		const m = src.match(new RegExp(`${fn}=\\{[\\s\\S]*?\\n\\t\\t\\t\\t\\}\\}`));
		expect(m?.[0] ?? "", `${fn} must call refresh()`).toMatch(/refresh\(\)/);
	}
});

it("passes the loader's own draft, fetched exactly once", () => {
	const src = readSource(AGENDA_ROUTE);
	// The #319 shape: a prop-fed component test cannot see a WRONG prop, and
	// a re-derived clock input would desync the editor from the print route.
	expect(src).toMatch(/draft=\{draft\}/);
	expect(src).toMatch(/const draft = Route\.useLoaderData\(\)/);
	// Counted, not pattern-matched — an earlier draft of this test ANDed two
	// regexes together, which evaluates to the second one and asserts nothing
	// about the first.
	const fetches = [...src.matchAll(/getAgendaDraft\(/g)].length;
	expect(
		fetches,
		"the loader is the only place the draft is fetched",
	).toBe(1);
});

it("returns the created row from onAddRow so undo can restore it", () => {
	const src = readSource(AGENDA_ROUTE);
	const m = src.match(/onAddRow=\{[\s\S]*?\n\t\t\t\t\}\}/)?.[0] ?? "";
	expect(m, "onAddRow must return the server fn's created row").toMatch(
		/return created/,
	);
});
```

Create `src/lib/agenda-editor-parity.test.ts`:

```ts
// The editor and the print route must compute the SAME clock. They call the
// same three functions today (agenda-editor.tsx's useAgendaModel and
// print.tsx:164-168), so this cannot fail while that holds — which is the
// point: it fails loudly the day someone forks the derivation.
//
// NOT the only guard on the clock. A parity test cannot see a defect present
// on both sides, so agenda-budget.test.ts' absolute golden assertions sit
// beside it, never instead of it.
import { describe, expect, it } from "vitest";
import { applyFlex, resolveAgendaRows } from "#/lib/agenda-runsheet";
import { buildTemplateRowsWithSource } from "#/lib/agenda-template-rows";
import { buildTimeline } from "#/lib/agenda-timing";

describe("editor / print clock parity", () => {
	it("agrees row for row on the seeded contest at four contestants", () => {
		// Build both sides from ONE fixture; see agenda-budget.test.ts for the
		// fixture's shape.
		const { beats, roles, slots, startsAt, tz, length } = contestFixture();

		const printRows = buildTimeline(
			applyFlex(
				resolveAgendaRows({
					geIntroducesFunctionaries: false,
					template: { beats, roles },
					slots,
				}),
				length,
			).rows,
			startsAt,
			tz,
		);

		const editorRows = buildTimeline(
			applyFlex(
				buildTemplateRowsWithSource(beats, roles, slots).map((e) => e.row),
				length,
			).rows,
			startsAt,
			tz,
		);

		expect(editorRows.map((r) => [r.who, r.time, r.minutes])).toEqual(
			printRows.map((r) => [r.who, r.time, r.minutes]),
		);
		expect(editorRows.length).toBe(21);
	});
});
```

Create `src/test/contest-fixture.ts` and import it from both this file and `agenda-budget.test.ts`, so the two cannot drift:

```ts
// src/test/contest-fixture.ts
//
// MCF's club contest, 2026-09-10 — the seeded `speech_contest` shape at four
// contestants. Shared by agenda-budget.test.ts and agenda-editor-parity
// .test.ts so the golden numbers (92 min, ends 8:17, 21 rows) and the parity
// assertion cannot drift apart.
import type { AgendaSlot } from "#/lib/agenda-runsheet";
import type {
	TemplateBeatRow,
	TemplateRoleRow,
} from "#/lib/agenda-template-rows";

function beat(over: Partial<TemplateBeatRow> & { id: string; sortOrder: number; label: string }): TemplateBeatRow {
	return {
		kind: "event",
		detail: null,
		minutes: 0,
		roleKey: null,
		repeatsRoleKey: null,
		flex: false,
		markGreen: null,
		markYellow: null,
		markRed: null,
		...over,
	};
}

export function contestFixture(contestants = 4) {
	const beats: TemplateBeatRow[] = [
		beat({ id: "s1", sortOrder: 0, kind: "section", label: "OPENING" }),
		beat({ id: "o1", sortOrder: 1, kind: "role", label: "Call to order", roleKey: "sergeant_at_arms", minutes: 5 }),
		beat({ id: "o2", sortOrder: 2, kind: "role", label: "Welcome and introductions", roleKey: "contest_chair", minutes: 5 }),
		beat({ id: "o3", sortOrder: 3, kind: "role", label: "Judges' briefing", roleKey: "chief_judge", minutes: 10 }),
		beat({ id: "o4", sortOrder: 4, kind: "role", label: "Contest rules and timing", roleKey: "contest_chair", minutes: 5 }),
		beat({ id: "s2", sortOrder: 5, kind: "section", label: "SPEECHES" }),
		beat({ id: "sp", sortOrder: 6, kind: "role", label: "Contest speech", roleKey: "contestant_prepared", repeatsRoleKey: "contestant_prepared", minutes: 7 }),
		beat({ id: "si", sortOrder: 7, label: "One minute of silence", repeatsRoleKey: "contestant_prepared", minutes: 1 }),
		beat({ id: "t1", sortOrder: 8, label: "Two minutes of silence", minutes: 2 }),
		beat({ id: "t2", sortOrder: 9, kind: "role", label: "Contestant interviews", roleKey: "contest_chair", minutes: 5 }),
		beat({ id: "s3", sortOrder: 10, kind: "section", label: "RESULTS AND CLOSING" }),
		beat({ id: "r1", sortOrder: 11, kind: "role", label: "Tallying", roleKey: "ballot_counter", minutes: 10 }),
		beat({ id: "r2", sortOrder: 12, kind: "role", label: "Timers' report", roleKey: "contest_timer", minutes: 3 }),
		beat({ id: "r3", sortOrder: 13, kind: "role", label: "Results and certificates", roleKey: "contest_chair", minutes: 10 }),
		beat({ id: "r4", sortOrder: 14, kind: "role", label: "Closing remarks", roleKey: "contest_chair", minutes: 5 }),
	];

	const roles: TemplateRoleRow[] = [
		{ key: "sergeant_at_arms", name: "Sergeant at Arms", isSpeakerRole: false },
		{ key: "contest_chair", name: "Contest Chair", isSpeakerRole: false },
		{ key: "chief_judge", name: "Chief Judge", isSpeakerRole: false },
		{ key: "ballot_counter", name: "Ballot Counter", isSpeakerRole: false },
		{ key: "contest_timer", name: "Contest Timer", isSpeakerRole: false },
		// The template's ONLY speaker role — see contest-template.ts.
		{ key: "contestant_prepared", name: "Contestant", isSpeakerRole: true },
	];

	const names = ["Faisal Ali", "Rehanna Khan", "Jagpal Singh", "Riyaz Mohammed"];
	const slots: AgendaSlot[] = [];
	for (const r of roles) {
		const count = r.key === "contestant_prepared" ? contestants : 1;
		for (let i = 0; i < count; i += 1) {
			slots.push({
				id: `${r.key}-${i}`,
				roleName: r.name,
				roleKey: r.key,
				category: r.isSpeakerRole ? "speaker" : "leadership",
				isSpeakerRole: r.isSpeakerRole,
				slotIndex: i,
				assigneeName: r.isSpeakerRole ? (names[i] ?? `Contestant ${i + 1}`) : r.name,
				speechTitle: null,
				projectLevel: null,
				minMinutes: null,
				maxMinutes: null,
				evaluatesSlotId: null,
				evaluates: null,
			});
		}
	}

	return {
		beats,
		roles,
		slots,
		/** 6:45 PM America/Chicago on 2026-09-10. */
		startsAt: new Date("2026-09-10T23:45:00.000Z"),
		tz: "America/Chicago",
		length: 90,
	};
}
```

Rewrite `agenda-budget.test.ts`'s hand-built `contest()` helper to derive from this fixture once Task 10 lands — run `buildTemplateRowsWithSource` + `buildTimeline` over it and map to `BudgetEntry[]`. The golden numbers must not change; if they do, one of the two was wrong.

Add the fork-translation test to the integration suite:

```ts
it("accepts a PRE-fork row id on the second pure edit", async () => {
	// D4 rests on this: the client keeps pre-fork ids until a structural edit
	// invalidates, and findRow translates by (templateId, sortOrder), exact
	// only while the copy is verbatim. Guarded by a docblock until now.
	const { meetingId } = await seedSharedTemplateMeeting();
	const before = await loadAgendaDraft(meetingId);
	const firstId = before?.rows[0]?.id ?? "";
	const secondId = before?.rows[1]?.id ?? "";

	await updateAgendaRow({ meetingId, rowId: firstId, patch: { minutes: 3 } });
	// The fork happened; `secondId` now names a row on the SOURCE template.
	await expect(
		updateAgendaRow({ meetingId, rowId: secondId, patch: { minutes: 4 } }),
	).resolves.toBeUndefined();

	const after = await loadAgendaDraft(meetingId);
	expect(after?.rows[0]?.minutes).toBe(3);
	expect(after?.rows[1]?.minutes).toBe(4);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
bunx vitest run src/routes/agenda-editor-wiring.guard.test.ts src/lib/agenda-editor-parity.test.ts
```
Expected: FAIL — the route still calls `refresh()` after `onUpdateRow`, and the parity file's fixture does not exist.

- [ ] **Step 3: Implement**

In the route, drop `await refresh()` from `onUpdateRow` only. Keep it in `onAddRow`, `onRemoveRow`, `onMoveRow`, `onAddRole` and `onRemoveRole`. Return `created` from `onAddRow`. Create `src/test/contest-fixture.ts` exporting `contestFixture()`.

- [ ] **Step 4: Run the whole suite**

Run:
```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" bun run test
bun run typecheck
bunx biome check --diagnostic-level=error
```
Expected: all PASS. If the integration suites report SKIPPED, the DB URL is wrong — fix it, a skip is not a pass. Chrome-backed suites skip on macOS unless `CHROME_PATH` points at a Playwright `chrome-headless-shell`; that is expected here and unrelated to this change.

- [ ] **Step 5: Commit**

```bash
git add -u
git add src/lib/agenda-editor-parity.test.ts src/test/contest-fixture.ts
git commit -m "feat(agenda): wire the table editor and guard its clock parity"
```

---

## Self-Review

**Spec coverage.** Every Phase 1 decision maps to a task: D1 → Tasks 1, 6, 10 (parity); D2 → Task 6's client-side model; D3 → Tasks 1, 3, 7; D4 → Tasks 6, 10; D5 → Tasks 3, 6; D6 → Task 8; D7 → Tasks 4, 5; D8 → Task 9; D9 → Task 3. The spec's twelve testing requirements each appear as a named test above.

**One gap the spec did not name,** now Task 1: `buildTemplateRows` returns `AgendaRow[]` with no beat id and no iteration index, so the table could not address a beat or band by iteration. Fold this back into the spec if it is revised.

**Deliberately out of scope**, per the spec: standard-meeting editing, save-as-template, drag-to-reorder, fit-to-slot, and any change to what prints.

**Not verified by me and worth checking first in Task 5:** the name of the existing slot loader the meeting page uses. The plan says to grep for it rather than guessing, because inventing a second slot query is exactly the kind of divergence D1 exists to prevent.
