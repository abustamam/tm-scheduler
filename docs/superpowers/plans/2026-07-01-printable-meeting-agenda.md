# Printable Meeting Agenda Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a printable club meeting agenda in the on-brand "timing" layout by weaving a meeting's assigned role slots into a hardcoded standard run-of-show, rendered as a print-optimized React page.

**Architecture:** Two pure libs — `agenda-runsheet.ts` (a `RUN_OF_SHOW` template constant + `expandRunSheet`/`buildLegend`) and `agenda-timing.ts` (`buildTimeline`, running clock) — feed a presentational `MeetingAgendaPrint` component behind a public print route. No schema change: the template owns beat durations; speakers override with `maxMinutes`. See spec: `docs/superpowers/specs/2026-07-01-printable-meeting-agenda-design.md`.

**Tech Stack:** TanStack Start (React 19, file routing), Vitest, TypeScript strict, Biome (tabs + double quotes). Package manager: Bun (`bun run test`, `bun run check`, `bun run build`).

---

## File Structure

- **Create** `src/lib/agenda-runsheet.ts` — `RUN_OF_SHOW` template, types, `expandRunSheet`, `buildLegend`. Pure (no `#/db`).
- **Create** `src/lib/agenda-runsheet.test.ts` — Vitest.
- **Create** `src/lib/agenda-timing.ts` — `buildTimeline` + clock formatting. Pure.
- **Create** `src/lib/agenda-timing.test.ts` — Vitest.
- **Modify** `src/server/meetings.ts` — add club `name` to `loadMeetingDetail`'s return.
- **Create** `src/components/agenda/meeting-agenda-print.tsx` — presentational timing layout + legend + layout stubs.
- **Create** `src/routes/club.$clubId.meeting.$meetingId.print.tsx` — public print route.
- **Modify** `src/routes/club.$clubId.meeting.$meetingId.tsx` — add a "Print agenda" button.

Conventions: import alias `#/*` → `src/*`. Biome uses **tabs** and **double quotes**; run `bun run check` before committing. Tests use `import { describe, expect, it } from "vitest"`.

---

## Task 1: Runsheet types + `RUN_OF_SHOW` template

**Files:**
- Create: `src/lib/agenda-runsheet.ts`
- Test: `src/lib/agenda-runsheet.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/agenda-runsheet.test.ts
import { describe, expect, it } from "vitest";
import { RUN_OF_SHOW } from "./agenda-runsheet";

describe("RUN_OF_SHOW template", () => {
	it("is an ordered list of 13 beats", () => {
		expect(RUN_OF_SHOW).toHaveLength(13);
	});

	it("every beat has a positive duration", () => {
		for (const beat of RUN_OF_SHOW) {
			expect(beat.minutes).toBeGreaterThan(0);
		}
	});

	it("role beats reference the club's standard role names", () => {
		const roleNames = RUN_OF_SHOW.filter((b) => b.kind === "role").map(
			(b) => (b as { roleName: string }).roleName,
		);
		expect(roleNames).toContain("Toastmaster of the Day");
		expect(roleNames).toContain("Speaker");
		expect(roleNames).toContain("Evaluator");
		expect(roleNames).toContain("Table Topics Master");
		expect(roleNames).toContain("General Evaluator");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/agenda-runsheet.test.ts`
Expected: FAIL — cannot find module `./agenda-runsheet` / `RUN_OF_SHOW` is not exported.

- [ ] **Step 3: Write the types + template constant**

```typescript
// src/lib/agenda-runsheet.ts

/** Green/yellow/red timer-card marks, in minutes (e.g. 5, 6, 7). */
export type TimingMarks = { green: number; yellow: number; red: number };

/**
 * The minimal slot shape the run-of-show needs. The real slots returned by
 * `loadMeetingDetail` (src/server/meetings.ts) structurally satisfy this.
 */
export type AgendaSlot = {
	id: string;
	roleName: string;
	category: string;
	isSpeakerRole: boolean;
	slotIndex: number;
	assigneeName: string | null;
	speechTitle: string | null;
	projectLevel: string | null;
	minMinutes: number | null;
	maxMinutes: number | null;
	evaluatesSlotId: string | null;
	evaluates: { speakerName: string | null } | null;
};

/** One rendered agenda row (no clock time yet — buildTimeline adds it). */
export type AgendaRow = {
	who: string; // "Speaker 1 · Rehanna Khan", "Sergeant-at-Arms", "Timer"
	detail: string;
	minutes: number; // duration this row contributes to the running clock
	marks: TimingMarks | null;
};

/** A functionary/uncovered role shown in the header legend. */
export type LegendEntry = { role: string; name: string };

/** A beat in the standard run-of-show. */
export type Beat =
	| { kind: "event"; who: string; detail: string; minutes: number }
	| {
			kind: "role";
			roleName: string;
			role: "plain" | "speaker" | "evaluator";
			detail: string;
			minutes: number;
	  };

/** Fallback speaker duration when a speaker slot has no maxMinutes. */
export const DEFAULT_SPEAKER_MINUTES = 7;

/** Placeholder shown for an open (unassigned) slot. */
export const OPEN_LABEL = "— open —";

/**
 * The single hardcoded standard Toastmasters run-of-show for v1. Durations are
 * tunable constants approximating templates/meeting-agenda/MeetingAgenda.dc.html.
 * Per-club configurable templates are a deferred issue.
 */
export const RUN_OF_SHOW: Beat[] = [
	{ kind: "event", who: "Sergeant-at-Arms", detail: "Call to Order · phones silent, exits noted", minutes: 1 },
	{ kind: "event", who: "President", detail: "Opening remarks; welcomes guests", minutes: 1 },
	{ kind: "role", roleName: "Toastmaster of the Day", role: "plain", detail: "Opens meeting · introduces theme & GE", minutes: 3 },
	{ kind: "role", roleName: "General Evaluator", role: "plain", detail: "Introduces evaluation team · Grammarian shares Word of the Day", minutes: 5 },
	{ kind: "role", roleName: "Speaker", role: "speaker", detail: "Prepared speech", minutes: DEFAULT_SPEAKER_MINUTES },
	{ kind: "event", who: "Timer", detail: "Timer's report · vote Best Speaker", minutes: 1 },
	{ kind: "role", roleName: "Table Topics Master", role: "plain", detail: "Impromptu topics using the Word of the Day", minutes: 10 },
	{ kind: "event", who: "Timer", detail: "Timer's report · vote Best Table Topics", minutes: 1 },
	{ kind: "role", roleName: "Evaluator", role: "evaluator", detail: "Evaluates a speaker", minutes: 3 },
	{ kind: "event", who: "Timer", detail: "Timer's report · vote Best Evaluator", minutes: 1 },
	{ kind: "role", roleName: "General Evaluator", role: "plain", detail: "Grammarian, Ah-Counter & Timer reports · overall feedback", minutes: 7 },
	{ kind: "event", who: "Toastmaster", detail: "Awards · Best Table Topic, Evaluator & Speaker", minutes: 2 },
	{ kind: "event", who: "President", detail: "Club business · elections, guest comments · adjourn", minutes: 3 },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/lib/agenda-runsheet.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda-runsheet.ts src/lib/agenda-runsheet.test.ts
git commit -m "feat(agenda): run-of-show template constant + types"
```

---

## Task 2: `buildLegend` — functionary roles

**Files:**
- Modify: `src/lib/agenda-runsheet.ts`
- Test: `src/lib/agenda-runsheet.test.ts`

- [ ] **Step 1: Write the failing test** (append to the test file)

```typescript
import { buildLegend } from "./agenda-runsheet";
import type { AgendaSlot } from "./agenda-runsheet";

function slot(over: Partial<AgendaSlot>): AgendaSlot {
	return {
		id: "s", roleName: "Timer", category: "functionary", isSpeakerRole: false,
		slotIndex: 0, assigneeName: null, speechTitle: null, projectLevel: null,
		minMinutes: null, maxMinutes: null, evaluatesSlotId: null, evaluates: null,
		...over,
	};
}

describe("buildLegend", () => {
	it("lists functionary roles with their assignees, in input order", () => {
		const slots = [
			slot({ id: "t", roleName: "Timer", assigneeName: "Alice" }),
			slot({ id: "g", roleName: "Grammarian", assigneeName: "Bob" }),
			slot({ id: "sp", roleName: "Speaker", category: "speaker", isSpeakerRole: true, assigneeName: "Cara" }),
		];
		expect(buildLegend(slots)).toEqual([
			{ role: "Timer", name: "Alice" },
			{ role: "Grammarian", name: "Bob" },
		]);
	});

	it("shows the open placeholder for an unassigned functionary", () => {
		expect(buildLegend([slot({ roleName: "Ah-Counter", assigneeName: null })])).toEqual([
			{ role: "Ah-Counter", name: "— open —" },
		]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/agenda-runsheet.test.ts`
Expected: FAIL — `buildLegend` is not exported.

- [ ] **Step 3: Implement `buildLegend`** (append to `agenda-runsheet.ts`)

```typescript
/** Functionary-category roles for the header legend (Timer, Ah-Counter, Grammarian…). */
export function buildLegend(slots: AgendaSlot[]): LegendEntry[] {
	return slots
		.filter((s) => s.category === "functionary")
		.map((s) => ({ role: s.roleName, name: s.assigneeName ?? OPEN_LABEL }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/lib/agenda-runsheet.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda-runsheet.ts src/lib/agenda-runsheet.test.ts
git commit -m "feat(agenda): buildLegend for functionary roles"
```

---

## Task 3: `expandRunSheet` — weave slots into beats

**Files:**
- Modify: `src/lib/agenda-runsheet.ts`
- Test: `src/lib/agenda-runsheet.test.ts`

- [ ] **Step 1: Write the failing tests** (append; reuses the `slot` helper from Task 2)

```typescript
import { expandRunSheet, RUN_OF_SHOW } from "./agenda-runsheet";

describe("expandRunSheet", () => {
	it("passes event beats through as label-only rows (no marks)", () => {
		const rows = expandRunSheet([]);
		const callToOrder = rows[0];
		expect(callToOrder.who).toBe("Sergeant-at-Arms");
		expect(callToOrder.marks).toBeNull();
		expect(callToOrder.minutes).toBe(1);
	});

	it("event beats always render even with no slots", () => {
		const rows = expandRunSheet([]);
		// 6 event beats in the template render regardless of assignees.
		expect(rows.filter((r) => r.who === "Timer").length).toBe(3);
	});

	it("renders a plain role with its assignee name", () => {
		const rows = expandRunSheet([
			slot({ roleName: "Toastmaster of the Day", category: "leadership", assigneeName: "Dana" }),
		]);
		expect(rows.some((r) => r.who === "Toastmaster of the Day · Dana")).toBe(true);
	});

	it("renders a missing plain role as a label-only row (graceful)", () => {
		const rows = expandRunSheet([]); // no Toastmaster slot
		expect(rows.some((r) => r.who === "Toastmaster of the Day")).toBe(true);
	});

	it("expands speakers by actual slots, numbering when >1, with marks from min/max and duration from max", () => {
		const rows = expandRunSheet([
			slot({ id: "s1", roleName: "Speaker", category: "speaker", isSpeakerRole: true, slotIndex: 0, assigneeName: "Rehanna", speechTitle: "Chai", projectLevel: "L2", minMinutes: 5, maxMinutes: 7 }),
			slot({ id: "s2", roleName: "Speaker", category: "speaker", isSpeakerRole: true, slotIndex: 1, assigneeName: "Sudheer", speechTitle: "Clubs", projectLevel: "L4", minMinutes: 5, maxMinutes: 7 }),
		]);
		const sp1 = rows.find((r) => r.who.startsWith("Speaker 1"));
		expect(sp1?.who).toBe("Speaker 1 · Rehanna");
		expect(sp1?.detail).toBe('"Chai" · L2');
		expect(sp1?.minutes).toBe(7);
		expect(sp1?.marks).toEqual({ green: 5, yellow: 6, red: 7 });
		expect(rows.some((r) => r.who === "Speaker 2 · Sudheer")).toBe(true);
	});

	it("uses the open placeholder and fallback duration for an open speaker with no details", () => {
		const rows = expandRunSheet([
			slot({ roleName: "Speaker", category: "speaker", isSpeakerRole: true, assigneeName: null }),
		]);
		const sp = rows.find((r) => r.who.startsWith("Speaker"));
		expect(sp?.who).toBe("Speaker · — open —");
		expect(sp?.minutes).toBe(7);
		expect(sp?.marks).toBeNull();
	});

	it("orders evaluators by the speaker they evaluate and labels 'Evaluates X'", () => {
		const slots = [
			slot({ id: "spA", roleName: "Speaker", category: "speaker", isSpeakerRole: true, slotIndex: 0, assigneeName: "A" }),
			slot({ id: "spB", roleName: "Speaker", category: "speaker", isSpeakerRole: true, slotIndex: 1, assigneeName: "B" }),
			// Evaluator slots given OUT of speaker order; expansion must reorder.
			slot({ id: "e2", roleName: "Evaluator", category: "evaluator", slotIndex: 0, assigneeName: "EvalB", evaluatesSlotId: "spB", evaluates: { speakerName: "B" } }),
			slot({ id: "e1", roleName: "Evaluator", category: "evaluator", slotIndex: 1, assigneeName: "EvalA", evaluatesSlotId: "spA", evaluates: { speakerName: "A" } }),
		];
		const rows = expandRunSheet(slots);
		const evalRows = rows.filter((r) => r.who.startsWith("Evaluator"));
		expect(evalRows[0].who).toBe("Evaluator 1 · EvalA");
		expect(evalRows[0].detail).toBe("Evaluates A");
		expect(evalRows[1].who).toBe("Evaluator 2 · EvalB");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/agenda-runsheet.test.ts`
Expected: FAIL — `expandRunSheet` is not exported.

- [ ] **Step 3: Implement `expandRunSheet`** (append to `agenda-runsheet.ts`)

```typescript
/** "Speaker 1" when the role repeats this meeting, else "Speaker". */
function numbered(roleName: string, index: number, multi: boolean): string {
	return multi ? `${roleName} ${index + 1}` : roleName;
}

/** Order evaluator slots by the position of the speaker each evaluates. */
function orderEvaluators(evaluators: AgendaSlot[], allSlots: AgendaSlot[]): AgendaSlot[] {
	const speakerPos = new Map<string, number>();
	allSlots
		.filter((s) => s.isSpeakerRole)
		.sort((a, b) => a.slotIndex - b.slotIndex)
		.forEach((s, i) => speakerPos.set(s.id, i));
	const rank = (s: AgendaSlot) =>
		s.evaluatesSlotId != null && speakerPos.has(s.evaluatesSlotId)
			? (speakerPos.get(s.evaluatesSlotId) as number)
			: 1000 + s.slotIndex; // unlinked evaluators sort after linked ones
	return [...evaluators].sort((a, b) => rank(a) - rank(b) || a.slotIndex - b.slotIndex);
}

export function expandRunSheet(
	slots: AgendaSlot[],
	template: Beat[] = RUN_OF_SHOW,
): AgendaRow[] {
	const rows: AgendaRow[] = [];
	const byRole = (name: string) =>
		slots.filter((s) => s.roleName.toLowerCase() === name.toLowerCase());

	for (const beat of template) {
		if (beat.kind === "event") {
			rows.push({ who: beat.who, detail: beat.detail, minutes: beat.minutes, marks: null });
			continue;
		}

		const matching = byRole(beat.roleName);

		if (beat.role === "speaker") {
			const ordered = [...matching].sort((a, b) => a.slotIndex - b.slotIndex);
			const multi = ordered.length > 1;
			ordered.forEach((s, i) => {
				const marks =
					s.minMinutes != null && s.maxMinutes != null
						? { green: s.minMinutes, yellow: (s.minMinutes + s.maxMinutes) / 2, red: s.maxMinutes }
						: null;
				const detail = s.speechTitle
					? `"${s.speechTitle}"${s.projectLevel ? ` · ${s.projectLevel}` : ""}`
					: beat.detail;
				rows.push({
					who: `${numbered(beat.roleName, i, multi)} · ${s.assigneeName ?? OPEN_LABEL}`,
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
					who: `${numbered(beat.roleName, i, multi)} · ${s.assigneeName ?? OPEN_LABEL}`,
					detail: s.evaluates?.speakerName ? `Evaluates ${s.evaluates.speakerName}` : beat.detail,
					minutes: beat.minutes,
					marks: null,
				});
			});
		} else {
			// plain role: usually one slot; a missing role degrades to a label-only row.
			if (matching.length === 0) {
				rows.push({ who: beat.roleName, detail: beat.detail, minutes: beat.minutes, marks: null });
			} else {
				for (const s of matching) {
					rows.push({
						who: `${beat.roleName} · ${s.assigneeName ?? OPEN_LABEL}`,
						detail: beat.detail,
						minutes: beat.minutes,
						marks: null,
					});
				}
			}
		}
	}
	return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/lib/agenda-runsheet.test.ts`
Expected: PASS (all runsheet tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda-runsheet.ts src/lib/agenda-runsheet.test.ts
git commit -m "feat(agenda): expandRunSheet weaves slots into the run-of-show"
```

---

## Task 4: `agenda-timing.ts` — running clock

**Files:**
- Create: `src/lib/agenda-timing.ts`
- Test: `src/lib/agenda-timing.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/agenda-timing.test.ts
import { describe, expect, it } from "vitest";
import { buildTimeline } from "./agenda-timing";
import type { AgendaRow } from "./agenda-runsheet";

function row(minutes: number): AgendaRow {
	return { who: "x", detail: "", minutes, marks: null };
}

describe("buildTimeline", () => {
	it("assigns each row a running clock time = start + sum of PRIOR durations", () => {
		// 2026-07-07 18:45 America/Chicago (CDT, UTC-5) == 23:45 UTC.
		const start = new Date("2026-07-07T23:45:00Z");
		const rows = [row(1), row(1), row(3)];
		const timed = buildTimeline(rows, start, "America/Chicago");
		expect(timed.map((r) => r.time)).toEqual(["6:45", "6:46", "6:47"]);
	});

	it("carries the row content through unchanged", () => {
		const start = new Date("2026-07-07T23:45:00Z");
		const [first] = buildTimeline([{ who: "Speaker 1 · A", detail: '"T"', minutes: 7, marks: { green: 5, yellow: 6, red: 7 } }], start, "America/Chicago");
		expect(first.who).toBe("Speaker 1 · A");
		expect(first.marks).toEqual({ green: 5, yellow: 6, red: 7 });
	});

	it("formats in the club timezone (not the host timezone)", () => {
		const start = new Date("2026-07-07T23:45:00Z");
		// Same instant is 19:45 in New York (EDT, UTC-4).
		const [ny] = buildTimeline([row(1)], start, "America/New_York");
		expect(ny.time).toBe("7:45");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/agenda-timing.test.ts`
Expected: FAIL — cannot find module `./agenda-timing`.

- [ ] **Step 3: Implement `buildTimeline`**

```typescript
// src/lib/agenda-timing.ts
import type { AgendaRow } from "./agenda-runsheet";

/** An agenda row with its running-clock start time. */
export type TimelineRow = AgendaRow & { time: string };

/** Wall-clock minutes-since-midnight of `date` in `timeZone`. */
function startMinutesInZone(date: Date, timeZone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
		timeZone,
	}).formatToParts(date);
	const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
	const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
	// Intl can emit "24" for midnight in hour12:false; normalize to 0.
	return (hour % 24) * 60 + minute;
}

/** Total minutes-since-midnight → "6:45" (12-hour, no am/pm, matching the print design). */
function formatClock(totalMinutes: number): string {
	const h24 = Math.floor(totalMinutes / 60) % 24;
	const m = totalMinutes % 60;
	const h12 = ((h24 + 11) % 12) + 1;
	return `${h12}:${String(m).padStart(2, "0")}`;
}

/**
 * Attach a running-clock `time` to each row. Row n starts at the meeting start
 * plus the sum of all prior rows' durations, formatted in the club timezone.
 */
export function buildTimeline(
	rows: AgendaRow[],
	startsAt: Date | string,
	timeZone: string,
): TimelineRow[] {
	const start = typeof startsAt === "string" ? new Date(startsAt) : startsAt;
	let cursor = startMinutesInZone(start, timeZone);
	return rows.map((r) => {
		const time = formatClock(cursor);
		cursor += r.minutes;
		return { ...r, time };
	});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/lib/agenda-timing.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda-timing.ts src/lib/agenda-timing.test.ts
git commit -m "feat(agenda): buildTimeline running clock"
```

---

## Task 5: Add club name to `loadMeetingDetail`

The print header needs the club name. `loadMeetingDetail` currently returns only the club `timezone`.

**Files:**
- Modify: `src/server/meetings.ts`

- [ ] **Step 1: Widen the club query to include `name`**

Find (around line 119):

```typescript
	const club = await db.query.clubs.findFirst({
		where: eq(clubs.id, meeting.clubId),
		columns: { timezone: true },
	});
```

Replace with:

```typescript
	const club = await db.query.clubs.findFirst({
		where: eq(clubs.id, meeting.clubId),
		columns: { timezone: true, name: true },
	});
```

- [ ] **Step 2: Return `clubName`**

Find the return object (around line 133):

```typescript
	return {
		meeting,
		slots,
		canManage,
		timezone: club?.timezone ?? "UTC",
		unavailableMembers,
		unavailableMemberIds: unavailableMembers.map((m) => m.id),
	};
```

Replace with:

```typescript
	return {
		meeting,
		slots,
		canManage,
		timezone: club?.timezone ?? "UTC",
		clubName: club?.name ?? "",
		unavailableMembers,
		unavailableMemberIds: unavailableMembers.map((m) => m.id),
	};
```

- [ ] **Step 3: Type-check (no unit test — DB projection)**

Run: `bunx tsc --noEmit`
Expected: no errors. (`getMeeting`/`getNextMeeting` return types widen automatically; existing consumers ignore the new field.)

- [ ] **Step 4: Commit**

```bash
git add src/server/meetings.ts
git commit -m "feat(meetings): expose club name from loadMeetingDetail"
```

---

## Task 6: `MeetingAgendaPrint` component

Presentational only. Reproduce the **timing** layout from the visual reference
`templates/meeting-agenda/MeetingAgenda.dc.html` (brand hex + `@media print`). Other
layouts render a stub so the `layout` prop contract matches the design system.

**Files:**
- Create: `src/components/agenda/meeting-agenda-print.tsx`

- [ ] **Step 1: Create the component**

```tsx
// src/components/agenda/meeting-agenda-print.tsx
import type { LegendEntry } from "#/lib/agenda-runsheet";
import type { TimelineRow } from "#/lib/agenda-timing";

export type AgendaLayout = "timing" | "spacious" | "editorial" | "grid";

export type AgendaHeader = {
	clubName: string;
	date: string; // preformatted (formatMeetingDate)
	theme: string | null;
	wordOfTheDay: string | null;
	location: string | null;
};

type Props = {
	layout: AgendaLayout;
	header: AgendaHeader;
	legend: LegendEntry[];
	rows: TimelineRow[];
};

// Brand palette transcribed from templates/meeting-agenda/MeetingAgenda.dc.html.
const INK = "#173a40";
const LAGOON = "#328f97";
const MUTED = "#416166";
const GREEN = "#2f9e5b";
const AMBER = "#d99a2e";
const RED = "#c8482f";

/** minutes (e.g. 6.5) → "6:30" for the timer-card marks. */
function mark(minutes: number): string {
	const whole = Math.floor(minutes);
	const secs = Math.round((minutes - whole) * 60);
	return `${whole}:${String(secs).padStart(2, "0")}`;
}

function TimingLayout({ header, legend, rows }: Omit<Props, "layout">) {
	return (
		<div style={{ fontFamily: "'Manrope', ui-sans-serif, system-ui, sans-serif", color: INK, maxWidth: 816, margin: "0 auto" }}>
			{/* Header band */}
			<div style={{ background: `linear-gradient(125deg, ${LAGOON}, ${INK})`, color: "#fff", padding: "22px 38px" }}>
				<div style={{ fontSize: 22, fontWeight: 800 }}>{header.clubName}</div>
				<div style={{ fontSize: 12, opacity: 0.9, marginTop: 4 }}>
					{header.date}
					{header.location ? ` · ${header.location}` : ""}
				</div>
				{(header.theme || header.wordOfTheDay) && (
					<div style={{ fontSize: 12, marginTop: 6 }}>
						{header.theme ? `Theme: ${header.theme}` : ""}
						{header.theme && header.wordOfTheDay ? " · " : ""}
						{header.wordOfTheDay ? `Word of the Day: ${header.wordOfTheDay}` : ""}
					</div>
				)}
			</div>

			{/* Roles legend */}
			{legend.length > 0 && (
				<div style={{ padding: "8px 38px", fontSize: 11, color: MUTED, borderBottom: "1px solid rgba(23,58,64,.1)" }}>
					{legend.map((e) => `${e.role}: ${e.name}`).join("  ·  ")}
				</div>
			)}

			{/* Run of show */}
			<div style={{ padding: "0 38px" }}>
				{rows.map((r, i) => (
					<div
						key={`${r.time}-${i}`}
						style={{ display: "flex", alignItems: "center", padding: "6px 0", borderBottom: "1px solid rgba(23,58,64,.07)" }}
					>
						<div style={{ flex: "none", width: 46, fontSize: 11, fontWeight: 800 }}>{r.time}</div>
						<div style={{ flex: "none", width: 170, fontSize: 10.5, fontWeight: 700 }}>{r.who}</div>
						<div style={{ flex: 1, fontSize: 10.5, color: MUTED }}>{r.detail}</div>
						<div style={{ flex: "none", width: 150, display: "flex", justifyContent: "center", gap: 11 }}>
							{r.marks && (
								<>
									<span style={{ fontSize: 10, color: GREEN, fontWeight: 700 }}>{mark(r.marks.green)}</span>
									<span style={{ fontSize: 10, color: AMBER, fontWeight: 700 }}>{mark(r.marks.yellow)}</span>
									<span style={{ fontSize: 10, color: RED, fontWeight: 700 }}>{mark(r.marks.red)}</span>
								</>
							)}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

export function MeetingAgendaPrint({ layout, header, legend, rows }: Props) {
	if (layout !== "timing") {
		return (
			<div style={{ padding: 48, fontFamily: "system-ui", color: MUTED }}>
				The “{layout}” layout is coming soon. Use the timing layout for now.
			</div>
		);
	}
	return <TimingLayout header={header} legend={legend} rows={rows} />;
}
```

- [ ] **Step 2: Verify it type-checks and lint passes**

Run: `bunx tsc --noEmit && bun run check`
Expected: no type errors; Biome reports no issues (tabs + double quotes already used).

- [ ] **Step 3: Commit**

```bash
git add src/components/agenda/meeting-agenda-print.tsx
git commit -m "feat(agenda): MeetingAgendaPrint timing layout + legend + stubs"
```

---

## Task 7: Public print route

**Files:**
- Create: `src/routes/club.$clubId.meeting.$meetingId.print.tsx`

Route id: `/club/$clubId/meeting/$meetingId/print`. The route tree regenerates on
dev/build (`bun run generate-routes`).

- [ ] **Step 1: Create the route**

```tsx
// src/routes/club.$clubId.meeting.$meetingId.print.tsx
import { createFileRoute, notFound } from "@tanstack/react-router";
import {
	type AgendaLayout,
	MeetingAgendaPrint,
} from "#/components/agenda/meeting-agenda-print";
import { buildLegend, expandRunSheet } from "#/lib/agenda-runsheet";
import { buildTimeline } from "#/lib/agenda-timing";
import { formatMeetingDate } from "#/lib/format";
import { getMeeting } from "#/server/meetings";

const LAYOUTS: AgendaLayout[] = ["timing", "spacious", "editorial", "grid"];

export const Route = createFileRoute("/club/$clubId/meeting/$meetingId/print")({
	validateSearch: (search: Record<string, unknown>): { layout: AgendaLayout } => {
		const l = search.layout;
		return { layout: LAYOUTS.includes(l as AgendaLayout) ? (l as AgendaLayout) : "timing" };
	},
	loader: async ({ params }) => {
		const data = await getMeeting({ data: params.meetingId });
		if (data.meeting.clubId !== params.clubId) throw notFound();
		return data;
	},
	component: PrintAgenda,
});

function PrintAgenda() {
	const { layout } = Route.useSearch();
	const { meeting, slots, timezone, clubName } = Route.useLoaderData();

	const rows = buildTimeline(expandRunSheet(slots), meeting.scheduledAt, timezone);
	const legend = buildLegend(slots);
	const header = {
		clubName,
		date: formatMeetingDate(meeting.scheduledAt, timezone),
		theme: meeting.theme,
		wordOfTheDay: meeting.wordOfTheDay,
		location: meeting.location,
	};

	return (
		<div>
			<button
				type="button"
				className="no-print"
				onClick={() => window.print()}
				style={{
					position: "fixed", top: 12, right: 12, padding: "8px 14px",
					background: "#173a40", color: "#fff", border: 0, borderRadius: 8, cursor: "pointer",
				}}
			>
				Print
			</button>
			<style>{`@media print { .no-print { display: none !important; } @page { size: letter portrait; margin: 0.4in; } }`}</style>
			<MeetingAgendaPrint layout={layout} header={header} legend={legend} rows={rows} />
		</div>
	);
}
```

- [ ] **Step 2: Regenerate the route tree and type-check**

Run: `bun run generate-routes && bunx tsc --noEmit`
Expected: `src/routeTree.gen.ts` updates to include the print route; no type errors.

- [ ] **Step 3: Manual verification in the browser**

Find a real meeting id + club id from the dev database:

Run: `docker exec dev-postgres psql -U dev -d tm_scheduler -c "select id, club_id from meetings order by scheduled_at desc limit 1;"`

Start the dev server (`bun run dev`) and open:
`http://localhost:3000/club/<club_id>/meeting/<meeting_id>/print`

Expected: the timing sheet renders with the club header, a running clock down the left,
the run-of-show rows (speakers show titles + green/yellow/red marks), and a functionary
legend. A floating "Print" button appears on screen; Ctrl-P / the button opens the print
dialog with the button hidden. Compare against
`templates/meeting-agenda/MeetingAgenda.dc.html` and nudge spacing/widths to taste.

- [ ] **Step 4: Commit**

```bash
git add src/routes/club.$clubId.meeting.$meetingId.print.tsx src/routeTree.gen.ts
git commit -m "feat(agenda): public print route for the timing agenda"
```

---

## Task 8: "Print agenda" button on the meeting view

**Files:**
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx`

- [ ] **Step 1: Import the Printer icon**

At the top of the file, find the `lucide-react` import (it already imports icons) and add
`Printer` to it. If there is no `lucide-react` import yet, add:

```tsx
import { Printer } from "lucide-react";
```

- [ ] **Step 2: Add the button next to the existing ShareLinkButton**

Find the `<ShareLinkButton` usage (around line 223). Immediately after the `ShareLinkButton`
element, add:

```tsx
				<Button asChild variant="outline" size="sm">
					<Link
						to="/club/$clubId/meeting/$meetingId/print"
						params={{ clubId, meetingId }}
						target="_blank"
						rel="noopener noreferrer"
					>
						<Printer />
						Print agenda
					</Link>
				</Button>
```

(`Button`, `Link`, `clubId`, and `meetingId` are already imported / in scope in this file.)

- [ ] **Step 3: Type-check + lint**

Run: `bunx tsc --noEmit && bun run check`
Expected: no errors.

- [ ] **Step 4: Manual verification**

With `bun run dev` running, open the meeting view
`http://localhost:3000/club/<club_id>/meeting/<meeting_id>` and confirm a "Print agenda"
button appears; clicking it opens the print route in a new tab.

- [ ] **Step 5: Commit**

```bash
git add src/routes/club.$clubId.meeting.$meetingId.tsx
git commit -m "feat(agenda): Print agenda button on the meeting view"
```

---

## Task 9: Full gate + wrap-up

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `bun run test`
Expected: all tests pass, including `agenda-runsheet.test.ts` and `agenda-timing.test.ts`.

- [ ] **Step 2: Run the lint/format gate**

Run: `bun run check`
Expected: no issues.

- [ ] **Step 3: Production build (also surfaces type errors + regenerates routes)**

Run: `bun run build`
Expected: build succeeds.

- [ ] **Step 4: Confirm no stray commits / clean tree**

Run: `git status --short`
Expected: clean (everything committed across Tasks 1–8).

---

## Notes for the implementer

- **Do not** import `#/db` from `agenda-runsheet.ts` or `agenda-timing.ts` — they must stay
  client-safe (the print route loader is server-side and calls `getMeeting`; the component
  imports only the pure libs). The repo's `server-modules.guard.test.ts` enforces server
  modules stay clean.
- The timing layout's exact pixel styling is best matched by eyeballing
  `templates/meeting-agenda/MeetingAgenda.dc.html`; the component gives a faithful,
  functional starting point — refine widths/spacing during Task 7's manual check.
- Deferred (out of scope, do not build): the `spacious`/`editorial`/`grid` layouts,
  server-generated PDF, per-club templates, per-role min/max marks, club logo, officer roles.
