# Present-mode Deck Template Re-skin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin the meeting present view and the `.pptx` export to the club Toastmasters template — one shared, pure layout descriptor feeding both renderers, official brand assets, and a next-meeting date on the Thank-You slide.

**Architecture:** `buildSlideDeck` stays the single pure deck builder (`Slide[]`). A new pure `slideLayout(slide)` maps each `Slide` to a presentation-agnostic `SlideLayout` (chrome + body form + lines). Both renderers (`meeting-present.tsx` on screen, `deck-to-pptx.ts` for `.pptx`) render the descriptor, so copy/layout lives in one place. Slides render inside a fixed 16:9 frame to match the export exactly.

**Tech Stack:** TanStack Start (React 19), Vitest, pptxgenjs ^4.0.1, Tailwind v4, Drizzle/pg. Package manager: **bun**. Type-check with `bun run typecheck` (the only thing that type-checks). Run one test file with `bunx vitest run <path>`.

**Spec:** `docs/superpowers/specs/2026-07-10-present-template-reskin-design.md`

**Working directory:** the isolated worktree `.claude/worktrees/present-template-reskin` (branch `feat/present-template-reskin`). All paths below are repo-relative within it.

---

## Preconditions (one-time, before Task 1)

- [ ] **Install deps + env in the worktree** (fresh worktrees have no `node_modules`/env):

```bash
cd .claude/worktrees/present-template-reskin
bun install
cp ../../../.env.local .env.local 2>/dev/null || true
```

- [ ] **Confirm the baseline is green:**

Run: `bunx vitest run src/lib/agenda-slides.test.ts src/lib/deck-to-pptx.test.ts && bun run typecheck`
Expected: PASS (this is the pre-change baseline you will be changing).

---

## File Structure

- `src/lib/agenda-slides.ts` — MODIFY. Deck model + `buildSlideDeck`. Merge theme+WOD-announce into a new `toastmasterIntro` slide; reorder; ordinal speech labels; `thankYou` gains `nextMeetingAt` + `timezone`; add `nextMeetingAt` param.
- `src/lib/slide-layout.ts` — CREATE. Shared pure descriptor `slideLayout(slide)` + `Line`/`Body`/`SlideLayout` types + section-title map + date formatters.
- `src/lib/slide-layout.test.ts` — CREATE. Unit tests for the descriptor.
- `src/server/meetings.ts` — MODIFY. Add `nextMeetingAt` to `loadMeetingDetail`.
- `src/server/meetings.integration.test.ts` — MODIFY or CREATE a focused test for `nextMeetingAt` (see Task 2 for the file check).
- `src/routes/club.$clubId_.meeting.$meetingId.present.tsx` — MODIFY. Pass `nextMeetingAt`.
- `src/routes/_authed/meetings.$id.tsx` — MODIFY. Pass `nextMeetingAt`.
- `src/assets/` — ADD normalized tight `*Tight.svg` + rasterized PNGs for the wordmark.
- `src/components/agenda/toastmasters-wordmark.tsx` — CREATE. Thin `<img>` wrapper over the brand SVGs.
- `src/components/agenda/meeting-present.tsx` — REWRITE render path to consume `SlideLayout` (chrome, forms, splash, footer, fit hook).
- `src/components/agenda/meeting-present.test.tsx` — MODIFY to the new rendered content.
- `src/lib/deck-to-pptx.ts` — REWRITE `deckToPptx` to consume `SlideLayout` (shapes, footer, logo images, solid-navy Thank-You, gold, shrink). Keep `pptxFileName`.
- `src/lib/deck-to-pptx.test.ts` — MODIFY to the new content.

---

## Task 1: Deck model + `buildSlideDeck` restructure

**Files:**
- Modify: `src/lib/agenda-slides.ts`
- Test: `src/lib/agenda-slides.test.ts`

- [ ] **Step 1: Update the failing tests first.** Replace the theme/word-of-day and ordering expectations in `src/lib/agenda-slides.test.ts`.

Change the fixture `meeting` in the `theme + word of the day` describe block area is per-test; leave the top-level fixtures. Replace the `describe("buildSlideDeck theme + word of the day", …)` block with:

```ts
describe("buildSlideDeck toastmaster intro + word of the day", () => {
	it("merges theme + WOD word into one toastmasterIntro slide", () => {
		const deck = buildSlideDeck(
			{ ...meeting, theme: "Unity", wordOfTheDay: "Synergy" },
			club,
			[],
		);
		const intro = deck.find((s) => s.kind === "toastmasterIntro");
		expect(intro).toMatchObject({ theme: "Unity", word: "Synergy" });
	});

	it("emits a standalone wordOfDay slide only when a definition/example exists", () => {
		const withDef = buildSlideDeck(
			{ ...meeting, wordOfTheDay: "Synergy", wodDefinition: "cooperation" },
			club,
			[],
		);
		expect(withDef.some((s) => s.kind === "wordOfDay")).toBe(true);

		const wordOnly = buildSlideDeck(
			{ ...meeting, wordOfTheDay: "Synergy" },
			club,
			[],
		);
		expect(wordOnly.some((s) => s.kind === "wordOfDay")).toBe(false);
		expect(wordOnly.some((s) => s.kind === "toastmasterIntro")).toBe(true);
	});

	it("omits toastmasterIntro when neither theme nor WOD is set", () => {
		const deck = buildSlideDeck(meeting, club, []);
		expect(deck.some((s) => s.kind === "toastmasterIntro")).toBe(false);
	});
});
```

In the speeches describe block, replace the single-speaker label assertion so it expects ordinal words:

```ts
	it("labels multiple speeches with ordinal words; a lone speech is 'Speech'", () => {
		const two = buildSlideDeck(meeting, club, speakers).filter(
			(s) => s.kind === "speech",
		);
		expect(two.map((s) => (s as { label: string }).label)).toEqual([
			"First Speech",
			"Second Speech",
		]);
		const one = buildSlideDeck(meeting, club, [speakers[0]]).find(
			(s) => s.kind === "speech",
		);
		expect(one).toMatchObject({ label: "Speech" });
	});
```

In `describe("buildSlideDeck full meeting ordering", …)`, set the expected kind array to the new order:

```ts
		expect(buildSlideDeck(full, club, slots).map((s) => s.kind)).toEqual([
			"title",
			"toastmaster",
			"toastmasterIntro",
			"geIntro",
			"wordOfDay",
			"speech",
			"speech",
			"voteSpeaker",
			"tableTopics",
			"voteTableTopics",
			"evalIntro",
			"evaluation",
			"evaluation",
			"voteEvaluator",
			"generalEvaluation",
			"awards",
			"reminders",
			"thankYou",
		]);
```

Add a thankYou-carries-next-meeting test near the awards+reminders block:

```ts
	it("thankYou carries nextMeetingAt + timezone when provided", () => {
		const next = new Date("2026-07-23T23:45:00Z");
		const deck = buildSlideDeck(meeting, club, [], next);
		expect(deck.at(-1)).toMatchObject({
			kind: "thankYou",
			nextMeetingAt: next,
			timezone: "America/Chicago",
		});
	});
```

- [ ] **Step 2: Run the tests to confirm they fail.**

Run: `bunx vitest run src/lib/agenda-slides.test.ts`
Expected: FAIL (unknown kind `toastmasterIntro`, ordering mismatch, missing 4th param).

- [ ] **Step 3: Update the `Slide` union in `src/lib/agenda-slides.ts`.**

Replace the `theme` member with `toastmasterIntro`, and extend `thankYou`:

```ts
	| { kind: "toastmasterIntro"; theme: string | null; word: string | null }
```

(delete `| { kind: "theme"; theme: string }`) and change the thankYou member to:

```ts
	| {
			kind: "thankYou";
			meetingSchedule: string | null;
			nextMeetingAt: Date | null;
			timezone: string;
	  };
```

- [ ] **Step 4: Add the ordinal-speech-label helper.** Above `buildSlideDeck`:

```ts
const SPEECH_ORDINALS = ["First", "Second", "Third", "Fourth", "Fifth"] as const;

/** "First Speech" … "Fifth Speech", then "Speech N"; a lone speech is "Speech". */
function speechLabel(index: number, multi: boolean): string {
	if (!multi) return "Speech";
	return index < SPEECH_ORDINALS.length
		? `${SPEECH_ORDINALS[index]} Speech`
		: `Speech ${index + 1}`;
}
```

- [ ] **Step 5: Rewrite `buildSlideDeck`'s signature + the theme/WOD/GE/speech region.**

Change the signature to accept the next meeting:

```ts
export function buildSlideDeck(
	meeting: MeetingForDeck,
	club: ClubForDeck,
	slots: AgendaSlot[],
	nextMeetingAt: Date | null = null,
): Slide[] {
```

Replace the block that currently pushes `theme` then `wordOfDay` then `geIntro` with (note the new order — intro, then GE, then the standalone WOD):

```ts
	const themeText = meeting.theme?.trim() || null;
	const wodWord = meeting.wordOfTheDay?.trim() || null;
	if (themeText || wodWord) {
		deck.push({ kind: "toastmasterIntro", theme: themeText, word: wodWord });
	}

	const generalEvaluator = byRoleName(slots, ROLE.generalEvaluator);
	if (generalEvaluator.length > 0) {
		deck.push({
			kind: "geIntro",
			name: assigneeDisplay(generalEvaluator[0]),
			team: buildLegend(slots),
		});
	}

	const wodDefinition = meeting.wodDefinition?.trim() || null;
	const wodExample = meeting.wodExample?.trim() || null;
	if (wodWord && (wodDefinition || wodExample)) {
		deck.push({
			kind: "wordOfDay",
			word: wodWord,
			definition: wodDefinition,
			example: wodExample,
		});
	}
```

(Delete the old standalone `theme` push, the old `wordOfDay` push, and the old `geIntro` push that sat before the speakers block — they are replaced above. Keep the `speakers`/`tableTopics`/`evaluators`/`awards`/`reminders` blocks that follow, but see Step 6 for the speech label.)

- [ ] **Step 6: Use ordinal labels for speeches.** In the speakers loop, change the `label` line:

```ts
				label: speechLabel(i, multi),
```

(remove the now-unused `numbered("Speech", …)` call there; `numbered` is still used elsewhere/imported — leave the import.)

- [ ] **Step 7: Give the `thankYou` slide the new fields.** Replace the final push:

```ts
	deck.push({
		kind: "thankYou",
		meetingSchedule: club.meetingSchedule,
		nextMeetingAt,
		timezone: club.timezone,
	});
```

- [ ] **Step 8: Run the tests.**

Run: `bunx vitest run src/lib/agenda-slides.test.ts`
Expected: PASS.

- [ ] **Step 9: Type-check.**

Run: `bun run typecheck`
Expected: PASS. (Two callers still pass 3 args — legal because `nextMeetingAt` defaults to null. `deck-to-pptx.ts`'s `slideContent` will fail to compile because the `theme` kind is gone; that is fixed in Task 6. If you are running tasks strictly in order, `bun run typecheck` will report errors in `deck-to-pptx.ts` — that is expected until Task 6. Scope the check to the deck file for now:)

Run: `bunx tsc --noEmit --project tsconfig.json 2>&1 | grep agenda-slides || echo "agenda-slides clean"`
Expected: `agenda-slides clean`.

- [ ] **Step 10: Commit.**

```bash
git add src/lib/agenda-slides.ts src/lib/agenda-slides.test.ts
git commit -m "feat(deck): merge toastmaster-intro slide, ordinal speech labels, next-meeting on thank-you"
```

---

## Task 2: `nextMeetingAt` query + thread into both routes

**Files:**
- Modify: `src/server/meetings.ts:75-246` (`loadMeetingDetail`)
- Modify: `src/routes/club.$clubId_.meeting.$meetingId.present.tsx`
- Modify: `src/routes/_authed/meetings.$id.tsx`
- Test: `src/server/meetings.integration.test.ts` (see Step 1)

- [ ] **Step 1: Locate the integration test file.**

Run: `ls src/server/meetings.integration.test.ts 2>/dev/null && echo EXISTS || ls src/server/*meeting*integration* 2>/dev/null`

If a meetings integration test exists, add the test below to it (reuse its existing `testDb`/seed helpers). If none exists, skip the DB test and instead rely on Task 1's unit test for the deck wiring plus the manual verification in Task 7 — do NOT invent a new integration harness here.

- [ ] **Step 2 (only if the integration file exists): Add a failing test** asserting `loadMeetingDetail` returns the next non-cancelled meeting's date. Mirror the file's existing seeding style; the assertion is:

```ts
	it("returns nextMeetingAt = the club's next non-cancelled meeting", async () => {
		// seed a club with two future meetings (m1 earlier, m2 later) and one cancelled after m2
		const detail = await getMeetingDetailForTest(m1.id); // use the file's existing loader helper
		expect(detail.nextMeetingAt?.toISOString()).toBe(m2.scheduledAt.toISOString());
	});
```

Run: `TEST_DATABASE_URL=postgres://dev:dev@localhost:5432/tm_test bunx vitest run src/server/meetings.integration.test.ts`
Expected: FAIL (`nextMeetingAt` undefined). (Ensure `tm_test` exists in the running `dev-postgres` container; the file's other tests already assume it.)

- [ ] **Step 3: Add the query in `loadMeetingDetail`.** After the `club` lookup (around line 155), add:

```ts
	// The club's next non-cancelled meeting strictly after this one (spec: relative
	// to the presented meeting, not wall-clock now). Backs the Thank-You slide.
	const [nextMeeting] = await db
		.select({ scheduledAt: meetings.scheduledAt })
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, meeting.clubId),
				gte(meetings.scheduledAt, meeting.scheduledAt),
				ne(meetings.id, meeting.id),
				ne(meetings.status, "cancelled"),
			),
		)
		.orderBy(asc(meetings.scheduledAt))
		.limit(1);
```

(`and`, `asc`, `eq`, `gte`, `ne` are already imported at the top of `meetings.ts`. `gte` with `ne(id)` avoids an exact-timestamp tie with the current meeting while still catching same-second neighbors.)

- [ ] **Step 4: Return it.** In the `return { … }` object of `loadMeetingDetail`, add:

```ts
		nextMeetingAt: nextMeeting?.scheduledAt ?? null,
```

- [ ] **Step 5: Pass it in the present route.** In `src/routes/club.$clubId_.meeting.$meetingId.present.tsx`, extend the `buildSlideDeck` call:

```ts
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
		data.nextMeetingAt,
	);
```

- [ ] **Step 6: Pass it in the authed meeting route.** In `src/routes/_authed/meetings.$id.tsx`, add `nextMeetingAt` to the destructured loader data and to the `buildSlideDeck` call:

```ts
	const deck = buildSlideDeck(
		meeting,
		{
			name: clubName,
			clubNumber,
			district: clubDistrict,
			timezone,
			meetingSchedule: clubMeetingSchedule,
		},
		slots,
		nextMeetingAt,
	);
```

Add `nextMeetingAt` to the `Route.useLoaderData()` destructuring block near the top of that component (the block that already lists `clubName`, `clubNumber`, `clubDistrict`, `clubMeetingSchedule`, …).

- [ ] **Step 7: Run the DB test (if added) + typecheck the touched files.**

Run: `TEST_DATABASE_URL=postgres://dev:dev@localhost:5432/tm_test bunx vitest run src/server/meetings.integration.test.ts` (if Step 2 applied)
Expected: PASS.

Run: `bunx tsc --noEmit 2>&1 | grep -E 'meetings\.ts|meetings\.\$id|present\.tsx' || echo "routes clean"`
Expected: `routes clean` (deck-to-pptx errors from Task 1 may still show; ignore until Task 6).

- [ ] **Step 8: Commit.**

```bash
git add src/server/meetings.ts src/routes/club.\$clubId_.meeting.\$meetingId.present.tsx src/routes/_authed/meetings.\$id.tsx src/server/meetings.integration.test.ts
git commit -m "feat(meetings): expose nextMeetingAt and thread it into the deck"
```

---

## Task 3: Shared layout descriptor `slide-layout.ts`

**Files:**
- Create: `src/lib/slide-layout.ts`
- Test: `src/lib/slide-layout.test.ts`

- [ ] **Step 1: Write the failing tests.** Create `src/lib/slide-layout.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Slide } from "./agenda-slides";
import { slideLayout } from "./slide-layout";

const contentHeader = (slide: Slide) => {
	const l = slideLayout(slide);
	return l.chrome === "content" ? l.header : `splash:${l.tone}`;
};

describe("slideLayout headers (no 'Session', title-only)", () => {
	it("maps section titles without the word Session", () => {
		expect(contentHeader({ kind: "wordOfDay", word: "Synergy", definition: null, example: null })).toBe("Word of the Day");
		expect(contentHeader({ kind: "evalIntro", name: "Riyaz", time: "4–6 minutes" })).toBe("Speech Evaluation");
		expect(contentHeader({ kind: "generalEvaluation", name: "Riyaz", time: "2 minutes" })).toBe("General Evaluation");
		expect(contentHeader({ kind: "awards", categories: ["Best Speaker"] })).toBe("Award Presentation");
	});

	it("speech header uses the slide's ordinal label", () => {
		expect(contentHeader({ kind: "speech", label: "First Speech", speaker: "Jagpal", title: null, projectLevel: null, time: "5–7 minutes" })).toBe("First Speech");
	});
});

describe("slideLayout bodies", () => {
	it("toastmaster body is the name only (header carries the role)", () => {
		const l = slideLayout({ kind: "toastmaster", name: "Faisal Ali" });
		expect(l).toMatchObject({ chrome: "content", header: "Toastmaster" });
		if (l.chrome === "content" && l.body.form === "centered") {
			expect(l.body.lines).toEqual([{ role: "head", text: "Faisal Ali" }]);
		} else {
			throw new Error("expected centered body");
		}
	});

	it("speech is left bullets, project shown only when present", () => {
		const withProject = slideLayout({ kind: "speech", label: "First Speech", speaker: "Jagpal", title: "AI", projectLevel: "Level 3", time: "5–7 minutes" });
		if (withProject.chrome === "content" && withProject.body.form === "bullets") {
			expect(withProject.body.items).toEqual([
				"Speaker: Jagpal",
				"Speech Title: “AI”",
				"Project: Level 3",
				"Time: 5–7 minutes",
			]);
		} else {
			throw new Error("expected bullets");
		}
		const noProject = slideLayout({ kind: "speech", label: "First Speech", speaker: "Jagpal", title: null, projectLevel: null, time: "5–7 minutes" });
		if (noProject.chrome === "content" && noProject.body.form === "bullets") {
			expect(noProject.body.items).toEqual(["Speaker: Jagpal", "Time: 5–7 minutes"]);
		}
	});

	it("vote-speaker shows the two prompts then bulleted names", () => {
		const l = slideLayout({ kind: "voteSpeaker", names: ["Jagpal", "Farhanaaz"] });
		if (l.chrome === "content" && l.body.form === "centered") {
			expect(l.body.lines).toEqual([
				{ role: "head", text: "Ask for speaking time." },
				{ role: "head", text: "Please Vote for Best Speaker:" },
				{ role: "name", text: "Jagpal" },
				{ role: "name", text: "Farhanaaz" },
			]);
		} else {
			throw new Error("expected centered");
		}
	});

	it("GE team line lists filled roles only", () => {
		const l = slideLayout({
			kind: "geIntro",
			name: "Riyaz",
			team: [
				{ role: "Grammarian", name: "Priya" },
				{ role: "Timer", name: "— open —" },
			],
		});
		if (l.chrome === "content" && l.body.form === "centered") {
			const muted = l.body.lines.filter((x) => x.role === "muted").map((x) => x.text);
			expect(muted.join("")).toContain("Grammarian: Priya");
			expect(muted.join("")).not.toContain("open");
		} else {
			throw new Error("expected centered");
		}
	});

	it("title splash sub carries district, club #, date, start time", () => {
		const l = slideLayout({ kind: "title", clubName: "MCF", district: "District 39", clubNumber: "28677176", scheduledAt: new Date("2026-07-10T00:00:00Z"), timezone: "UTC" });
		expect(l.chrome).toBe("splash");
		if (l.chrome === "splash") {
			expect(l.tone).toBe("light");
			expect(l.headline).toBe("MCF");
			const texts = l.sub.map((s) => s.text ?? "");
			expect(texts).toContain("District 39");
			expect(texts).toContain("Club #28677176");
			expect(texts.some((t) => t.startsWith("Start time:"))).toBe(true);
		}
	});

	it("thankYou splash is dark, gold headline, real next-meeting date", () => {
		const l = slideLayout({ kind: "thankYou", meetingSchedule: "2nd Thu", nextMeetingAt: new Date("2026-07-23T18:00:00Z"), timezone: "UTC" });
		expect(l.chrome).toBe("splash");
		if (l.chrome === "splash") {
			expect(l.tone).toBe("dark");
			expect(l.headline).toBe("Thank You");
			const texts = l.sub.map((s) => s.text ?? "");
			expect(texts).toContain("Next Meeting:");
		}
	});

	it("thankYou falls back to meetingSchedule when there is no next meeting", () => {
		const l = slideLayout({ kind: "thankYou", meetingSchedule: "2nd & 4th Thu", nextMeetingAt: null, timezone: "UTC" });
		if (l.chrome === "splash") {
			expect(l.sub.map((s) => s.text)).toContain("We meet 2nd & 4th Thu");
		}
	});
});
```

- [ ] **Step 2: Run to confirm failure.**

Run: `bunx vitest run src/lib/slide-layout.test.ts`
Expected: FAIL (`Cannot find module './slide-layout'`).

- [ ] **Step 3: Create `src/lib/slide-layout.ts`.**

```ts
// The one place that decides what each slide SAYS and how it's laid out. Both
// renderers — meeting-present.tsx (screen) and deck-to-pptx.ts (.pptx) — consume
// this descriptor, so copy/layout never drifts between them. Pure + unit-tested.
import type { Slide } from "./agenda-slides";

export type LineRole = "head" | "name" | "strong" | "muted" | "spacer";
/** One rendered line. `text` is absent for `spacer`. */
export type Line = { role: LineRole; text?: string };

export type Body =
	| { form: "centered"; lines: Line[] }
	| { form: "bullets"; items: string[] }
	| { form: "numbered"; items: string[] }
	| {
			form: "word";
			word: string;
			definition: string | null;
			example: string | null;
	  };

export type SlideLayout =
	| { chrome: "splash"; tone: "light" | "dark"; headline: string; sub: Line[] }
	| { chrome: "content"; header: string; body: Body };

const head = (text: string): Line => ({ role: "head", text });
const name = (text: string): Line => ({ role: "name", text });
const muted = (text: string): Line => ({ role: "muted", text });
const strong = (text: string): Line => ({ role: "strong", text });
const SPACER: Line = { role: "spacer" };

const OPEN_LABEL = "— open —"; // mirrors agenda-runsheet; filtered out of team line

function fmtDate(d: Date, tz: string, withWeekday: boolean): string {
	return new Intl.DateTimeFormat(undefined, {
		weekday: withWeekday ? "long" : undefined,
		year: "numeric",
		month: "long",
		day: "numeric",
		timeZone: tz,
	}).format(d);
}
function fmtTime(d: Date, tz: string): string {
	return new Intl.DateTimeFormat(undefined, {
		hour: "numeric",
		minute: "2-digit",
		timeZone: tz,
	}).format(d);
}

/** The footer's compact date (month day, year), shared by both renderers. */
export function footerDate(d: Date, tz: string): string {
	return fmtDate(d, tz, false);
}

const content = (header: string, body: Body): SlideLayout => ({
	chrome: "content",
	header,
	body,
});

export function slideLayout(slide: Slide): SlideLayout {
	switch (slide.kind) {
		case "title": {
			const sub: Line[] = [];
			if (slide.district) sub.push(muted(slide.district));
			if (slide.clubNumber) sub.push(muted(`Club #${slide.clubNumber}`));
			sub.push(muted(fmtDate(slide.scheduledAt, slide.timezone, true)));
			sub.push(muted(`Start time: ${fmtTime(slide.scheduledAt, slide.timezone)}`));
			return { chrome: "splash", tone: "light", headline: slide.clubName, sub };
		}
		case "toastmaster":
			return content("Toastmaster", {
				form: "centered",
				lines: [head(slide.name)],
			});
		case "toastmasterIntro": {
			const lines: Line[] = [];
			if (slide.theme) lines.push(head("Meeting Theme:"), head(`“${slide.theme}”`));
			if (slide.theme && slide.word) lines.push(SPACER);
			if (slide.word) lines.push(head("Word of the Day:"), head(`“${slide.word}”`));
			return content("Toastmaster Intro", { form: "centered", lines });
		}
		case "geIntro": {
			const lines: Line[] = [head("General Evaluator:"), head(slide.name)];
			const teamMembers = slide.team.filter((t) => t.name !== OPEN_LABEL);
			if (teamMembers.length > 0) {
				lines.push(
					muted(
						`Team — ${teamMembers.map((t) => `${t.role}: ${t.name}`).join(", ")}`,
					),
				);
			}
			return content("General Evaluator Intro", { form: "centered", lines });
		}
		case "wordOfDay":
			return content("Word of the Day", {
				form: "word",
				word: slide.word,
				definition: slide.definition,
				example: slide.example,
			});
		case "speech": {
			const items = [`Speaker: ${slide.speaker}`];
			if (slide.title) items.push(`Speech Title: “${slide.title}”`);
			if (slide.projectLevel) items.push(`Project: ${slide.projectLevel}`);
			items.push(`Time: ${slide.time}`);
			return content(slide.label, { form: "bullets", items });
		}
		case "voteSpeaker":
			return content("Vote for Best Speaker", {
				form: "centered",
				lines: [
					head("Ask for speaking time."),
					head("Please Vote for Best Speaker:"),
					...slide.names.map(name),
				],
			});
		case "tableTopics":
			return content("Table Topics", {
				form: "bullets",
				items: [
					`Table Topic Master: ${slide.master}`,
					"Impromptu Speeches",
					`Speaker time: ${slide.timing}`,
				],
			});
		case "voteTableTopics":
			return content("Vote for Best Table Topic", {
				form: "centered",
				lines: [
					head("Ask for Table Topics times."),
					head("Please Vote for Best Table Topic Speaker:"),
				],
			});
		case "evalIntro":
			return content("Speech Evaluation", {
				form: "centered",
				lines: [head("General Evaluator:"), head(slide.name), strong(`Time: ${slide.time}`)],
			});
		case "evaluation": {
			const lines: Line[] = [head(`Evaluator: ${slide.evaluator}`)];
			if (slide.speaker) lines.push(head(`Speaker: ${slide.speaker}`));
			lines.push(strong(`Time: ${slide.time}`));
			return content("Speech Evaluation", { form: "centered", lines });
		}
		case "voteEvaluator":
			return content("Speech Evaluation", {
				form: "centered",
				lines: [
					head("Ask for timer’s report:"),
					head("Please Vote for Best Evaluator:"),
					...slide.names.map(name),
				],
			});
		case "generalEvaluation":
			return content("General Evaluation", {
				form: "centered",
				lines: [head("General Evaluator"), head("Closing Remarks"), strong(`Time: ${slide.time}`)],
			});
		case "awards":
			return content("Award Presentation", {
				form: "numbered",
				items: slide.categories,
			});
		case "reminders":
			return content("Reminders", {
				form: "centered",
				lines: slide.text.split("\n").map((t) => (t.trim() ? muted(t) : SPACER)),
			});
		case "thankYou":
			return {
				chrome: "splash",
				tone: "dark",
				headline: "Thank You",
				sub: thankYouSub(slide),
			};
	}
	return ((_x: never): never => {
		throw new Error("unreachable");
	})(slide);
}

function thankYouSub(slide: Extract<Slide, { kind: "thankYou" }>): Line[] {
	const sub: Line[] = [
		muted("CONGRATULATIONS on another great learning session!"),
	];
	if (slide.nextMeetingAt) {
		sub.push(
			SPACER,
			muted("Next Meeting:"),
			strong(fmtDate(slide.nextMeetingAt, slide.timezone, true)),
			strong(fmtTime(slide.nextMeetingAt, slide.timezone)),
		);
	} else if (slide.meetingSchedule) {
		sub.push(muted(`We meet ${slide.meetingSchedule}`));
	}
	return sub;
}
```

> NOTE: the club name is intentionally NOT part of the `thankYou` sub — the sample
> shows it there, but our data carries the club name on the title slide, so the
> Thank-You renderer prepends it from the title slide if desired (Task 5/6 already
> show the club name in the content footer; the closing splash keeps the
> congratulations + next-meeting lines).

- [ ] **Step 4: Run the tests.**

Run: `bunx vitest run src/lib/slide-layout.test.ts`
Expected: PASS. (If the title test's `fmtDate` output differs by locale/timezone, assert on `startsWith`/`contains` as written — the tests avoid asserting an exact localized date except via `Club #…` and `Start time:` prefixes.)

- [ ] **Step 5: Type-check the module.**

Run: `bunx tsc --noEmit 2>&1 | grep slide-layout || echo "slide-layout clean"`
Expected: `slide-layout clean`.

- [ ] **Step 6: Commit.**

```bash
git add src/lib/slide-layout.ts src/lib/slide-layout.test.ts
git commit -m "feat(deck): shared pure slideLayout descriptor for both renderers"
```

---

## Task 4: Brand logo assets + wordmark component

**Files:**
- Add: `src/assets/ToastmastersWordmarkColorTight.svg`, `…WhiteTight.svg`, and tight transparent PNGs `…ColorTight.png`, `…WhiteTight.png`
- Create: `src/components/agenda/toastmasters-wordmark.tsx`

- [ ] **Step 1: Produce tight, consistent wordmark assets.** The vendored `ToastmastersWordmarkColor.svg` / `…White.svg` sit on a padded `viewBox 0 0 612 792`. Rasterize each SVG's real artwork bounds to a tight transparent PNG and write a tight SVG, using the shared browse Chromium (no second headless dep). Run from the worktree root:

```bash
export GSTACK_CHROMIUM_NO_SANDBOX=1
B=$HOME/.claude/skills/gstack/browse/dist/browse
for tone in Color White; do
  cp "src/assets/ToastmastersWordmark${tone}.svg" "/tmp/wm-${tone}.svg"
  # Render the SVG and screenshot its tight bounding box to a transparent PNG.
  $B goto "file:///tmp/wm-${tone}.svg"
  $B viewport 1600x600 --scale 2
  $B screenshot "src/assets/ToastmastersWordmark${tone}Tight.png" --selector svg
done
```

Then verify each PNG is a wide, tight wordmark (roughly 5:1) and transparent:

Run: `python3 -c "import struct;\nfor f in ['ColorTight','WhiteTight']:\n d=open(f'src/assets/ToastmastersWordmark{f}.png','rb').read(33);\n w,h=struct.unpack('>II',d[16:24]);\n print(f, w,'x',h, 'ratio', round(w/h,2))"`
Expected: ratio ≈ 4.5–6.0 for both (not portrait). If a PNG came out padded/portrait, re-run with `--selector` targeting the inner artwork group, or fall back to committing the White/Black PNGs which are already tight and using `ToastmastersWordmarkColor.png` cropped.

- [ ] **Step 2: Create the wordmark component** `src/components/agenda/toastmasters-wordmark.tsx`:

```tsx
import colorMark from "#/assets/ToastmastersWordmarkColorTight.png";
import whiteMark from "#/assets/ToastmastersWordmarkWhiteTight.png";

/** The official Toastmasters International wordmark. `tone="color"` for light
 *  grounds (navy/maroon), `tone="white"` for the navy footer + Thank-You. */
export function ToastmastersWordmark({
	tone,
	className,
	style,
}: {
	tone: "color" | "white";
	className?: string;
	style?: React.CSSProperties;
}) {
	return (
		<img
			src={tone === "color" ? colorMark : whiteMark}
			alt="Toastmasters International"
			className={className}
			style={style}
		/>
	);
}
```

> If `#/assets/*.png` imports need a type shim, TanStack/Vite already resolves image imports to URL strings; no change needed. If `tsc` complains about the `.png` module, add `declare module "*.png";` to an existing ambient d.ts (e.g. `src/vite-env.d.ts` if present) — check first with `ls src/*.d.ts`.

- [ ] **Step 3: Type-check.**

Run: `bunx tsc --noEmit 2>&1 | grep -E 'toastmasters-wordmark|\.png' || echo "wordmark clean"`
Expected: `wordmark clean`.

- [ ] **Step 4: Commit.**

```bash
git add src/assets/ToastmastersWordmark*Tight.* src/components/agenda/toastmasters-wordmark.tsx
git commit -m "chore(assets): tight brand wordmark assets + wordmark component"
```

---

## Task 5: Rewrite the present renderer

**Files:**
- Modify: `src/components/agenda/meeting-present.tsx`
- Test: `src/components/agenda/meeting-present.test.tsx`

- [ ] **Step 1: Update the tests** in `src/components/agenda/meeting-present.test.tsx` to the new content. Read the existing file first for its render helper and imports, then assert on the new copy. Representative assertions to include (adapt to the file's existing render harness):

```ts
	it("renders a section-title header (no club prefix) and the footer club+date", () => {
		render(<MeetingPresent deck={deck} clubName="MCF Toastmasters Club" />);
		expect(screen.getByText("Word of the Day")).toBeInTheDocument();
		// club name appears in the footer, not the header
		expect(screen.getAllByText(/MCF Toastmasters Club/).length).toBeGreaterThan(0);
	});

	it("renders vote prompts from the descriptor", () => {
		render(<MeetingPresent deck={voteDeck} clubName="MCF" />);
		expect(screen.getByText("Please Vote for Best Speaker:")).toBeInTheDocument();
	});
```

Run: `bunx vitest run src/components/agenda/meeting-present.test.tsx`
Expected: FAIL (old markup/content).

- [ ] **Step 2: Rewrite `meeting-present.tsx`.** Replace the whole file with the descriptor-driven renderer. Keep the keyboard nav, click zones, and `PptxDownloadButton` from the current file; swap the per-kind `SlideView` switch for a `SlideLayout` renderer, add the 16:9 letterbox frame, the footer, and the fit hook.

```tsx
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PptxDownloadButton } from "#/components/club/pptx-download-button";
import { ToastmastersWordmark } from "#/components/agenda/toastmasters-wordmark";
import type { Slide } from "#/lib/agenda-slides";
import { footerDate, slideLayout, type Line, type SlideLayout } from "#/lib/slide-layout";

// Official brand palette (sampled from the wordmark) so chrome matches the logo.
const INK = "#2b2b2b";
const MAROON = "#770D29";
const NAVY = "#004062";
const GROUND = "#f3f4f4";
const MUTED = "#565656";
const GOLD = "#f3dd94";

export function MeetingPresent({
	deck,
	clubName,
	onExit,
}: {
	deck: Slide[];
	clubName: string;
	onExit?: () => void;
}) {
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
				if (document.fullscreenElement) document.exitFullscreen();
				else onExit?.();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [next, prev, onExit]);

	const slide = deck[i];
	const layout = slideLayout(slide);
	const title = deck.find((s) => s.kind === "title");
	const fdate = title ? footerDate(title.scheduledAt, title.timezone) : "";

	return (
		<div className="fixed inset-0 flex items-center justify-center bg-black">
			<div className="absolute top-[2vmin] right-[2vmin] z-20">
				<PptxDownloadButton deck={deck} clubName={clubName} />
			</div>
			<button type="button" aria-label="Previous slide" className="absolute inset-y-0 left-0 z-10 w-1/4 cursor-w-resize opacity-0" onClick={prev} />
			<button type="button" aria-label="Next slide" className="absolute inset-y-0 right-0 z-10 w-1/4 cursor-e-resize opacity-0" onClick={next} />

			{/* Letterboxed 16:9 frame so screen matches the .pptx exactly. */}
			<div
				className="relative"
				style={{
					aspectRatio: "16 / 9",
					width: "min(100vw, calc(100vh * 16 / 9))",
					containerType: "inline-size",
				}}
			>
				{layout.chrome === "splash" ? (
					<Splash layout={layout} />
				) : (
					<ContentSlide layout={layout} clubName={clubName} date={fdate} />
				)}
			</div>

			<div className="absolute bottom-[1.5vmin] left-1/2 -translate-x-1/2 text-[1.6vmin] tabular-nums text-white/70">
				{i + 1} / {deck.length}
			</div>
		</div>
	);
}

/** Shrink the body font-scale until it fits its box (guard for long outliers). */
function useFitScale(deps: unknown[]) {
	const ref = useRef<HTMLDivElement>(null);
	const [scale, setScale] = useState(1);
	useLayoutEffect(() => {
		setScale(1);
	}, deps);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		let s = 1;
		while (s > 0.6 && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) {
			s -= 0.05;
			el.style.fontSize = `${s * 100}%`;
		}
		setScale(s);
	});
	return { ref, scale };
}

function Splash({ layout }: { layout: Extract<SlideLayout, { chrome: "splash" }> }) {
	const dark = layout.tone === "dark";
	return (
		<div
			className="flex h-full w-full flex-col items-center justify-center px-[8cqw] text-center"
			style={
				dark
					? { background: `linear-gradient(180deg, #0a4f78 0%, #002a41 100%)`, color: "#eaf1f6" }
					: { background: GROUND, color: INK }
			}
		>
			<ToastmastersWordmark tone={dark ? "white" : "color"} style={{ width: dark ? "21cqw" : "25cqw" }} />
			<div className="my-[3.4cqw] h-px w-[58cqw]" style={{ background: dark ? "rgba(255,255,255,.55)" : NAVY }} />
			<div className="text-[6.4cqw] font-extrabold leading-tight" style={{ color: dark ? GOLD : INK }}>
				{layout.headline}
			</div>
			<div className="mt-[2.6cqw] flex flex-col gap-[0.7cqw]">
				{layout.sub.map((l, idx) => (
					<LineView key={idx} line={l} splash />
				))}
			</div>
		</div>
	);
}

function ContentSlide({ layout, clubName, date }: { layout: Extract<SlideLayout, { chrome: "content" }>; clubName: string; date: string }) {
	const { ref } = useFitScale([layout]);
	return (
		<div className="flex h-full w-full flex-col" style={{ background: GROUND, color: INK }}>
			<header className="px-[6cqw] pt-[5cqw]">
				<div className="text-[3.9cqw] font-extrabold leading-tight">{layout.header}</div>
				<div className="mt-[1.5cqw] h-[0.7cqw] w-[8cqw] rounded" style={{ background: MAROON }} />
			</header>
			<div ref={ref} className="flex min-h-0 flex-1 flex-col justify-center overflow-hidden px-[7cqw] py-[2.5cqw]">
				<BodyView body={layout.body} />
			</div>
			<footer className="flex h-[8.5cqw] items-center justify-between px-[5cqw]" style={{ background: NAVY }}>
				<ToastmastersWordmark tone="white" style={{ width: "13cqw" }} />
				<div className="text-right leading-tight text-white">
					<div className="text-[2.4cqw] font-bold">{clubName}</div>
					<div className="text-[2cqw] opacity-90">{date}</div>
				</div>
			</footer>
		</div>
	);
}

function BodyView({ body }: { body: Extract<SlideLayout, { chrome: "content" }>["body"] }) {
	if (body.form === "word") {
		return (
			<div className="text-center">
				<div className="text-[8.6cqw] leading-none">{body.word}</div>
				{body.definition ? <div className="mt-[4cqw] text-[2.9cqw] leading-snug" style={{ color: MUTED }}>{body.definition}</div> : null}
				{body.example ? <div className="mt-[3.4cqw] text-[2.9cqw] italic leading-snug" style={{ color: MUTED }}>{`“${body.example}”`}</div> : null}
			</div>
		);
	}
	if (body.form === "bullets") {
		return (
			<div className="flex flex-col gap-[3cqw]">
				{body.items.map((t, idx) => (
					<div key={idx} className="flex gap-[1.6cqw] text-[4.3cqw] font-extrabold leading-tight">
						<span>•</span>
						<span>{t}</span>
					</div>
				))}
			</div>
		);
	}
	if (body.form === "numbered") {
		return (
			<div className="flex flex-col gap-[3cqw]">
				{body.items.map((t, idx) => (
					<div key={idx} className="flex gap-[2cqw] text-[5cqw] font-extrabold leading-tight">
						<span className="tabular-nums">{idx + 1}.</span>
						<span>{t}</span>
					</div>
				))}
			</div>
		);
	}
	return (
		<div className="flex flex-col items-center gap-[2.6cqw] text-center">
			{body.lines.map((l, idx) => (
				<LineView key={idx} line={l} />
			))}
		</div>
	);
}

function LineView({ line, splash }: { line: Line; splash?: boolean }) {
	if (line.role === "spacer") return <div className="h-[2.4cqw]" />;
	if (line.role === "name") return <div className="text-[4.2cqw] font-extrabold leading-tight">{`• ${line.text}`}</div>;
	if (line.role === "muted") return <div className="text-[2.5cqw] leading-snug" style={{ color: splash ? undefined : MUTED }}>{line.text}</div>;
	if (line.role === "strong") return <div className="text-[2.8cqw] font-semibold leading-tight">{line.text}</div>;
	return <div className="text-[5cqw] font-extrabold leading-tight text-balance">{line.text}</div>;
}
```

> NOTE on the fit hook: it mutates `el.style.fontSize` and reads `scrollHeight`. Because it runs after paint, the common case (fits at 100%) does nothing. `scale` is returned but unused by callers beyond forcing the effect — safe to drop the `scale` state if lint flags it; keep the `ref`.

- [ ] **Step 2: Run the component tests.**

Run: `bunx vitest run src/components/agenda/meeting-present.test.tsx`
Expected: PASS.

- [ ] **Step 3: Type-check.**

Run: `bunx tsc --noEmit 2>&1 | grep meeting-present || echo "present clean"`
Expected: `present clean`.

- [ ] **Step 4: Commit.**

```bash
git add src/components/agenda/meeting-present.tsx src/components/agenda/meeting-present.test.tsx
git commit -m "feat(present): render the shared slideLayout with template chrome"
```

---

## Task 6: Rewrite the `.pptx` renderer

**Files:**
- Modify: `src/lib/deck-to-pptx.ts`
- Test: `src/lib/deck-to-pptx.test.ts`

- [ ] **Step 1: Update the tests.** In `src/lib/deck-to-pptx.test.ts`, remove the `slideContent` import/assertions (that function is gone) and assert on the new descriptor + a smoke test of `deckToPptx`. Replace the `slideContent`-based cases with:

```ts
import { slideLayout } from "./slide-layout";
// …
describe("pptx via slideLayout", () => {
	it("builds the whole deck without throwing", () => {
		const deck = buildSlideDeck(meeting, club, fullSlots, new Date("2026-07-23T23:45:00Z"));
		expect(() => deckToPptx(PptxGenJS, deck)).not.toThrow();
		expect(deckToPptx(PptxGenJS, deck)).toBeTruthy();
	});

	it("descriptor drives copy (spot check)", () => {
		const l = slideLayout({ kind: "voteEvaluator", names: ["A", "B"] });
		expect(l.chrome === "content" && l.header).toBe("Speech Evaluation");
	});
});
```

Run: `bunx vitest run src/lib/deck-to-pptx.test.ts`
Expected: FAIL (removed `slideContent`, or the old assertions).

- [ ] **Step 2: Rewrite `deck-to-pptx.ts`.** Keep the top-of-file doc comment, the `PptxGenJS` type-only import, and `pptxFileName`/`fileSafe`. Delete `SlideContent`/`slideContent`/`voteContent`/`formatTitleDate`. Replace `deckToPptx` with a `SlideLayout`-driven renderer. All positions in inches (LAYOUT_WIDE = 13.33×7.5), font sizes in points derived from the mockup's cqw × 9.6 (≈ % of 960pt width).

```ts
import type PptxGenJS from "pptxgenjs";
import type { Slide } from "./agenda-slides";
import { footerDate, slideLayout, type Body, type Line, type SlideLayout } from "./slide-layout";
import colorMarkPng from "#/assets/ToastmastersWordmarkColorTight.png";
import whiteMarkPng from "#/assets/ToastmastersWordmarkWhiteTight.png";

type PptxCtor = typeof PptxGenJS;
type Presentation = InstanceType<PptxCtor>;

const INK = "2b2b2b";
const MAROON = "770D29";
const NAVY = "004062";
const GROUND = "f3f4f4";
const MUTED = "565656";
const GOLD = "f3dd94";

const W = 13.33;
const H = 7.5;
const FOOT_H = 1.13; // ~8.5% of width

/** Vite resolves the png import to a URL string; the pptx runs client-side, so
 *  fetch the bytes at build time is not possible — use the imported data/URL.
 *  pptxgenjs addImage accepts a `path` (URL) in the browser. */
function addWordmark(s: any, tone: "color" | "white", opts: { x: number; y: number; w: number }) {
	s.addImage({ path: tone === "color" ? colorMarkPng : whiteMarkPng, x: opts.x, y: opts.y, w: opts.w, h: opts.w / 5 });
}

export function deckToPptx(Pptx: PptxCtor, deck: Slide[]): Presentation {
	const pptx = new Pptx();
	pptx.layout = "LAYOUT_WIDE";
	const title = deck.find((s) => s.kind === "title");
	const fdate = title ? footerDate(title.scheduledAt, title.timezone) : "";
	const club = title?.clubName ?? "";

	for (const slide of deck) {
		const layout = slideLayout(slide);
		const s = pptx.addSlide();
		if (layout.chrome === "splash") renderSplash(s, layout);
		else renderContent(s, layout, club, fdate);
	}
	return pptx;
}

function renderSplash(s: any, layout: Extract<SlideLayout, { chrome: "splash" }>) {
	const dark = layout.tone === "dark";
	s.background = { color: dark ? NAVY : GROUND };
	addWordmark(s, dark ? "white" : "color", { x: (W - 3.4) / 2, y: 1.5, w: 3.4 });
	s.addShape("line", { x: (W - 6) / 2, y: 2.5, w: 6, h: 0, line: { color: dark ? "FFFFFF" : NAVY, width: 1 } });
	s.addText(layout.headline, { x: 0.8, y: 2.8, w: W - 1.6, h: 1.1, align: "center", bold: true, fontSize: 48, color: dark ? GOLD : INK, fit: "shrink" });
	s.addText(
		layout.sub.filter((l) => l.role !== "spacer").map((l, i, arr) => ({ text: l.text ?? "", options: { breakLine: i < arr.length - 1, bold: l.role === "strong", fontSize: l.role === "strong" ? 22 : 20, color: dark ? "DBE6EE" : MUTED } })),
		{ x: 0.8, y: 4.2, w: W - 1.6, h: 2.4, align: "center", valign: "top", lineSpacingMultiple: 1.15 },
	);
}

function renderContent(s: any, layout: Extract<SlideLayout, { chrome: "content" }>, club: string, date: string) {
	s.background = { color: GROUND };
	// Header + maroon rule
	s.addText(layout.header, { x: 0.8, y: 0.6, w: W - 1.6, h: 0.8, align: "left", bold: true, fontSize: 34, color: INK });
	s.addShape("rect", { x: 0.8, y: 1.5, w: 1.05, h: 0.09, fill: { color: MAROON } });
	// Body (between header ~1.9 and footer)
	renderBody(s, layout.body);
	// Footer bar
	s.addShape("rect", { x: 0, y: H - FOOT_H, w: W, h: FOOT_H, fill: { color: NAVY } });
	addWordmark(s, "white", { x: 0.67, y: H - FOOT_H + 0.36, w: 1.7 });
	s.addText(
		[
			{ text: club, options: { breakLine: true, bold: true, fontSize: 15 } },
			{ text: date, options: { fontSize: 12, color: "D9E4EC" } },
		],
		{ x: W - 5.0, y: H - FOOT_H + 0.18, w: 4.33, h: FOOT_H - 0.36, align: "right", valign: "middle", color: "FFFFFF" },
	);
}

const BODY = { x: 1.0, y: 2.0, w: W - 2.0, h: H - FOOT_H - 2.2 };

function renderBody(s: any, body: Body) {
	if (body.form === "word") {
		const runs: any[] = [{ text: body.word, options: { fontSize: 82, breakLine: true, color: INK } }];
		if (body.definition) runs.push({ text: `\n${body.definition}`, options: { fontSize: 26, color: MUTED, breakLine: true } });
		if (body.example) runs.push({ text: `\n“${body.example}”`, options: { fontSize: 26, italic: true, color: MUTED } });
		s.addText(runs, { ...BODY, align: "center", valign: "middle" });
		return;
	}
	if (body.form === "bullets") {
		s.addText(
			body.items.map((t, i) => ({ text: t, options: { breakLine: i < body.items.length - 1, bullet: { characterCode: "2022" } } })),
			{ ...BODY, align: "left", valign: "middle", bold: true, fontSize: 40, color: INK, fit: "shrink", lineSpacingMultiple: 1.3 },
		);
		return;
	}
	if (body.form === "numbered") {
		s.addText(
			body.items.map((t, i) => ({ text: t, options: { breakLine: i < body.items.length - 1, bullet: { type: "number" } } })),
			{ ...BODY, align: "left", valign: "middle", bold: true, fontSize: 46, color: INK, fit: "shrink", lineSpacingMultiple: 1.3 },
		);
		return;
	}
	// centered lines
	const runs = body.lines
		.filter((l) => l.role !== "spacer")
		.map((l, i, arr) => lineRun(l, i < arr.length - 1));
	s.addText(runs, { ...BODY, align: "center", valign: "middle", color: INK, fit: "shrink", lineSpacingMultiple: 1.2 });
}

function lineRun(l: Line, br: boolean) {
	const base = { breakLine: br } as any;
	if (l.role === "name") return { text: `•  ${l.text}`, options: { ...base, bold: true, fontSize: 40 } };
	if (l.role === "muted") return { text: l.text ?? "", options: { ...base, fontSize: 26, color: MUTED } };
	if (l.role === "strong") return { text: l.text ?? "", options: { ...base, bold: true, fontSize: 28 } };
	return { text: l.text ?? "", options: { ...base, bold: true, fontSize: 46 } };
}

/** Sanitize a string for use inside a filename (drop path/reserved chars). */
function fileSafe(s: string): string {
	return s.replace(/[/\\?%*:|"<>]/g, "").replace(/\s+/g, " ").trim();
}

export function pptxFileName(clubName: string, scheduledAt: Date, timezone: string): string {
	const isoDay = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: timezone }).format(scheduledAt);
	const club = fileSafe(clubName) || "Club";
	return `${club} - ${isoDay} Agenda.pptx`;
}
```

> Two `pptxgenjs` gotchas to verify while implementing:
> - `addImage({ path })` in the browser fetches the URL. The Vite PNG import is a bundled URL, which works. If it does not resolve at runtime, switch to `data:` by importing the PNG `?inline` (Vite: `import png from "…png?inline"` gives a data URI) and pass `{ data: png }`.
> - `addShape` shape names are on `pptx.ShapeType` in v4 — if the string `"rect"`/`"line"` errors, use `pptx.ShapeType.rect` / `pptx.ShapeType.line`.
> Replace the loose `any` types with `InstanceType<PptxCtor>` slide types where the compiler allows; `any` is used above only to keep the plan readable.

- [ ] **Step 3: Run the pptx tests.**

Run: `bunx vitest run src/lib/deck-to-pptx.test.ts`
Expected: PASS.

- [ ] **Step 4: Full type-check (everything should be green now).**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/deck-to-pptx.ts src/lib/deck-to-pptx.test.ts
git commit -m "feat(pptx): render the shared slideLayout with template chrome"
```

---

## Task 7: Full verification (gate before finishing)

- [ ] **Step 1: Whole suite + lint + types.**

Run: `bun run typecheck && bun run check && bunx vitest run`
Expected: all PASS. (If `bunx vitest run` needs the DB suites, set `TEST_DATABASE_URL=postgres://dev:dev@localhost:5432/tm_test`.)

- [ ] **Step 2: Drive the present view in a real browser** (evidence, not just tests). Start the dev server and open a meeting's present route.

```bash
bun run dev &   # port 3000
# then, with the browse skill:
export GSTACK_CHROMIUM_NO_SANDBOX=1
B=$HOME/.claude/skills/gstack/browse/dist/browse
# Use the dev-login + a seeded meeting id (see local e2e notes), then:
$B goto "http://localhost:3000/club/<clubId>/meeting/<meetingId>/present"
$B screenshot /tmp/present-title.png
$B press ArrowRight ; $B screenshot /tmp/present-2.png
$B press ArrowRight ; $B screenshot /tmp/present-3.png
```

Read each screenshot and confirm: title splash (color wordmark + navy rule + club/district/date/start time), content slides (title-only header + maroon rule, navy footer with white wordmark left + club/date right), Thank-You (navy, gold "Thank You", next-meeting date). Expected: matches the approved mockup.

- [ ] **Step 3: Download + inspect the `.pptx`.** Click the download button (or call the export) and open the file; verify the same chrome, solid-navy Thank-You, and that text is real/editable. If any slide clips, confirm `fit: "shrink"` is applied to that body.

- [ ] **Step 4: Final commit if any tweaks were needed.**

```bash
git add -A && git commit -m "chore(present): calibration tweaks from browser verification"
```

- [ ] **Step 5: Clean up the worktree after landing** (per repo worktree hygiene): once merged, `git worktree remove` this worktree so the root `bun run check` doesn't traverse it.

---

## Notes for the implementer

- **Bun, not npm.** `bun install`, `bun run <script>`, `bunx vitest run <path>`.
- **Only `bun run typecheck` type-checks.** `bun run build`/`vitest` transpile without checking types.
- **Worktree discipline:** stay in `.claude/worktrees/present-template-reskin`; never edit the main checkout.
- **`build` mutates `routeTree.gen.ts`** — do not run `bun run build` to verify; use `typecheck`. If you do build, `git checkout src/routeTree.gen.ts` before committing.
- **cqw units** in the present view require the 16:9 frame to set `container-type: inline-size` (it does). Do not swap them for `vw`.
