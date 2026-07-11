# Squishy Table Topics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Table Topics segment expand/contract so a meeting lands exactly on its target duration (`meetings.lengthMinutes`), clamped to a floor/ceiling, with an honest over/under warning when the target is unachievable.

**Architecture:** All timing is *derived at render time, never stored*. A pure function `applyFlex` takes the expanded run-of-show rows plus the target duration and replaces the Table Topics row's minutes with `clamp(target − everythingElse, MIN, MAX)`. The flex row is identified by a `flex` marker set on it by `expandRunSheet` (driven by a `flex` flag on the template beat), so no role-name string matching is needed. Two surfaces consume it: the print/run-of-show route and the meeting detail view.

**Tech Stack:** TypeScript (strict), React 19 / TanStack Start, Vitest. All new logic lives in `src/lib/agenda-runsheet.ts` (pure, unit-tested); two route files wire it in.

**Spec:** `docs/superpowers/specs/2026-07-10-squishy-table-topics-design.md`

**Constants (final):** `TABLE_TOPICS_MIN = 5`, `TABLE_TOPICS_MAX = 25`, `FLEX_TOLERANCE_MINUTES = 2`.

---

## File structure

- **`src/lib/agenda-runsheet.ts`** (modify) — add `flex?: true` to `Beat`, set it on the Table Topics Master beat; add `flex?: boolean` to `AgendaRow`; have `expandRunSheet` mark the flex row; add the three constants and the `applyFlex` function + `FlexResult`/`FlexStatus` types.
- **`src/lib/agenda-runsheet.test.ts`** (modify) — tests for the flex marker and `applyFlex`.
- **`src/routes/club.$clubId_.meeting.$meetingId.print.tsx`** (modify) — run `applyFlex`, use flexed rows + projected end, add a screen-only warning.
- **`src/routes/club.$clubId.meeting.$meetingId.tsx`** (modify) — run `applyFlex` in the component, render a projected-end warning line near the time range.

Tasks 1–2 are pure logic (TDD). Tasks 3–4 are route wiring, verified by `bun run typecheck` and a described manual dev-server check (the repo does not unit-test route components; the flex math they call is fully covered by Tasks 1–2).

---

## Task 1: Mark the flex row in the run-of-show

**Files:**
- Modify: `src/lib/agenda-runsheet.ts` (the `Beat` type ~L50-58, the Table Topics Master beat ~L118-124, the `AgendaRow` type ~L39-44, and `expandRunSheet` ~L195-273)
- Test: `src/lib/agenda-runsheet.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/agenda-runsheet.test.ts`:

```ts
describe("expandRunSheet flex marker", () => {
	it("marks exactly one row — the Table Topics row — as flex", () => {
		const rows = expandRunSheet([]);
		const flexed = rows.filter((r) => r.flex === true);
		expect(flexed).toHaveLength(1);
		expect(flexed[0].who).toContain("Table Topics");
	});

	it("does not mark any row when the template has no flex beat", () => {
		const noFlex = RUN_OF_SHOW.map((b) => ({ ...b, flex: undefined }));
		const rows = expandRunSheet([], noFlex);
		expect(rows.some((r) => r.flex === true)).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/agenda-runsheet.test.ts -t "flex marker"`
Expected: FAIL — `r.flex` is not a known property / no row is marked.

- [ ] **Step 3: Add `flex` to the `Beat` type**

In `src/lib/agenda-runsheet.ts`, replace the `Beat` type:

```ts
/** A beat in the standard run-of-show. `flex` marks the single squishy beat. */
export type Beat = (
	| { kind: "event"; who: string; detail: string; minutes: number }
	| {
			kind: "role";
			roleName: string;
			role: "plain" | "speaker" | "evaluator";
			detail: string;
			minutes: number;
	  }
) & { flex?: true };
```

- [ ] **Step 4: Add `flex` to `AgendaRow`**

Replace the `AgendaRow` type:

```ts
/** One rendered agenda row (no clock time yet — buildTimeline adds it). */
export type AgendaRow = {
	who: string; // "Speaker 1 · Rehanna Khan", "Sergeant-at-Arms", "Timer"
	detail: string;
	minutes: number; // duration this row contributes to the running clock
	marks: TimingMarks | null;
	/** True on the single squishy row (Table Topics). `applyFlex` resizes it. */
	flex?: boolean;
};
```

- [ ] **Step 5: Flag the Table Topics Master beat**

In `RUN_OF_SHOW`, add `flex: true` to the Table Topics Master beat:

```ts
	{
		kind: "role",
		roleName: "Table Topics Master",
		role: "plain",
		detail: "Impromptu topics using the Word of the Day",
		minutes: 10,
		flex: true,
	},
```

- [ ] **Step 6: Mark the first row produced by the flex beat**

Rewrite `expandRunSheet` so the loop records the row index where each beat starts and marks the first row of the flex beat. Replace the whole function body:

```ts
export function expandRunSheet(
	slots: AgendaSlot[],
	template: Beat[] = RUN_OF_SHOW,
): AgendaRow[] {
	const rows: AgendaRow[] = [];
	const byRole = (name: string) =>
		slots.filter((s) => s.roleName.toLowerCase() === name.toLowerCase());

	for (const beat of template) {
		const startLen = rows.length;

		if (beat.kind === "event") {
			rows.push({
				who: beat.who,
				detail: beat.detail,
				minutes: beat.minutes,
				marks: null,
			});
		} else {
			const matching = byRole(beat.roleName);

			if (beat.role === "speaker") {
				const ordered = [...matching].sort(
					(a, b) => a.slotIndex - b.slotIndex,
				);
				const multi = ordered.length > 1;
				ordered.forEach((s, i) => {
					const marks =
						s.minMinutes != null && s.maxMinutes != null
							? {
									green: s.minMinutes,
									yellow: (s.minMinutes + s.maxMinutes) / 2,
									red: s.maxMinutes,
								}
							: null;
					const detail = s.speechTitle
						? `"${s.speechTitle}"${s.projectLevel ? ` · ${s.projectLevel}` : ""}`
						: beat.detail;
					rows.push({
						who: `${numbered(beat.roleName, i, multi)} · ${assigneeDisplay(s)}`,
						detail,
						minutes: s.maxMinutes ?? DEFAULT_SPEAKER_MINUTES,
						marks,
					});
				});
			} else if (beat.role === "evaluator") {
				const ordered = orderEvaluators(matching, slots);
				const multi = ordered.length > 1;
				ordered.forEach((s, i) => {
					rows.push({
						who: `${numbered(beat.roleName, i, multi)} · ${assigneeDisplay(s)}`,
						detail: s.evaluates?.speakerName
							? `Evaluates ${s.evaluates.speakerName}`
							: beat.detail,
						minutes: beat.minutes,
						marks: null,
					});
				});
			} else if (matching.length === 0) {
				// plain role, missing: degrade to a label-only row.
				rows.push({
					who: beat.roleName,
					detail: beat.detail,
					minutes: beat.minutes,
					marks: null,
				});
			} else {
				for (const s of matching) {
					rows.push({
						who: `${beat.roleName} · ${assigneeDisplay(s)}`,
						detail: beat.detail,
						minutes: beat.minutes,
						marks: null,
					});
				}
			}
		}

		// Mark the first row this beat produced as the squishy one.
		if (beat.flex && rows.length > startLen) {
			rows[startLen] = { ...rows[startLen], flex: true };
		}
	}
	return rows;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bunx vitest run src/lib/agenda-runsheet.test.ts -t "flex marker"`
Expected: PASS (both cases).

- [ ] **Step 8: Run the full runsheet test file + typecheck**

Run: `bunx vitest run src/lib/agenda-runsheet.test.ts && bun run typecheck`
Expected: all existing tests still PASS; typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add src/lib/agenda-runsheet.ts src/lib/agenda-runsheet.test.ts
git commit -m "feat(agenda): mark Table Topics as the squishy run-of-show row"
```

---

## Task 2: `applyFlex` — resize Table Topics to hit the target

**Files:**
- Modify: `src/lib/agenda-runsheet.ts` (add constants + `FlexStatus`/`FlexResult` types + `applyFlex`, near the other exported helpers)
- Test: `src/lib/agenda-runsheet.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/agenda-runsheet.test.ts`:

```ts
describe("applyFlex", () => {
	// Helper: build rows with a marked flex row of `flexMin`, plus `fixed` fixed minutes.
	function rowsFixture(fixed: number, flexMin: number): AgendaRow[] {
		return [
			{ who: "Fixed", detail: "", minutes: fixed, marks: null },
			{ who: "Table Topics", detail: "", minutes: flexMin, marks: null, flex: true },
		];
	}

	it("fills exactly when the remainder is within bounds", () => {
		const res = applyFlex(rowsFixture(50, 10), 63); // wants 13
		expect(res.rows[1].minutes).toBe(13);
		expect(res.projectedMinutes).toBe(63);
		expect(res.status).toBe("exact");
		expect(res.deltaMinutes).toBe(0);
	});

	it("clamps to MAX and reports under when there is too much slack", () => {
		const res = applyFlex(rowsFixture(40, 10), 90); // wants 50, capped at 25
		expect(res.rows[1].minutes).toBe(TABLE_TOPICS_MAX);
		expect(res.projectedMinutes).toBe(65);
		expect(res.status).toBe("under");
		expect(res.deltaMinutes).toBe(-25);
	});

	it("clamps to MIN and reports over when there is too little slack", () => {
		const res = applyFlex(rowsFixture(58, 10), 60); // wants 2, floored at 5
		expect(res.rows[1].minutes).toBe(TABLE_TOPICS_MIN);
		expect(res.projectedMinutes).toBe(63);
		expect(res.status).toBe("over");
		expect(res.deltaMinutes).toBe(3);
	});

	it("treats a sub-tolerance clamp miss as exact (no banner) but still reports the true delta", () => {
		const res = applyFlex(rowsFixture(57, 10), 60); // wants 3, floored at 5 -> +2
		expect(res.rows[1].minutes).toBe(TABLE_TOPICS_MIN);
		expect(res.deltaMinutes).toBe(2);
		expect(res.status).toBe("exact"); // |2| <= FLEX_TOLERANCE_MINUTES
	});

	it("does not flex when no row is marked; status reflects the real over/under", () => {
		const rows: AgendaRow[] = [
			{ who: "A", detail: "", minutes: 50, marks: null },
			{ who: "B", detail: "", minutes: 20, marks: null },
		];
		const res = applyFlex(rows, 60); // 70 total, no flex row -> +10
		expect(res.projectedMinutes).toBe(70);
		expect(res.status).toBe("over");
		expect(res.deltaMinutes).toBe(10);
		expect(res.rows).toEqual(rows); // unchanged
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run src/lib/agenda-runsheet.test.ts -t "applyFlex"`
Expected: FAIL — `applyFlex`, `TABLE_TOPICS_MIN`, `TABLE_TOPICS_MAX` are not defined.

- [ ] **Step 3: Add the constants**

In `src/lib/agenda-runsheet.ts`, next to `DEFAULT_SPEAKER_MINUTES`:

```ts
/** Squishy Table Topics bounds (minutes) and the on-time banner deadband. */
export const TABLE_TOPICS_MIN = 5;
export const TABLE_TOPICS_MAX = 25;
export const FLEX_TOLERANCE_MINUTES = 2;
```

- [ ] **Step 4: Add the types and `applyFlex`**

Append to `src/lib/agenda-runsheet.ts`:

```ts
export type FlexStatus = "exact" | "over" | "under";

export type FlexResult = {
	/** Rows with the flex row's `minutes` replaced by the clamped value. */
	rows: AgendaRow[];
	/** Actual total after clamping (= start-to-end meeting length). */
	projectedMinutes: number;
	/** Banner status, AFTER the deadband. */
	status: FlexStatus;
	/** True signed delta: +5 = runs 5 min long, −5 = ends 5 min early. */
	deltaMinutes: number;
};

/**
 * Resize the single `flex`-marked row (Table Topics) so the run-of-show totals
 * `targetMinutes`, clamped to [TABLE_TOPICS_MIN, TABLE_TOPICS_MAX]. The flex row
 * absorbs the exact remainder, so `deltaMinutes` is nonzero only when clamping
 * makes the target unreachable. `status` applies the ±FLEX_TOLERANCE_MINUTES
 * deadband to gate the banner; the computed duration is never deadbanded.
 */
export function applyFlex(
	rows: AgendaRow[],
	targetMinutes: number,
): FlexResult {
	const total = rows.reduce((sum, r) => sum + r.minutes, 0);
	const flexIndex = rows.findIndex((r) => r.flex === true);

	let out = rows;
	let projectedMinutes = total;

	if (flexIndex !== -1) {
		const fixed = total - rows[flexIndex].minutes;
		const flexMinutes = Math.min(
			TABLE_TOPICS_MAX,
			Math.max(TABLE_TOPICS_MIN, targetMinutes - fixed),
		);
		out = rows.map((r, i) =>
			i === flexIndex ? { ...r, minutes: flexMinutes } : r,
		);
		projectedMinutes = fixed + flexMinutes;
	}

	const deltaMinutes = projectedMinutes - targetMinutes;
	const status: FlexStatus =
		Math.abs(deltaMinutes) <= FLEX_TOLERANCE_MINUTES
			? "exact"
			: deltaMinutes > 0
				? "over"
				: "under";

	return { rows: out, projectedMinutes, status, deltaMinutes };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run src/lib/agenda-runsheet.test.ts -t "applyFlex"`
Expected: PASS (all five cases).

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/agenda-runsheet.ts src/lib/agenda-runsheet.test.ts
git commit -m "feat(agenda): applyFlex resizes Table Topics to hit target duration"
```

---

## Task 3: Wire flex into the print / run-of-show route

**Files:**
- Modify: `src/routes/club.$clubId_.meeting.$meetingId.print.tsx` (imports ~L11, derivation ~L79-85, JSX ~L160)

- [ ] **Step 1: Import `applyFlex`**

Change the existing import from `#/lib/agenda-runsheet` to add `applyFlex`:

```ts
import { applyFlex, expandRunSheet } from "#/lib/agenda-runsheet";
```

- [ ] **Step 2: Apply flex and derive the projected end**

Replace lines ~79-85 (the `runRows` / `rows` / `totalMinutes` / `endsAt` block):

```ts
	const runRows = expandRunSheet(slots);
	const flex = applyFlex(runRows, meeting.lengthMinutes);
	const rows = buildTimeline(flex.rows, meeting.scheduledAt, timezone);

	// Meeting end = start + the flexed (projected) run-of-show length.
	const startsAt = new Date(meeting.scheduledAt);
	const endsAt = new Date(startsAt.getTime() + flex.projectedMinutes * 60_000);
```

(Removes the old `totalMinutes` const — `flex.projectedMinutes` replaces it. `header.timeRange` already uses `endsAt`, so the printed range now shows the projected end.)

- [ ] **Step 3: Add a screen-only warning under the toolbar**

Insert immediately after the toolbar `</div>` at ~L160 (before the `<style>` tag). Screen-only (`no-print`) so the physical handout stays clean; the honest end time is already in the header range:

```tsx
			{flex.status !== "exact" ? (
				<div
					className="no-print"
					style={{
						margin: "8px auto 0",
						maxWidth: 640,
						padding: "8px 12px",
						borderRadius: 8,
						fontSize: 13,
						textAlign: "center",
						background: flex.status === "over" ? "#fbeaea" : "#eef2f7",
						color: flex.status === "over" ? "#8a1c1c" : "#41546b",
					}}
				>
					{flex.status === "over"
						? `Agenda runs ${flex.deltaMinutes} min long — Table Topics is at its ${TABLE_TOPICS_MIN}-min floor. Trim a speech or shorten the agenda.`
						: `Agenda ends ${-flex.deltaMinutes} min early — Table Topics is at its ${TABLE_TOPICS_MAX}-min cap.`}
				</div>
			) : null}
```

- [ ] **Step 4: Import the bound constants used in the copy**

Extend the import from Step 1:

```ts
import {
	applyFlex,
	expandRunSheet,
	TABLE_TOPICS_MAX,
	TABLE_TOPICS_MIN,
} from "#/lib/agenda-runsheet";
```

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: clean (no unused imports — both constants are used in the banner copy).

- [ ] **Step 6: Manual verification**

Run: `bun run dev`, then open a meeting's print view: `http://localhost:3000/club/<clubId>/meeting/<meetingId>/print`.
Expected:
- The Table Topics row shows a resized duration (not a fixed 10) and the header time range ends at start + projected length.
- Seed/adjust a meeting with a very light agenda (few speakers) → an "ends early" info banner appears on screen; a heavy agenda in a short meeting → a red "runs long" banner. Neither appears in the browser Print preview.

- [ ] **Step 7: Commit**

```bash
git add "src/routes/club.\$clubId_.meeting.\$meetingId.print.tsx"
git commit -m "feat(agenda): print run-of-show flexes Table Topics to target length"
```

---

## Task 4: Surface the flex warning on the meeting detail view

**Files:**
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx` (imports, component body, JSX near the time range ~L248)

- [ ] **Step 1: Add imports**

Add near the existing `#/lib/agenda-runsheet` / `#/lib/format` imports (create the runsheet import if absent):

```ts
import { applyFlex, expandRunSheet } from "#/lib/agenda-runsheet";
import { formatMeetingDate, formatMeetingTime, formatMeetingTimeRange } from "#/lib/format";
```

(If `formatMeetingDate` / `formatMeetingTimeRange` are already imported from `#/lib/format`, just add `formatMeetingTime` to that existing import instead of duplicating it.)

- [ ] **Step 2: Compute flex in the component body**

After the loader data is destructured (the `const { meeting, slots, timezone, ... } = Route.useLoaderData();` block, ~L123-130), add:

```ts
	const flex = applyFlex(
		expandRunSheet(slots),
		meeting.lengthMinutes,
	);
	const projectedEnd = new Date(
		new Date(meeting.scheduledAt).getTime() + flex.projectedMinutes * 60_000,
	);
```

- [ ] **Step 3: Render the warning line under the time range**

Immediately after the closing `</span>` of the date/time-range `<span>` (the block ending ~L248, right before the `{meeting.location ? ...}` span), add:

```tsx
						{flex.status !== "exact" ? (
							<span
								className={
									flex.status === "over"
										? "flex items-center gap-1.5 font-medium text-destructive"
										: "flex items-center gap-1.5 text-muted-foreground"
								}
							>
								<Clock className="size-4" aria-hidden />
								{flex.status === "over"
									? `Projected end ${formatMeetingTime(projectedEnd, timezone)} · runs ${flex.deltaMinutes} min long`
									: `Projected end ${formatMeetingTime(projectedEnd, timezone)} · ends ${-flex.deltaMinutes} min early`}
							</span>
						) : null}
```

- [ ] **Step 4: Ensure the `Clock` icon is imported**

Confirm `Clock` is in the `lucide-react` import at the top of the file; if not, add it:

```ts
import { CalendarDays, Clock, Lock, MapPin, Sparkles } from "lucide-react";
```

(Match the existing icon import — add only `Clock` if the others are already there.)

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 6: Manual verification**

Run: `bun run dev`, open a meeting detail page: `http://localhost:3000/club/<clubId>/meeting/<meetingId>`.
Expected:
- The advertised time range (e.g. "6:45 – 8:15") is unchanged for a normal meeting, and no extra line appears (`status: "exact"`).
- On a light-agenda meeting the "Projected end … · ends N min early" muted line appears; on an overloaded short meeting a red "runs N min long" line appears — matching the print view's banner for the same meeting.

- [ ] **Step 7: Full check + commit**

Run: `bun run check && bun run typecheck && bunx vitest run src/lib/agenda-runsheet.test.ts`
Expected: all green.

```bash
git add "src/routes/club.\$clubId.meeting.\$meetingId.tsx"
git commit -m "feat(agenda): show projected-end flex warning on meeting detail view"
```

---

## Self-review notes (coverage map)

- Spec §"Solution overview" / exact-end property → Task 2 `applyFlex` (exact-fill test asserts `projectedMinutes === target`).
- Spec decision 1 (clamp+warn) → Task 2 clamp tests + Tasks 3/4 banners.
- Spec decision 2 (hardcoded constants) → Task 2 Step 3.
- Spec decision 3 (derived, not stored) → no schema/migration in any task.
- Spec decision 4 (no-flex branch) → Task 2 "no row marked" test (unreachable in v1 UI, but covered).
- Spec decision 5 (basis = speaker max) → reuses existing `expandRunSheet` row minutes (unchanged in Task 1).
- Spec decision 6 (directional severity) → Tasks 3/4 use alarm styling for `over`, neutral for `under`.
- Spec decision 7 (±2 deadband, banner-only) → Task 2 deadband test + `status` logic; duration still exact.
- Spec decision 8 (non-round segment) → Task 2 exact-fill returns 13, rendered as-is.
- Spec §Surfaces (print + detail) → Tasks 3 and 4; present deck untouched (out of scope).
