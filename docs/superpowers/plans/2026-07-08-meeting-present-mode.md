# Meeting Present Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-app, full-screen, keyboard-navigable slide deck at `/club/$clubId/meeting/$meetingId/present` that is generated from live meeting/role/speech data and projected during a Toastmasters meeting.

**Architecture:** A pure generator `buildSlideDeck(meeting, club, slots) → Slide[]` in `src/lib/agenda-slides.ts` (mirroring the print agenda's `agenda-runsheet.ts` — no DB access, client-safe by construction) produces a discriminated-union list of slides from a fixed `SLIDE_TEMPLATE`. A new route renders one slide at a time. Three new nullable `meetings` columns (`wodDefinition`, `wodExample`, `reminders`) feed the Word-of-the-Day and Reminders slides.

**Tech Stack:** TanStack Start (React 19, file-based routing), Drizzle ORM + Postgres, Vitest, Biome (tabs + double quotes), shadcn/ui + Tailwind v4, lucide-react. Package manager: Bun.

**Spec:** `docs/superpowers/specs/2026-07-08-meeting-present-mode-design.md`

---

## File Structure

- **Create** `src/lib/agenda-slides.ts` — pure slide generator: `Slide` union, `SLIDE_TEMPLATE` constants, `buildSlideDeck()`, timing/label constants.
- **Create** `src/lib/agenda-slides.test.ts` — Vitest unit tests for `buildSlideDeck`.
- **Create** `src/routes/club.$clubId_.meeting.$meetingId.present.tsx` — full-screen presentation route + component.
- **Create** `src/components/agenda/meeting-present.tsx` — the presentational slideshow component + per-`kind` slide renderers.
- **Create** `src/components/agenda/meeting-present.test.tsx` — smoke render test.
- **Modify** `src/db/schema.ts` — add three columns to the `meetings` table (~line 251).
- **Modify** `src/server/meetings.ts` — add three fields to `updateMeetingSchema` (~line 344).
- **Modify** `src/server/meetings-logic.ts` — persist + activity-log the three fields (~line 93).
- **Modify** `src/lib/agenda-runsheet.ts` — `export` the `numbered` and `orderEvaluators` helpers (lines 151, 156).
- **Modify** `src/routes/club.$clubId.meeting.$meetingId.tsx` — add three inputs to `EditMeetingMetaDialog` (~line 735) + wire them into the `updateMeeting` call (~line 696) + add a "Present" button (~line 345).

---

## Task 0: Worktree setup (once)

**A fresh worktree needs deps + env before any db/build/test command works** (see repo memory).

- [ ] **Step 1: Install deps and copy env**

Run from the worktree root (`/media/rasheed-bustamam/Extra/coding/tm-scheduler-present`):

```bash
bun install
cp /media/rasheed-bustamam/Extra/coding/tm-scheduler/.env.local .env.local
```

- [ ] **Step 2: Confirm the local Postgres container is up**

Run: `docker ps --filter name=dev-postgres --format '{{.Names}} {{.Status}}'`
Expected: a line like `dev-postgres Up ...`. (Do NOT `docker run` a new Postgres — it collides on port 5432.)

- [ ] **Step 3: Confirm tests run green before changes**

Run: `bun run test`
Expected: existing suite passes (this is the baseline).

---

## Task 1: Add three columns to the `meetings` table

**Files:**
- Modify: `src/db/schema.ts:251`
- Generated: `drizzle/*.sql` (migration)

- [ ] **Step 1: Add the columns to the schema**

In `src/db/schema.ts`, the `meetings` table currently has (around line 250-253):

```ts
		location: text("location"),
		theme: text("theme"),
		wordOfTheDay: text("word_of_the_day"),
		status: meetingStatusEnum("status").notNull().default("scheduled"),
		notes: text("notes"),
```

Change the `wordOfTheDay` region to add the three new nullable columns:

```ts
		location: text("location"),
		theme: text("theme"),
		wordOfTheDay: text("word_of_the_day"),
		// Word-of-the-Day supporting copy for the projected present-mode deck.
		wodDefinition: text("wod_definition"),
		wodExample: text("wod_example"),
		status: meetingStatusEnum("status").notNull().default("scheduled"),
		notes: text("notes"),
		// Free-text club announcements projected on the present-mode Reminders
		// slide. Distinct from `notes` (private organizer scratch).
		reminders: text("reminders"),
```

- [ ] **Step 2: Generate the migration**

Run: `bun run db:generate`
Expected: a new file under `drizzle/` (e.g. `drizzle/0018_*.sql`) containing three `ALTER TABLE "meetings" ADD COLUMN ...` statements for `wod_definition`, `wod_example`, `reminders`.

- [ ] **Step 3: Apply the migration locally**

Run: `bun run db:migrate`
Expected: applies cleanly, exits 0.

- [ ] **Step 4: Verify the columns exist**

Run:
```bash
docker exec dev-postgres psql -U dev -d tm_scheduler -c "\d meetings" | grep -E "wod_definition|wod_example|reminders"
```
Expected: three rows, each `text`.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(schema): meeting wod_definition, wod_example, reminders columns"
```

---

## Task 2: Export `numbered` and `orderEvaluators` from agenda-runsheet

The slide generator reuses these for speaker/evaluator ordering + labels. They are currently module-private.

**Files:**
- Modify: `src/lib/agenda-runsheet.ts:151,156`

- [ ] **Step 1: Add `export` to both helpers**

At line 151 change:
```ts
function numbered(roleName: string, index: number, multi: boolean): string {
```
to:
```ts
export function numbered(roleName: string, index: number, multi: boolean): string {
```

At line 156 change:
```ts
function orderEvaluators(
```
to:
```ts
export function orderEvaluators(
```

- [ ] **Step 2: Verify nothing broke**

Run: `bun run test src/lib/agenda-runsheet.test.ts`
Expected: PASS (behaviour unchanged; only visibility widened).

- [ ] **Step 3: Commit**

```bash
git add src/lib/agenda-runsheet.ts
git commit -m "refactor(agenda): export numbered + orderEvaluators for reuse"
```

---

## Task 3: `agenda-slides.ts` — types, constants, and anchor slides (title / toastmaster / thankYou)

**Files:**
- Create: `src/lib/agenda-slides.ts`
- Test: `src/lib/agenda-slides.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/agenda-slides.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AgendaSlot } from "./agenda-runsheet";
import {
	buildSlideDeck,
	type ClubForDeck,
	type MeetingForDeck,
} from "./agenda-slides";

function slot(over: Partial<AgendaSlot>): AgendaSlot {
	return {
		id: "s",
		roleName: "Timer",
		category: "functionary",
		isSpeakerRole: false,
		slotIndex: 0,
		assigneeName: null,
		speechTitle: null,
		projectLevel: null,
		minMinutes: null,
		maxMinutes: null,
		evaluatesSlotId: null,
		evaluates: null,
		...over,
	};
}

const meeting: MeetingForDeck = {
	scheduledAt: new Date("2026-06-25T23:45:00Z"),
	theme: null,
	wordOfTheDay: null,
	wodDefinition: null,
	wodExample: null,
	reminders: null,
};

const club: ClubForDeck = {
	name: "MCF Toastmasters Club",
	clubNumber: "28677176",
	district: "District 39",
	timezone: "America/Chicago",
	meetingSchedule: "2nd & 4th Thursday",
};

const kinds = (slots: AgendaSlot[] = []) =>
	buildSlideDeck(meeting, club, slots).map((s) => s.kind);

describe("buildSlideDeck anchors", () => {
	it("always emits title, toastmaster, thankYou — even with no slots", () => {
		expect(kinds([])).toEqual(["title", "toastmaster", "thankYou"]);
	});

	it("title slide carries club identity + schedule time", () => {
		const [title] = buildSlideDeck(meeting, club, []);
		expect(title).toMatchObject({
			kind: "title",
			clubName: "MCF Toastmasters Club",
			clubNumber: "28677176",
			district: "District 39",
			timezone: "America/Chicago",
		});
	});

	it("toastmaster slide shows the assignee, else the open placeholder", () => {
		const withTmod = buildSlideDeck(meeting, club, [
			slot({ roleName: "Toastmaster of the Day", assigneeName: "Schinthia" }),
		]);
		expect(withTmod[1]).toMatchObject({ kind: "toastmaster", name: "Schinthia" });
		expect(buildSlideDeck(meeting, club, [])[1]).toMatchObject({
			kind: "toastmaster",
			name: "— open —",
		});
	});

	it("thankYou carries the club meeting schedule", () => {
		const deck = buildSlideDeck(meeting, club, []);
		expect(deck.at(-1)).toMatchObject({
			kind: "thankYou",
			meetingSchedule: "2nd & 4th Thursday",
		});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/agenda-slides.test.ts`
Expected: FAIL — cannot resolve `./agenda-slides`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/agenda-slides.ts`:

```ts
import type { AgendaSlot, LegendEntry } from "./agenda-runsheet";
import { OPEN_LABEL } from "./agenda-runsheet";

/** The meeting fields the deck needs (structural subset of the DB row). */
export type MeetingForDeck = {
	scheduledAt: Date | string;
	theme: string | null;
	wordOfTheDay: string | null;
	wodDefinition: string | null;
	wodExample: string | null;
	reminders: string | null;
};

/** The club fields the deck needs. */
export type ClubForDeck = {
	name: string;
	clubNumber: string | null;
	district: string | null;
	timezone: string;
	meetingSchedule: string | null;
};

/** One projected slide. Date formatting is deferred to the renderer. */
export type Slide =
	| {
			kind: "title";
			clubName: string;
			district: string | null;
			clubNumber: string | null;
			scheduledAt: Date;
			timezone: string;
	  }
	| { kind: "toastmaster"; name: string }
	| { kind: "theme"; theme: string }
	| { kind: "wordOfDay"; word: string; definition: string | null; example: string | null }
	| { kind: "geIntro"; name: string; team: LegendEntry[] }
	| {
			kind: "speech";
			label: string;
			speaker: string;
			title: string | null;
			projectLevel: string | null;
			time: string;
	  }
	| { kind: "voteSpeaker"; names: string[] }
	| { kind: "tableTopics"; master: string; timing: string }
	| { kind: "voteTableTopics" }
	| { kind: "evalIntro"; name: string; time: string }
	| { kind: "evaluation"; label: string; evaluator: string; speaker: string | null; time: string }
	| { kind: "voteEvaluator"; names: string[] }
	| { kind: "generalEvaluation"; name: string; time: string }
	| { kind: "awards"; categories: string[] }
	| { kind: "reminders"; text: string }
	| { kind: "thankYou"; meetingSchedule: string | null };

/** Standard Toastmasters role names (mirrors RUN_OF_SHOW in agenda-runsheet.ts). */
const ROLE = {
	toastmaster: "Toastmaster of the Day",
	generalEvaluator: "General Evaluator",
	tableTopicsMaster: "Table Topics Master",
	evaluator: "Evaluator",
} as const;

const byRoleName = (slots: AgendaSlot[], name: string) =>
	slots.filter((s) => s.roleName.toLowerCase() === name.toLowerCase());

const assigneeOrOpen = (slots: AgendaSlot[], name: string): string =>
	byRoleName(slots, name)[0]?.assigneeName ?? OPEN_LABEL;

export function buildSlideDeck(
	meeting: MeetingForDeck,
	club: ClubForDeck,
	slots: AgendaSlot[],
): Slide[] {
	const deck: Slide[] = [];

	deck.push({
		kind: "title",
		clubName: club.name,
		district: club.district,
		clubNumber: club.clubNumber,
		scheduledAt: new Date(meeting.scheduledAt),
		timezone: club.timezone,
	});

	deck.push({ kind: "toastmaster", name: assigneeOrOpen(slots, ROLE.toastmaster) });

	deck.push({ kind: "thankYou", meetingSchedule: club.meetingSchedule });

	return deck;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/lib/agenda-slides.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda-slides.ts src/lib/agenda-slides.test.ts
git commit -m "feat(agenda): buildSlideDeck anchor slides (title/toastmaster/thankYou)"
```

---

## Task 4: Theme + Word-of-the-Day slides (conditional on non-blank)

**Files:**
- Modify: `src/lib/agenda-slides.ts`
- Test: `src/lib/agenda-slides.test.ts`

- [ ] **Step 1: Write the failing test** — append to `agenda-slides.test.ts`:

```ts
describe("buildSlideDeck theme + word of the day", () => {
	it("omits theme + wordOfDay when both blank", () => {
		expect(kinds([])).not.toContain("theme");
		expect(kinds([])).not.toContain("wordOfDay");
	});

	it("emits theme slide only when theme set", () => {
		const deck = buildSlideDeck({ ...meeting, theme: "A Fresh Start" }, club, []);
		expect(deck.map((s) => s.kind)).toEqual([
			"title",
			"toastmaster",
			"theme",
			"thankYou",
		]);
		expect(deck[2]).toMatchObject({ kind: "theme", theme: "A Fresh Start" });
	});

	it("wordOfDay slide includes definition + example only when present", () => {
		const full = buildSlideDeck(
			{
				...meeting,
				wordOfTheDay: "Momentum",
				wodDefinition: "impetus gained by a moving object",
				wodExample: "The momentum of the river keeps moving forward.",
			},
			club,
			[],
		);
		expect(full.find((s) => s.kind === "wordOfDay")).toMatchObject({
			word: "Momentum",
			definition: "impetus gained by a moving object",
			example: "The momentum of the river keeps moving forward.",
		});

		const wordOnly = buildSlideDeck({ ...meeting, wordOfTheDay: "Momentum" }, club, []);
		expect(wordOnly.find((s) => s.kind === "wordOfDay")).toMatchObject({
			word: "Momentum",
			definition: null,
			example: null,
		});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/agenda-slides.test.ts`
Expected: FAIL — theme/wordOfDay slides not emitted.

- [ ] **Step 3: Implement** — in `buildSlideDeck`, insert after the `toastmaster` push and before the `thankYou` push:

```ts
	if (meeting.theme?.trim()) {
		deck.push({ kind: "theme", theme: meeting.theme.trim() });
	}

	if (meeting.wordOfTheDay?.trim()) {
		deck.push({
			kind: "wordOfDay",
			word: meeting.wordOfTheDay.trim(),
			definition: meeting.wodDefinition?.trim() || null,
			example: meeting.wodExample?.trim() || null,
		});
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/lib/agenda-slides.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda-slides.ts src/lib/agenda-slides.test.ts
git commit -m "feat(agenda): present-mode theme + word-of-the-day slides"
```

---

## Task 5: Speech slides + Vote-for-Best-Speaker

**Files:**
- Modify: `src/lib/agenda-slides.ts`
- Test: `src/lib/agenda-slides.test.ts`

- [ ] **Step 1: Write the failing test** — append:

```ts
describe("buildSlideDeck speeches", () => {
	const speakers = [
		slot({
			id: "sp1",
			roleName: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			slotIndex: 0,
			assigneeName: "Rehanna Khan",
			speechTitle: "A Tasteful Historic Profile",
			projectLevel: "Level 1",
			minMinutes: 5,
			maxMinutes: 7,
		}),
		slot({
			id: "sp2",
			roleName: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			slotIndex: 1,
			assigneeName: "Sudheer Isanaka",
			minMinutes: 5,
			maxMinutes: 7,
		}),
	];

	it("emits one speech slide per speaker then a vote slide", () => {
		const ks = buildSlideDeck(meeting, club, speakers).map((s) => s.kind);
		expect(ks).toEqual([
			"title",
			"toastmaster",
			"speech",
			"speech",
			"voteSpeaker",
			"thankYou",
		]);
	});

	it("speech slide carries speaker, title, level, and real time range", () => {
		const speech = buildSlideDeck(meeting, club, speakers).find(
			(s) => s.kind === "speech",
		);
		expect(speech).toMatchObject({
			label: "Speech 1",
			speaker: "Rehanna Khan",
			title: "A Tasteful Historic Profile",
			projectLevel: "Level 1",
			time: "5–7 minutes",
		});
	});

	it("vote slide lists assigned speaker names, skipping open slots", () => {
		const withOpen = [...speakers, slot({
			id: "sp3",
			roleName: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			slotIndex: 2,
			assigneeName: null,
		})];
		const vote = buildSlideDeck(meeting, club, withOpen).find(
			(s) => s.kind === "voteSpeaker",
		);
		expect(vote).toMatchObject({ names: ["Rehanna Khan", "Sudheer Isanaka"] });
	});

	it("single speaker uses unnumbered label", () => {
		const one = buildSlideDeck(meeting, club, [speakers[0]]).find(
			(s) => s.kind === "speech",
		);
		expect(one).toMatchObject({ label: "Speech" });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/agenda-slides.test.ts`
Expected: FAIL — no speech/voteSpeaker slides.

- [ ] **Step 3: Implement.**

At the top of `agenda-slides.ts`, extend the import and add helpers + constants:

```ts
import type { AgendaSlot, LegendEntry } from "./agenda-runsheet";
import {
	DEFAULT_SPEAKER_MINUTES,
	numbered,
	OPEN_LABEL,
} from "./agenda-runsheet";
```

Add near the `ROLE` constant:

```ts
/** Hardcoded standard Toastmasters durations for slots without per-slot timing. */
export const TABLE_TOPICS_TIMING = "1–2 minutes per speaker";
export const EVAL_SESSION_TIMING = "4–6 minutes";
export const EVALUATION_TIMING = "2–3 minutes";
export const GENERAL_EVALUATION_TIMING = "2 minutes";

function speechTime(min: number | null, max: number | null): string {
	if (min != null && max != null) return `${min}–${max} minutes`;
	if (max != null) return `${max} minutes`;
	if (min != null) return `${min} minutes`;
	return `${DEFAULT_SPEAKER_MINUTES} minutes`;
}

const assignedNames = (slots: AgendaSlot[]): string[] =>
	slots.map((s) => s.assigneeName).filter((n): n is string => n != null);
```

In `buildSlideDeck`, after the theme/wordOfDay block and before `thankYou`, add:

```ts
	const speakers = slots
		.filter((s) => s.isSpeakerRole)
		.sort((a, b) => a.slotIndex - b.slotIndex);
	if (speakers.length > 0) {
		const multi = speakers.length > 1;
		speakers.forEach((s, i) => {
			deck.push({
				kind: "speech",
				label: numbered("Speech", i, multi),
				speaker: s.assigneeName ?? OPEN_LABEL,
				title: s.speechTitle,
				projectLevel: s.projectLevel,
				time: speechTime(s.minMinutes, s.maxMinutes),
			});
		});
		deck.push({ kind: "voteSpeaker", names: assignedNames(speakers) });
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/lib/agenda-slides.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda-slides.ts src/lib/agenda-slides.test.ts
git commit -m "feat(agenda): present-mode speech + vote-speaker slides"
```

---

## Task 6: Table Topics + Vote-for-Best-Table-Topics

**Files:**
- Modify: `src/lib/agenda-slides.ts`
- Test: `src/lib/agenda-slides.test.ts`

- [ ] **Step 1: Write the failing test** — append:

```ts
describe("buildSlideDeck table topics", () => {
	const tt = slot({
		id: "tt",
		roleName: "Table Topics Master",
		category: "leadership",
		assigneeName: "Rasheed Bustamam",
	});

	it("emits tableTopics + voteTableTopics when the role exists", () => {
		const ks = buildSlideDeck(meeting, club, [tt]).map((s) => s.kind);
		expect(ks).toEqual([
			"title",
			"toastmaster",
			"tableTopics",
			"voteTableTopics",
			"thankYou",
		]);
	});

	it("table topics slide has master + hardcoded standard timing", () => {
		const slide = buildSlideDeck(meeting, club, [tt]).find(
			(s) => s.kind === "tableTopics",
		);
		expect(slide).toMatchObject({
			master: "Rasheed Bustamam",
			timing: "1–2 minutes per speaker",
		});
	});

	it("omits both table-topics slides when the role is absent", () => {
		expect(kinds([])).not.toContain("tableTopics");
		expect(kinds([])).not.toContain("voteTableTopics");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/agenda-slides.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `buildSlideDeck`, after the speakers block and before `thankYou`:

```ts
	const tableTopics = byRoleName(slots, ROLE.tableTopicsMaster);
	if (tableTopics.length > 0) {
		deck.push({
			kind: "tableTopics",
			master: tableTopics[0].assigneeName ?? OPEN_LABEL,
			timing: TABLE_TOPICS_TIMING,
		});
		deck.push({ kind: "voteTableTopics" });
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/lib/agenda-slides.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda-slides.ts src/lib/agenda-slides.test.ts
git commit -m "feat(agenda): present-mode table-topics slides"
```

---

## Task 7: GE intro + Evaluations + Vote-for-Best-Evaluator + General Evaluation

**Files:**
- Modify: `src/lib/agenda-slides.ts`
- Test: `src/lib/agenda-slides.test.ts`

- [ ] **Step 1: Write the failing test** — append:

```ts
describe("buildSlideDeck evaluation session", () => {
	const ge = slot({
		id: "ge",
		roleName: "General Evaluator",
		category: "evaluator",
		assigneeName: "Saiful Haque",
	});
	const grammarian = slot({
		id: "gr",
		roleName: "Grammarian",
		category: "functionary",
		assigneeName: "Mona",
	});
	const speaker = slot({
		id: "sp1",
		roleName: "Speaker",
		category: "speaker",
		isSpeakerRole: true,
		slotIndex: 0,
		assigneeName: "Rehanna Khan",
	});
	const evaluator = slot({
		id: "ev1",
		roleName: "Evaluator",
		category: "evaluator",
		slotIndex: 0,
		assigneeName: "Faisal Ali",
		evaluatesSlotId: "sp1",
		evaluates: { speakerName: "Rehanna Khan" },
	});

	it("emits geIntro with the GE's functionary team via buildLegend", () => {
		const slide = buildSlideDeck(meeting, club, [ge, grammarian]).find(
			(s) => s.kind === "geIntro",
		);
		expect(slide).toMatchObject({
			name: "Saiful Haque",
			team: [{ role: "Grammarian", name: "Mona" }],
		});
	});

	it("orders the full evaluation session correctly", () => {
		const ks = buildSlideDeck(meeting, club, [
			ge,
			speaker,
			evaluator,
		]).map((s) => s.kind);
		expect(ks).toEqual([
			"title",
			"toastmaster",
			"geIntro",
			"speech",
			"voteSpeaker",
			"evalIntro",
			"evaluation",
			"voteEvaluator",
			"generalEvaluation",
			"thankYou",
		]);
	});

	it("evaluation slide pairs evaluator to the speaker they evaluate", () => {
		const slide = buildSlideDeck(meeting, club, [ge, speaker, evaluator]).find(
			(s) => s.kind === "evaluation",
		);
		expect(slide).toMatchObject({
			evaluator: "Faisal Ali",
			speaker: "Rehanna Khan",
			time: "2–3 minutes",
		});
	});

	it("omits GE slides when no General Evaluator slot exists", () => {
		expect(kinds([])).not.toContain("geIntro");
		expect(kinds([])).not.toContain("generalEvaluation");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/agenda-slides.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

Extend the import at the top of `agenda-slides.ts`:

```ts
import {
	buildLegend,
	DEFAULT_SPEAKER_MINUTES,
	numbered,
	OPEN_LABEL,
	orderEvaluators,
} from "./agenda-runsheet";
```

Make two placements. **First**, insert this GE-intro block **immediately after the word-of-day block and immediately before the speakers block** (so it lands right after word-of-day in output order):

```ts
	const generalEvaluator = byRoleName(slots, ROLE.generalEvaluator);
	if (generalEvaluator.length > 0) {
		deck.push({
			kind: "geIntro",
			name: generalEvaluator[0].assigneeName ?? OPEN_LABEL,
			team: buildLegend(slots),
		});
	}
```

**Second**, append this evaluation-session + general-evaluation block **after the table-topics block (from Task 6) and immediately before the final `thankYou` push**:

```ts
	const evaluators = orderEvaluators(
		byRoleName(slots, ROLE.evaluator),
		slots,
	);
	if (evaluators.length > 0) {
		const geName = generalEvaluator[0]?.assigneeName ?? ROLE.generalEvaluator;
		deck.push({ kind: "evalIntro", name: geName, time: EVAL_SESSION_TIMING });
		const multi = evaluators.length > 1;
		evaluators.forEach((s, i) => {
			deck.push({
				kind: "evaluation",
				label: numbered("Evaluation", i, multi),
				evaluator: s.assigneeName ?? OPEN_LABEL,
				speaker: s.evaluates?.speakerName ?? null,
				time: EVALUATION_TIMING,
			});
		});
		deck.push({ kind: "voteEvaluator", names: assignedNames(evaluators) });
	}

	if (generalEvaluator.length > 0) {
		deck.push({
			kind: "generalEvaluation",
			name: generalEvaluator[0].assigneeName ?? OPEN_LABEL,
			time: GENERAL_EVALUATION_TIMING,
		});
	}
```

> Ordering within `buildSlideDeck` body, top to bottom: title, toastmaster, theme?, wordOfDay?, **geIntro?**, speeches+voteSpeaker?, tableTopics+voteTableTopics?, **evalIntro?+evaluations+voteEvaluator?**, **generalEvaluation?**, thankYou. (Awards + reminders slot in during Task 8, just before thankYou.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/lib/agenda-slides.test.ts`
Expected: PASS (all prior describe-blocks still green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda-slides.ts src/lib/agenda-slides.test.ts
git commit -m "feat(agenda): present-mode GE intro + evaluation session slides"
```

---

## Task 8: Awards (conditional per section) + Reminders + full-ordering test

**Files:**
- Modify: `src/lib/agenda-slides.ts`
- Test: `src/lib/agenda-slides.test.ts`

- [ ] **Step 1: Write the failing test** — append:

```ts
describe("buildSlideDeck awards + reminders", () => {
	const speaker = slot({
		id: "sp1",
		isSpeakerRole: true,
		roleName: "Speaker",
		category: "speaker",
		assigneeName: "Rehanna Khan",
	});
	const tt = slot({ id: "tt", roleName: "Table Topics Master", assigneeName: "Rasheed" });
	const evaluator = slot({ id: "ev", roleName: "Evaluator", category: "evaluator", assigneeName: "Faisal" });

	it("awards lists only categories whose sections exist", () => {
		const slide = buildSlideDeck(meeting, club, [speaker, tt, evaluator]).find(
			(s) => s.kind === "awards",
		);
		expect(slide).toMatchObject({
			categories: ["Best Table Topic", "Best Evaluator", "Best Speaker"],
		});

		const speakerOnly = buildSlideDeck(meeting, club, [speaker]).find(
			(s) => s.kind === "awards",
		);
		expect(speakerOnly).toMatchObject({ categories: ["Best Speaker"] });
	});

	it("no awards slide when no scored sections exist", () => {
		expect(kinds([])).not.toContain("awards");
	});

	it("reminders slide only when reminders non-blank, just before thankYou", () => {
		expect(kinds([])).not.toContain("reminders");
		const deck = buildSlideDeck(
			{ ...meeting, reminders: "Choose a learning path." },
			club,
			[],
		);
		expect(deck.map((s) => s.kind)).toEqual([
			"title",
			"toastmaster",
			"reminders",
			"thankYou",
		]);
		expect(deck[2]).toMatchObject({
			kind: "reminders",
			text: "Choose a learning path.",
		});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/agenda-slides.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `buildSlideDeck`, immediately before the final `thankYou` push, add:

```ts
	const awardCategories: string[] = [];
	if (tableTopics.length > 0) awardCategories.push("Best Table Topic");
	if (evaluators.length > 0) awardCategories.push("Best Evaluator");
	if (speakers.length > 0) awardCategories.push("Best Speaker");
	if (awardCategories.length > 0) {
		deck.push({ kind: "awards", categories: awardCategories });
	}

	if (meeting.reminders?.trim()) {
		deck.push({ kind: "reminders", text: meeting.reminders.trim() });
	}
```

(`tableTopics`, `evaluators`, and `speakers` are the arrays already computed earlier in the function — reuse them; do not recompute.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/lib/agenda-slides.test.ts`
Expected: PASS — every describe-block green.

- [ ] **Step 5: Add a fully-populated ordering test** — append:

```ts
describe("buildSlideDeck full meeting ordering", () => {
	it("produces the canonical slide sequence", () => {
		const slots: AgendaSlot[] = [
			slot({ roleName: "Toastmaster of the Day", assigneeName: "Schinthia" }),
			slot({ id: "ge", roleName: "General Evaluator", category: "evaluator", assigneeName: "Saiful" }),
			slot({ id: "gr", roleName: "Grammarian", assigneeName: "Mona" }),
			slot({ id: "sp1", roleName: "Speaker", category: "speaker", isSpeakerRole: true, slotIndex: 0, assigneeName: "Rehanna", minMinutes: 5, maxMinutes: 7 }),
			slot({ id: "sp2", roleName: "Speaker", category: "speaker", isSpeakerRole: true, slotIndex: 1, assigneeName: "Sudheer", minMinutes: 5, maxMinutes: 7 }),
			slot({ id: "tt", roleName: "Table Topics Master", assigneeName: "Rasheed" }),
			slot({ id: "ev1", roleName: "Evaluator", category: "evaluator", slotIndex: 0, assigneeName: "Faisal", evaluatesSlotId: "sp1", evaluates: { speakerName: "Rehanna" } }),
		];
		const full: MeetingForDeck = {
			...meeting,
			theme: "A Fresh Start",
			wordOfTheDay: "Momentum",
			reminders: "Choose a learning path.",
		};
		expect(buildSlideDeck(full, club, slots).map((s) => s.kind)).toEqual([
			"title",
			"toastmaster",
			"theme",
			"wordOfDay",
			"geIntro",
			"speech",
			"speech",
			"voteSpeaker",
			"tableTopics",
			"voteTableTopics",
			"evalIntro",
			"evaluation",
			"voteEvaluator",
			"generalEvaluation",
			"awards",
			"reminders",
			"thankYou",
		]);
	});
});
```

- [ ] **Step 6: Run the whole file + Biome**

Run: `bunx vitest run src/lib/agenda-slides.test.ts && bunx biome check src/lib/agenda-slides.ts src/lib/agenda-slides.test.ts`
Expected: PASS + no lint errors. (If Biome reports formatting, run `bunx biome check --write` on the two files.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/agenda-slides.ts src/lib/agenda-slides.test.ts
git commit -m "feat(agenda): present-mode awards + reminders + full ordering"
```

---

## Task 9: Wire the three new fields through `updateMeeting`

So the TMOD can save WOD definition/example + reminders and the loader returns them.

**Files:**
- Modify: `src/server/meetings.ts:344`
- Modify: `src/server/meetings-logic.ts:93`

- [ ] **Step 1: Extend the update schema.** In `src/server/meetings.ts`, `updateMeetingSchema` (~line 344) currently ends:

```ts
	theme: z.string().trim().optional(),
	wordOfTheDay: z.string().trim().optional(),
	notes: z.string().trim().optional(),
});
```

Change to:

```ts
	theme: z.string().trim().optional(),
	wordOfTheDay: z.string().trim().optional(),
	wodDefinition: z.string().trim().optional(),
	wodExample: z.string().trim().optional(),
	notes: z.string().trim().optional(),
	reminders: z.string().trim().optional(),
});
```

- [ ] **Step 2: Persist + log the fields.** In `src/server/meetings-logic.ts`, the `next` object (~line 93) currently:

```ts
		theme: input.theme?.trim() || null,
		location: input.location?.trim() || null,
		wordOfTheDay: input.wordOfTheDay?.trim() || null,
		notes: input.notes?.trim() || null,
	};
```

Change to:

```ts
		theme: input.theme?.trim() || null,
		location: input.location?.trim() || null,
		wordOfTheDay: input.wordOfTheDay?.trim() || null,
		wodDefinition: input.wodDefinition?.trim() || null,
		wodExample: input.wodExample?.trim() || null,
		notes: input.notes?.trim() || null,
		reminders: input.reminders?.trim() || null,
	};
```

Then extend the activity-log `before` block (~line 131) to include the new fields for parity:

```ts
				before: {
					theme: meeting.theme,
					wordOfTheDay: meeting.wordOfTheDay,
					wodDefinition: meeting.wodDefinition,
					wodExample: meeting.wodExample,
					location: meeting.location,
					notes: meeting.notes,
					reminders: meeting.reminders,
					scheduledAt: meeting.scheduledAt,
					lengthMinutes: meeting.lengthMinutes,
				},
```

> The `applyMeetingUpdate` input type is inferred from `updateMeetingSchema`, so Step 1 makes `input.wodDefinition` / `input.wodExample` / `input.reminders` type-check. `meeting.*` reads resolve because Task 1 added the columns.

- [ ] **Step 3: Typecheck.**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the server-fn guard + meetings tests.**

Run: `bun run test src/server/`
Expected: PASS. (If a `TEST_DATABASE_URL`-gated integration suite exists, set it per repo convention — `TEST_DATABASE_URL=postgres://dev:dev@localhost:5432/tm_test bun run test src/server/` — so DB suites actually run.)

- [ ] **Step 5: Commit**

```bash
git add src/server/meetings.ts src/server/meetings-logic.ts
git commit -m "feat(meetings): persist wod definition/example + reminders on update"
```

---

## Task 10: Add the three inputs to the TMOD edit dialog

**Files:**
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx:696,735`

- [ ] **Step 1: Pass the fields in the `updateMeeting` call.** In `EditMeetingMetaDialog.onSubmit` (~line 696), the `data` object has:

```ts
						wordOfTheDay:
							String(form.get("wordOfTheDay") ?? "").trim() || undefined,
						notes: String(form.get("notes") ?? "").trim() || undefined,
```

Change to:

```ts
						wordOfTheDay:
							String(form.get("wordOfTheDay") ?? "").trim() || undefined,
						wodDefinition:
							String(form.get("wodDefinition") ?? "").trim() || undefined,
						wodExample:
							String(form.get("wodExample") ?? "").trim() || undefined,
						notes: String(form.get("notes") ?? "").trim() || undefined,
						reminders:
							String(form.get("reminders") ?? "").trim() || undefined,
```

- [ ] **Step 2: Add the form fields.** After the `wordOfTheDay` field block (~line 742, the closing `</div>` after its `<Input>`), insert:

```tsx
						<div className="space-y-2">
							<Label htmlFor="wodDefinition">Word of the day — definition</Label>
							<Input
								id="wodDefinition"
								name="wodDefinition"
								defaultValue={meeting.wodDefinition ?? ""}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="wodExample">Word of the day — example sentence</Label>
							<Input
								id="wodExample"
								name="wodExample"
								defaultValue={meeting.wodExample ?? ""}
							/>
						</div>
```

Then after the existing `notes` field block (~line 746), insert a reminders textarea:

```tsx
						<div className="space-y-2">
							<Label htmlFor="reminders">Reminders (projected slide)</Label>
							<Textarea
								id="reminders"
								name="reminders"
								rows={3}
								defaultValue={meeting.reminders ?? ""}
							/>
						</div>
```

- [ ] **Step 3: Import `Textarea` if not already imported.** Check the top of the file:

Run: `grep -n "components/ui/textarea" src/routes/club.\$clubId.meeting.\$meetingId.tsx`
If it prints nothing, add near the other `#/components/ui/*` imports:

```ts
import { Textarea } from "#/components/ui/textarea";
```

If `src/components/ui/textarea.tsx` does not exist, create it first:

Run: `bunx shadcn@latest add textarea`

- [ ] **Step 4: Typecheck + lint.**

Run: `bunx tsc --noEmit && bunx biome check src/routes/club.\$clubId.meeting.\$meetingId.tsx`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/routes/club.\$clubId.meeting.\$meetingId.tsx src/components/ui/textarea.tsx
git commit -m "feat(meeting): edit dialog inputs for wod definition/example + reminders"
```

---

## Task 11: Present route + full-screen slideshow component

**Files:**
- Create: `src/components/agenda/meeting-present.tsx`
- Create: `src/components/agenda/meeting-present.test.tsx`
- Create: `src/routes/club.$clubId_.meeting.$meetingId.present.tsx`

- [ ] **Step 1: Write the failing smoke test.** Create `src/components/agenda/meeting-present.test.tsx`. Note the `// @vitest-environment jsdom` first line and `toBeTruthy()` assertions — this repo's vitest global env is `node`, and component tests opt into jsdom per-file and do **not** use `jest-dom` matchers (mirror `src/components/brand-mark.test.tsx`):

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Slide } from "#/lib/agenda-slides";
import { MeetingPresent } from "./meeting-present";

const deck: Slide[] = [
	{
		kind: "title",
		clubName: "MCF Toastmasters Club",
		district: "District 39",
		clubNumber: "28677176",
		scheduledAt: new Date("2026-06-25T23:45:00Z"),
		timezone: "America/Chicago",
	},
	{ kind: "toastmaster", name: "Schinthia Islam" },
	{ kind: "thankYou", meetingSchedule: "2nd & 4th Thursday" },
];

describe("MeetingPresent", () => {
	afterEach(() => cleanup());

	it("renders the first slide's club name", () => {
		render(<MeetingPresent deck={deck} />);
		expect(screen.getByText("MCF Toastmasters Club")).toBeTruthy();
	});

	it("shows a slide position indicator", () => {
		render(<MeetingPresent deck={deck} />);
		expect(screen.getByText("1 / 3")).toBeTruthy();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/components/agenda/meeting-present.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component.** Create `src/components/agenda/meeting-present.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import type { Slide } from "#/lib/agenda-slides";

/** Full-screen, keyboard-driven slideshow. Read-only; position is local state. */
export function MeetingPresent({ deck }: { deck: Slide[] }) {
	const [i, setI] = useState(0);
	const last = deck.length - 1;
	const next = useCallback(() => setI((n) => Math.min(n + 1, last)), [last]);
	const prev = useCallback(() => setI((n) => Math.max(n - 1, 0)), []);

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
				e.preventDefault();
				next();
			} else if (e.key === "ArrowLeft" || e.key === "PageUp") {
				e.preventDefault();
				prev();
			} else if (e.key === "f" || e.key === "F") {
				if (document.fullscreenElement) document.exitFullscreen();
				else document.documentElement.requestFullscreen?.();
			} else if (e.key === "Escape") {
				window.history.back();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [next, prev]);

	const slide = deck[i];
	return (
		<div className="fixed inset-0 flex flex-col bg-[#4d121d] text-[#f6ecd8]">
			<button
				type="button"
				aria-label="Previous slide"
				className="absolute inset-y-0 left-0 w-1/4 cursor-w-resize opacity-0"
				onClick={prev}
			/>
			<button
				type="button"
				aria-label="Next slide"
				className="absolute inset-y-0 right-0 w-1/4 cursor-e-resize opacity-0"
				onClick={next}
			/>
			<div className="flex flex-1 items-center justify-center p-[6vmin]">
				<SlideView slide={slide} />
			</div>
			<div className="pointer-events-none absolute bottom-4 right-6 text-sm tabular-nums opacity-70">
				{`${i + 1} / ${deck.length}`}
			</div>
		</div>
	);
}

const EYEBROW = "mb-[3vmin] text-[2.2vmin] font-semibold uppercase tracking-[0.22em] text-[#e8cd8b]";
const HEAD = "text-balance text-[7vmin] font-bold leading-[1.02]";
const LEDE = "mt-[2vmin] text-[3vmin] opacity-90";

function SlideView({ slide }: { slide: Slide }) {
	switch (slide.kind) {
		case "title":
			return (
				<div className="text-center">
					<div className={EYEBROW}>
						{[slide.district, slide.clubNumber ? `Club #${slide.clubNumber}` : null]
							.filter(Boolean)
							.join(" · ")}
					</div>
					<h1 className={HEAD}>{slide.clubName}</h1>
					<div className={LEDE}>
						{new Intl.DateTimeFormat(undefined, {
							weekday: "long",
							month: "long",
							day: "numeric",
							year: "numeric",
							timeZone: slide.timezone,
						}).format(slide.scheduledAt)}
						{" · "}
						{new Intl.DateTimeFormat(undefined, {
							hour: "numeric",
							minute: "2-digit",
							timeZone: slide.timezone,
						}).format(slide.scheduledAt)}
					</div>
				</div>
			);
		case "toastmaster":
			return (
				<div className="text-center">
					<div className={EYEBROW}>Toastmaster of the Day</div>
					<h1 className={HEAD}>{slide.name}</h1>
				</div>
			);
		case "theme":
			return (
				<div className="text-center">
					<div className={EYEBROW}>Meeting Theme</div>
					<h1 className={HEAD}>“{slide.theme}”</h1>
				</div>
			);
		case "wordOfDay":
			return (
				<div className="text-center">
					<div className={EYEBROW}>Word of the Day</div>
					<h1 className={HEAD}>{slide.word}</h1>
					{slide.definition ? <div className={LEDE}>{slide.definition}</div> : null}
					{slide.example ? (
						<div className="mt-[2vmin] text-[2.6vmin] italic text-[#e8cd8b]">
							“{slide.example}”
						</div>
					) : null}
				</div>
			);
		case "geIntro":
			return (
				<div className="text-center">
					<div className={EYEBROW}>General Evaluator</div>
					<h1 className={HEAD}>{slide.name}</h1>
					<div className={LEDE}>
						{slide.team.map((t) => `${t.role} · ${t.name}`).join("   ")}
					</div>
				</div>
			);
		case "speech":
			return (
				<div className="text-center">
					<div className={EYEBROW}>{slide.label}</div>
					<h1 className={HEAD}>{slide.speaker}</h1>
					{slide.title ? <div className={LEDE}>“{slide.title}”</div> : null}
					<div className="mt-[3vmin] text-[2.4vmin] text-[#e8cd8b]">
						{[slide.projectLevel, slide.time].filter(Boolean).join(" · ")}
					</div>
				</div>
			);
		case "voteSpeaker":
			return <VoteSlide title="Vote for Best Speaker" names={slide.names} />;
		case "tableTopics":
			return (
				<div className="text-center">
					<div className={EYEBROW}>Table Topics</div>
					<h1 className={HEAD}>{slide.master}</h1>
					<div className={LEDE}>Impromptu speaking · {slide.timing}</div>
				</div>
			);
		case "voteTableTopics":
			return <VoteSlide title="Vote for Best Table Topics" names={[]} />;
		case "evalIntro":
			return (
				<div className="text-center">
					<div className={EYEBROW}>Evaluation Session</div>
					<h1 className={HEAD}>{slide.name}</h1>
					<div className={LEDE}>{slide.time}</div>
				</div>
			);
		case "evaluation":
			return (
				<div className="text-center">
					<div className={EYEBROW}>{slide.label}</div>
					<h1 className={HEAD}>{slide.evaluator}</h1>
					<div className={LEDE}>
						{slide.speaker ? `Evaluates ${slide.speaker} · ` : ""}
						{slide.time}
					</div>
				</div>
			);
		case "voteEvaluator":
			return <VoteSlide title="Vote for Best Evaluator" names={slide.names} />;
		case "generalEvaluation":
			return (
				<div className="text-center">
					<div className={EYEBROW}>General Evaluation</div>
					<h1 className={HEAD}>{slide.name}</h1>
					<div className={LEDE}>Closing remarks · {slide.time}</div>
				</div>
			);
		case "awards":
			return (
				<div className="text-center">
					<div className={EYEBROW}>Awards</div>
					<div className="flex flex-col gap-[2vmin]">
						{slide.categories.map((c) => (
							<div key={c} className="text-[5vmin] font-bold">
								{c}
							</div>
						))}
					</div>
				</div>
			);
		case "reminders":
			return (
				<div className="max-w-[70vw] text-center">
					<div className={EYEBROW}>Reminders</div>
					<div className="whitespace-pre-line text-[3.4vmin] leading-snug">
						{slide.text}
					</div>
				</div>
			);
		case "thankYou":
			return (
				<div className="text-center">
					<h1 className={HEAD}>Thank you</h1>
					{slide.meetingSchedule ? (
						<div className={LEDE}>We meet {slide.meetingSchedule}</div>
					) : null}
				</div>
			);
	}
	return null; // unreachable: switch is exhaustive over Slide["kind"]
}

function VoteSlide({ title, names }: { title: string; names: string[] }) {
	return (
		<div className="text-center">
			<div className={EYEBROW}>{title}</div>
			{names.length > 0 ? (
				<div className="flex flex-col gap-[1.5vmin]">
					{names.map((n) => (
						<div key={n} className="text-[4.5vmin] font-semibold">
							{n}
						</div>
					))}
				</div>
			) : (
				<h1 className={HEAD}>Cast your vote</h1>
			)}
		</div>
	);
}
```

- [ ] **Step 4: Run the smoke test**

Run: `bunx vitest run src/components/agenda/meeting-present.test.tsx`
Expected: PASS.

- [ ] **Step 5: Create the route.** Create `src/routes/club.$clubId_.meeting.$meetingId.present.tsx`:

```tsx
import { createFileRoute, notFound } from "@tanstack/react-router";
import { MeetingPresent } from "#/components/agenda/meeting-present";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { buildSlideDeck } from "#/lib/agenda-slides";
import { getMeeting } from "#/server/meetings";

export const Route = createFileRoute(
	"/club/$clubId_/meeting/$meetingId/present",
)({
	loader: async ({ params, location }) => {
		const club = await resolveClubOrRedirect(params.clubId, location);
		const data = await getMeeting({ data: params.meetingId });
		if (data.meeting.clubId !== club.id) throw notFound();
		return data;
	},
	component: PresentPage,
});

function PresentPage() {
	const data = Route.useLoaderData();
	const deck = buildSlideDeck(
		data.meeting,
		{
			name: data.clubName,
			clubNumber: data.clubNumber,
			district: data.clubDistrict,
			timezone: data.timezone,
			meetingSchedule: data.clubMeetingSchedule,
		},
		data.slots,
	);
	return <MeetingPresent deck={deck} />;
}
```

- [ ] **Step 6: Regenerate the route tree + typecheck.**

Run: `bun run generate-routes && bunx tsc --noEmit`
Expected: `src/routeTree.gen.ts` picks up the new route; no type errors. (Do NOT hand-edit `routeTree.gen.ts`.)

- [ ] **Step 7: Lint.**

Run: `bunx biome check src/components/agenda/meeting-present.tsx src/routes/club.\$clubId_.meeting.\$meetingId.present.tsx`
Expected: no errors (run `--write` to auto-format if needed).

- [ ] **Step 8: Commit**

```bash
git add src/components/agenda/meeting-present.tsx src/components/agenda/meeting-present.test.tsx src/routes/club.\$clubId_.meeting.\$meetingId.present.tsx src/routeTree.gen.ts
git commit -m "feat(present): full-screen meeting slideshow route + component"
```

---

## Task 12: "Present" entry-point button on the meeting page

**Files:**
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx:8,345`

- [ ] **Step 1: Import a `Presentation` icon.** The lucide import (line 8) currently:

```ts
import { CalendarDays, Loader2, MapPin, Printer, Sparkles } from "lucide-react";
```

Change to add `Presentation`:

```ts
import {
	CalendarDays,
	Loader2,
	MapPin,
	Presentation,
	Printer,
	Sparkles,
} from "lucide-react";
```

- [ ] **Step 2: Add the button** immediately after the existing "Print agenda" `</Button>` (~line 356):

```tsx
					<Button asChild variant="outline" size="sm">
						<Link
							to="/club/$clubId/meeting/$meetingId/present"
							params={{ clubId, meetingId }}
							target="_blank"
							rel="noopener noreferrer"
						>
							<Presentation />
							Present
						</Link>
					</Button>
```

- [ ] **Step 3: Typecheck + lint.**

Run: `bunx tsc --noEmit && bunx biome check src/routes/club.\$clubId.meeting.\$meetingId.tsx`
Expected: no errors.

- [ ] **Step 4: Manual verification.** Start the dev server and drive the flow end-to-end.

Run: `bun run dev`
Then in a browser (or via the `/browse` skill):
1. Open a meeting page → click **Present** → the deck opens full-screen on the Title slide.
2. Arrow keys / click-zones advance and reverse; `F` toggles fullscreen; `Esc` returns to the meeting page; the `n / N` indicator updates.
3. Open the meeting's **Edit** dialog, set a Word-of-the-Day definition + example and a Reminders line, save, reload Present → the Word-of-the-Day slide shows the definition/example and a Reminders slide appears before Thank You.

Expected: all three behave as described. (Set `GSTACK_CHROMIUM_NO_SANDBOX=1` if using `/browse` here.)

- [ ] **Step 5: Commit**

```bash
git add src/routes/club.\$clubId.meeting.\$meetingId.tsx
git commit -m "feat(meeting): Present button linking to the projected deck"
```

---

## Final verification

- [ ] **Full gate.** Run: `bun run check && bun run test && bun run build`
  Expected: Biome clean, all tests pass, build succeeds (also surfaces any remaining type errors). Fix and re-run until green.
- [ ] **Migration parity.** Run: `bun run db:generate` again — expected: **no** new diff (schema matches committed migrations; CI fails otherwise).

---

## Notes for the implementer

- **Worktree only** — all edits/commits happen in `/media/rasheed-bustamam/Extra/coding/tm-scheduler-present` on branch `feat/meeting-present-mode`. Never edit the main checkout.
- **Biome style:** tabs, double quotes, organized imports. Run `bunx biome check --write <files>` if formatting fails.
- **Client-bundle safety:** `agenda-slides.ts` is pure (no `#/db`), so it is safe to import from the route/component. Do not add DB imports to it.
- **`— open —`** is `OPEN_LABEL` from `agenda-runsheet.ts`; reuse it, never hardcode the dashes.
- **Deviation from spec (intentional):** the Thank-You slide shows the club's recurring `meetingSchedule` line rather than a computed next-meeting date (avoids an extra query in v1). Flagged for the reviewer.
- **Palette** in `meeting-present.tsx` is the mockup's maroon/gold and is explicitly slated for iteration — do not treat the exact hex values as final.
