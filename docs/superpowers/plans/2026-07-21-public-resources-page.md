# Public Resources Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public (no-auth) `/resources` area with six markdown articles and five printable, GavelUp-branded role-sheet PDFs, replacing the placeholder `/_authed/resources` page.

**Architecture:** Public TanStack Start routes render markdown articles (bundled via Vite `?raw` glob) inside a lightweight public shell. Article/card metadata lives in a typed registry (`src/data/resources.ts`); prose lives in `content/resources/*.md`. Role sheets are static PDFs in `public/role-sheets/`, generated once by a `@react-pdf/renderer` build script and committed.

**Tech Stack:** React 19, TanStack Start (file-based routing), Tailwind v4 (config-less), `react-markdown` + `remark-gfm`, `@react-pdf/renderer`, Vitest, Biome (tabs + double quotes), Bun.

**Spec:** `docs/superpowers/specs/2026-07-21-public-resources-page-design.md` · **Issue:** #310

**Conventions for every task:**
- Biome formats with **tabs** and **double quotes**; import alias `#/*` → `src/*`.
- Every commit message ends with the repo's standard trailers:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01LKto2ngDjn2FzxcTDL285r
  ```
  (Omitted from the sample commands below for brevity — always append them.)
- `bun run typecheck` is the only real type gate. Run `bun run check` (Biome) before each commit.

---

## File Structure

**Create:**
- `content/resources/what-to-expect.md` — article prose
- `content/resources/meeting-roles.md` — article prose
- `content/resources/evaluation-crc.md` — article prose
- `content/resources/table-topics.md` — article prose
- `content/resources/guest-faq.md` — article prose
- `content/resources/what-is-pathways.md` — article prose
- `src/data/resource-content.ts` — slug → markdown loader (Vite glob)
- `src/components/resources/resources-shell.tsx` — public header/footer wrapper
- `src/routes/resources.index.tsx` — `/resources` card grid
- `src/routes/resources.$slug.tsx` — `/resources/$slug` article
- `scripts/build-role-sheets.ts` — PDF generator (dev-only, run manually)
- `public/role-sheets/{timer,ah-counter,grammarian,ballot-counter,general-evaluator}.pdf` — generated, committed
- `src/data/resources.guard.test.ts` — registry ↔ md ↔ pdf integrity guard

**Modify:**
- `src/data/resources.ts` — replace mock array with the real typed registry
- `src/styles.css` — add `.prose-gavelup` block (Biome-excluded; safe to edit)
- `src/routes/index.tsx` — add Resources links (header + footer)
- `src/routes/club.$clubId.index.tsx` — add a "what to expect" link
- `package.json` — add `build:role-sheets` script + deps

**Delete:**
- `src/routes/_authed/resources.tsx` — the placeholder (nav link target moves to the public route)

---

## Task 1: Install dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the markdown libraries**

Run:
```bash
bun add react-markdown remark-gfm
```

- [ ] **Step 2: Verify they resolve**

Run:
```bash
bun pm ls | grep -E "react-markdown|remark-gfm"
```
Expected: both packages listed with a version.

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore(resources): add react-markdown + remark-gfm"
```

---

## Task 2: Typed content registry

Replace the mock `resources.ts` with the real six-entry registry plus a `slug` and optional `downloads`, and a `resourceBySlug` lookup.

**Files:**
- Modify: `src/data/resources.ts`

- [ ] **Step 1: Rewrite `src/data/resources.ts`**

```ts
/**
 * Registry of public resource articles (#310). Metadata lives here (typed);
 * the prose body of each article lives in `content/resources/<slug>.md` and is
 * loaded by `resource-content.ts`. Kept free of `#/db` so client routes import
 * it safely.
 */

export type ResourceCategory = "Pathways" | "Roles" | "Meeting";

export type ResourceIcon = "book" | "clock" | "list" | "users" | "doc" | "star";

/** Icon-tile gradient tone, chosen by category. */
export type ResourceTone = "lagoon" | "palm" | "ink";

/** A downloadable role sheet. `href` is served from `public/role-sheets/`. */
export interface RoleSheet {
	label: string;
	href: string;
}

export interface Resource {
	/** URL slug and markdown filename (`content/resources/<slug>.md`). */
	slug: string;
	cat: ResourceCategory;
	icon: ResourceIcon;
	tone: ResourceTone;
	title: string;
	/** Card blurb. */
	desc: string;
	/** Printable sheets shown on the article (only `meeting-roles` in v1). */
	downloads?: RoleSheet[];
}

export function resourceToneGradient(tone: ResourceTone): string {
	switch (tone) {
		case "palm":
			return "linear-gradient(150deg, var(--palm), #245238)";
		case "ink":
			return "linear-gradient(150deg, var(--sea-ink-soft), var(--sea-ink))";
		default:
			return "linear-gradient(150deg, var(--lagoon), var(--lagoon-deep))";
	}
}

export const resources: Resource[] = [
	{
		slug: "what-to-expect",
		cat: "Meeting",
		icon: "clock",
		tone: "ink",
		title: "What to expect at a meeting",
		desc: "The running order of a typical Toastmasters meeting, start to finish.",
	},
	{
		slug: "meeting-roles",
		cat: "Roles",
		icon: "users",
		tone: "palm",
		title: "Meeting roles",
		desc: "What each role does — plus printable sheets for the hands-on roles.",
		downloads: [
			{ label: "Timer's log", href: "/role-sheets/timer.pdf" },
			{ label: "Ah-Counter's log", href: "/role-sheets/ah-counter.pdf" },
			{ label: "Grammarian's log", href: "/role-sheets/grammarian.pdf" },
			{
				label: "Ballot / Vote Counter tally",
				href: "/role-sheets/ballot-counter.pdf",
			},
			{
				label: "General Evaluator notes",
				href: "/role-sheets/general-evaluator.pdf",
			},
		],
	},
	{
		slug: "evaluation-crc",
		cat: "Roles",
		icon: "star",
		tone: "palm",
		title: "How to give a great evaluation",
		desc: "The Commend–Recommend–Commend method for helpful, encouraging feedback.",
	},
	{
		slug: "table-topics",
		cat: "Meeting",
		icon: "list",
		tone: "ink",
		title: "Table Topics guide",
		desc: "How the impromptu-speaking segment works and how to answer with confidence.",
	},
	{
		slug: "guest-faq",
		cat: "Meeting",
		icon: "doc",
		tone: "ink",
		title: "First-time guest FAQ",
		desc: "Do I have to speak? What do I wear? Is it free? Your questions answered.",
	},
	{
		slug: "what-is-pathways",
		cat: "Pathways",
		icon: "book",
		tone: "lagoon",
		title: "What is Pathways?",
		desc: "A short intro to the Toastmasters learning experience.",
	},
];

/** Look up a resource by its URL slug. */
export function resourceBySlug(slug: string): Resource | undefined {
	return resources.find((r) => r.slug === slug);
}
```

- [ ] **Step 2: Typecheck (expect the deleted-mock fallout)**

Run:
```bash
bun run typecheck
```
Expected: errors ONLY in `src/routes/_authed/resources.tsx` (it imports the removed `resourceCategories`). That file is deleted in Task 9 — ignore those errors for now. No other file should error.

- [ ] **Step 3: Commit**

```bash
git add src/data/resources.ts
git commit -m "feat(resources): real typed content registry"
```

---

## Task 3: Markdown article files

Create the six article bodies. Content is **generic Toastmasters International convention**; the maintainer fact-checks before merge.

**Files:**
- Create: `content/resources/what-to-expect.md`
- Create: `content/resources/meeting-roles.md`
- Create: `content/resources/evaluation-crc.md`
- Create: `content/resources/table-topics.md`
- Create: `content/resources/guest-faq.md`
- Create: `content/resources/what-is-pathways.md`

- [ ] **Step 1: Create `content/resources/what-to-expect.md`**

```markdown
# What to expect at a Toastmasters meeting

New to Toastmasters? Here's what a typical club meeting looks like, so you can
relax and enjoy your first visit.

## Before you arrive

- **Guests are always welcome** — you can just watch, or join in as much as you like.
- Meetings usually run **60–90 minutes** and start on time, so aim to arrive about 10 minutes early.
- Dress is usually business casual, but come as you are — nobody will mind.

## The running order

Most clubs follow a similar agenda:

1. **Opening** — the Sergeant at Arms and the Toastmaster of the Day welcome everyone and set the tone.
2. **Prepared speeches** — one to three members deliver speeches from their Pathways projects, usually 5–7 minutes each.
3. **Table Topics** — a fast, fun segment where members (and willing guests) answer a surprise question with a 1–2 minute impromptu response.
4. **Evaluations** — each prepared speaker receives a short, supportive evaluation of what worked and what to try next.
5. **Reports** — the Timer, Ah-Counter, and Grammarian share what they noticed, and the General Evaluator reflects on the meeting as a whole.
6. **Awards and closing** — many clubs vote for Best Speaker, Best Evaluator, and Best Table Topics before wrapping up.

## Will I have to speak?

Only if you want to. As a guest you're welcome to simply observe. If you're
feeling brave, Table Topics is a low-pressure way to try a minute of impromptu
speaking — but it's always your choice.

## What happens next

If you enjoy your visit, ask any member how to join. Most clubs let you attend a
few times as a guest before you decide.
```

- [ ] **Step 2: Create `content/resources/meeting-roles.md`**

```markdown
# Meeting roles

Every Toastmasters meeting runs on volunteers who each take a role. Rotating
through the roles is how members build skills — and it's what keeps a meeting
flowing. Here's what each role does, with printable sheets for the hands-on
roles at the bottom.

## Leadership roles

- **Toastmaster of the Day** — the meeting's host and MC. Introduces each segment and keeps things moving.
- **General Evaluator** — evaluates the meeting itself and leads the evaluation team, then gives an overall report.
- **Table Topics Master** — prepares and runs the impromptu-speaking segment.

## Speaking and evaluating

- **Speakers** — deliver prepared speeches from their Pathways projects.
- **Evaluators** — give each speaker a short, encouraging evaluation (see *How to give a great evaluation*).

## Functionary roles

- **Timer** — times every speaker and signals green / amber / red as they reach their timing windows.
- **Ah-Counter** — notes filler words ("um", "ah", "so", "like") and crutch phrases to help members speak more cleanly.
- **Grammarian** — introduces the Word of the Day and notes memorable language, both good and improvable.
- **Ballot / Vote Counter** — collects and tallies the votes for the meeting's awards.

## Support roles

- **Sergeant at Arms** — sets up the room, opens the meeting, and handles logistics.

## Printable role sheets

Download the blank, print-at-home sheets below for the Timer, Ah-Counter,
Grammarian, Ballot/Vote Counter, and General Evaluator.
```

- [ ] **Step 3: Create `content/resources/evaluation-crc.md`**

```markdown
# How to give a great evaluation

A good evaluation is the most valuable gift in Toastmasters: specific,
encouraging feedback that helps a speaker grow. The classic structure is
**Commend – Recommend – Commend**.

## The CRC method

1. **Commend** — Start with what genuinely worked. Be specific: "Your opening story about the airport pulled me in immediately."
2. **Recommend** — Offer one or two concrete suggestions for next time. Focus on the highest-impact change, not a long list: "Next time, try pausing after your key point to let it land."
3. **Commend** — Close with encouragement that leaves the speaker motivated to speak again.

## Principles

- **Evaluate the speech, not the person.** Talk about what you saw and heard.
- **Use "I" statements.** "I found myself wanting more eye contact" lands better than "You didn't make eye contact."
- **Be specific.** "Great job" helps no one; name the moment.
- **Pick one or two things to improve.** Too much feedback is impossible to act on.
- **Match your evaluation to the project's objectives** — each Pathways project lists what the speaker was working on.

## Before the meeting

Ask your speaker whether there's anything in particular they'd like you to watch
for. It makes your evaluation land — and it's what they'll remember most.
```

- [ ] **Step 4: Create `content/resources/table-topics.md`**

```markdown
# Table Topics guide

Table Topics is the part of the meeting where members practise **impromptu
speaking** — answering a surprise question with a short, unprepared response of
about **one to two minutes**. It's fast, friendly, and often the most fun part
of the meeting.

## Why it matters

Most of the speaking we do in real life is unrehearsed: answering a question in
a meeting, giving a toast, thinking on your feet. Table Topics builds exactly
that muscle, in a supportive setting.

## How to answer

- **Pause first.** A few seconds to gather your thoughts is fine — it reads as confident, not slow.
- **Take a position.** Pick an angle and commit, even if you don't feel strongly. A clear opinion is easier to speak to than a balanced one.
- **Use a simple structure.** A handy one is **PREP**: state your **P**oint, give a **R**eason, add an **E**xample, then restate your **P**oint.
- **Tell a story.** A quick personal anecdote is almost always more engaging than an abstract answer.
- **Don't apologise.** Skip "I don't really know about this" — just start.

## For guests

Table Topics is optional for guests, but it's the easiest, lowest-pressure way
to try speaking. Give it a go if you're curious — everyone in the room is
rooting for you.
```

- [ ] **Step 5: Create `content/resources/guest-faq.md`**

```markdown
# First-time guest FAQ

Thinking about visiting a Toastmasters club? Here are the questions guests ask
most.

## Do I have to speak?

No. You're welcome to just watch. If you'd like to try, the Table Topics segment
is a friendly one-to-two-minute way to dip a toe in — but it's always your
choice.

## What should I wear?

Whatever's comfortable. Most members lean business casual, but you won't be out
of place in what you'd wear to work or class.

## How long is a meeting?

Usually **60–90 minutes**, start to finish. Try to arrive about 10 minutes early
to settle in and meet a few people.

## Does it cost anything to visit?

Visiting as a guest is typically **free**. If you decide to join, membership
involves dues (a mix of Toastmasters International and local club fees) — ask a
club officer for the current amount.

## How do I join?

Come a few times to be sure the club is a good fit, then let any officer know
you'd like to join. They'll walk you through membership and help you get started
on a Pathways learning path.

## Will I be put on the spot?

Never without your say-so. Toastmasters is built on a supportive, encouraging
atmosphere — everyone there was once a nervous first-timer too.
```

- [ ] **Step 6: Create `content/resources/what-is-pathways.md`**

```markdown
# What is Pathways?

**Pathways** is Toastmasters International's learning experience — the modern
curriculum members use to build speaking and leadership skills at their own pace.

## How it works

- You choose a **path** aligned with your goals. There are several to pick from, each focused on a theme such as presentation skills, leadership, or persuasion.
- Each path is organised into **five levels**, moving from foundational skills to more advanced projects.
- Each level contains **projects** — a mix of required and elective — and most projects are completed by giving a speech at a club meeting.
- You track your progress online through **Base Camp**, Toastmasters' learning portal.

## Choosing a path

When you join, a short assessment recommends paths based on what you want to work
on. There's no wrong choice — every path builds core communication and
leadership skills, and you can take more than one over time.

## Why members like it

Pathways turns "I want to get better at speaking" into a concrete sequence of
projects, each with clear objectives and built-in feedback from your club. You
always know what you're working on next.
```

- [ ] **Step 7: Commit**

```bash
git add content/resources
git commit -m "feat(resources): six markdown article bodies"
```

---

## Task 4: Markdown loader

Load each article's raw markdown at build time via Vite's glob import (no runtime `fs`; works in SSR and browser).

**Files:**
- Create: `src/data/resource-content.ts`

- [ ] **Step 1: Create `src/data/resource-content.ts`**

```ts
/**
 * Loads the raw markdown body for each resource article (#310). The markdown is
 * bundled at build time via Vite's glob import (`?raw`), so there is no runtime
 * filesystem access — this resolves in SSR and in the browser alike.
 */

const files = import.meta.glob("/content/resources/*.md", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

// Map "/content/resources/what-to-expect.md" → "what-to-expect".
const bySlug: Record<string, string> = {};
for (const [path, body] of Object.entries(files)) {
	const slug = path.split("/").pop()?.replace(/\.md$/, "");
	if (slug) bySlug[slug] = body;
}

/** The raw markdown body for a resource slug, or `undefined` if none exists. */
export function getResourceMarkdown(slug: string): string | undefined {
	return bySlug[slug];
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
bun run typecheck
```
Expected: no new errors from this file (the `_authed/resources.tsx` errors from Task 2 persist until Task 9).

- [ ] **Step 3: Commit**

```bash
git add src/data/resource-content.ts
git commit -m "feat(resources): markdown glob loader"
```

---

## Task 5: Role-sheet PDF build script + generated PDFs

**Files:**
- Create: `scripts/build-role-sheets.ts`
- Modify: `package.json`
- Create (generated): `public/role-sheets/*.pdf`

- [ ] **Step 1: Create `scripts/build-role-sheets.ts`**

```ts
/**
 * Generates the blank, GavelUp-branded role sheets served from
 * `public/role-sheets/*.pdf` (#310). Original content — NO Toastmasters
 * International copyrighted material. Run manually and commit the output:
 *
 *   bun run build:role-sheets
 *
 * Mirrors the server minutes-PDF pattern (src/server/minutes-pdf-logic.ts):
 * `@react-pdf/renderer` with `React.createElement` (this is a `.ts` file, so no
 * JSX). Never imported by app code.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	Document,
	Page,
	renderToBuffer,
	StyleSheet,
	Text,
	View,
} from "@react-pdf/renderer";
import { createElement as h, type ReactNode } from "react";
import { TOASTMASTERS_DISCLAIMER } from "../src/lib/brand";

const C = { ink: "#1f2933", soft: "#52606d", line: "#b8c1cc", faint: "#eef1f4" };

const s = StyleSheet.create({
	page: {
		paddingTop: 40,
		paddingBottom: 54,
		paddingHorizontal: 44,
		fontSize: 10,
		fontFamily: "Helvetica",
		color: C.ink,
		lineHeight: 1.35,
	},
	brand: {
		fontSize: 10,
		fontFamily: "Helvetica-Bold",
		color: C.soft,
		letterSpacing: 2,
	},
	title: { fontSize: 20, fontFamily: "Helvetica-Bold", marginTop: 2 },
	subtitle: { fontSize: 10, color: C.soft, marginTop: 2 },
	metaRow: { flexDirection: "row", gap: 18, marginTop: 14 },
	metaField: {
		flexGrow: 1,
		flexBasis: 0,
		borderBottomWidth: 1,
		borderBottomColor: C.line,
		paddingBottom: 2,
		fontSize: 9,
		color: C.soft,
	},
	sectionTitle: {
		fontSize: 12,
		fontFamily: "Helvetica-Bold",
		marginTop: 18,
		marginBottom: 6,
	},
	note: { fontSize: 9, color: C.soft, marginBottom: 6 },
	thRow: {
		flexDirection: "row",
		borderTopWidth: 1,
		borderColor: C.ink,
		backgroundColor: C.faint,
	},
	th: {
		fontSize: 9,
		fontFamily: "Helvetica-Bold",
		padding: 5,
		borderRightWidth: 1,
		borderColor: C.line,
	},
	tr: { flexDirection: "row" },
	td: {
		minHeight: 22,
		padding: 5,
		borderBottomWidth: 1,
		borderRightWidth: 1,
		borderColor: C.line,
	},
	tdText: { fontSize: 9 },
	blankLine: {
		borderBottomWidth: 1,
		borderColor: C.line,
		height: 22,
		marginTop: 8,
	},
	box: { borderWidth: 1, borderColor: C.line, padding: 10, marginTop: 8 },
	footer: {
		position: "absolute",
		left: 44,
		right: 44,
		bottom: 26,
		fontSize: 7,
		color: C.soft,
		borderTopWidth: 1,
		borderTopColor: C.line,
		paddingTop: 6,
	},
});

type Col = { label: string; flex: number };

/** A header row plus one row per entry in `rows` (empty strings = blank cells). */
function table(cols: Col[], rows: string[][]): ReactNode {
	const head = h(
		View,
		{ style: s.thRow },
		cols.map((c, i) =>
			h(Text, { key: i, style: [s.th, { flexGrow: c.flex, flexBasis: 0 }] }, c.label),
		),
	);
	const body = rows.map((row, r) =>
		h(
			View,
			{ key: r, style: s.tr },
			cols.map((c, i) =>
				h(
					View,
					{ key: i, style: [s.td, { flexGrow: c.flex, flexBasis: 0 }] },
					h(Text, { style: s.tdText }, row[i] ?? ""),
				),
			),
		),
	);
	return h(View, {}, head, ...body);
}

/** `n` blank rows of `cols` empty cells. */
function blank(n: number, cols: number): string[][] {
	return Array.from({ length: n }, () => Array.from({ length: cols }, () => ""));
}

/** `n` ruled blank lines for free-text notes. */
function lines(n: number): ReactNode[] {
	return Array.from({ length: n }, (_, i) => h(View, { key: i, style: s.blankLine }));
}

function header(title: string, subtitle: string): ReactNode {
	return h(
		View,
		{},
		h(Text, { style: s.brand }, "GAVELUP"),
		h(Text, { style: s.title }, title),
		h(Text, { style: s.subtitle }, subtitle),
		h(
			View,
			{ style: s.metaRow },
			h(Text, { style: s.metaField }, "Club:"),
			h(Text, { style: s.metaField }, "Date:"),
			h(Text, { style: s.metaField }, "Your name:"),
		),
	);
}

function sheet(title: string, subtitle: string, body: ReactNode[]): ReactNode {
	return h(
		Document,
		{},
		h(
			Page,
			{ size: "LETTER", style: s.page },
			header(title, subtitle),
			...body,
			h(Text, { style: s.footer, fixed: true }, TOASTMASTERS_DISCLAIMER),
		),
	);
}

// ---- The five sheets -------------------------------------------------------

function timer(): ReactNode {
	return sheet("Timer's log", "Time each speaker and signal green / amber / red at their windows.", [
		h(Text, { key: "a", style: s.sectionTitle }, "Standard timing windows"),
		h(
			Text,
			{ key: "b", style: s.note },
			"Confirm each speaker's assigned time before the meeting — projects vary.",
		),
		h(
			View,
			{ key: "c" },
			table(
				[
					{ label: "Assignment", flex: 2 },
					{ label: "Green (min)", flex: 1 },
					{ label: "Amber", flex: 1 },
					{ label: "Red (max)", flex: 1 },
				],
				[
					["Ice Breaker", "4:00", "5:00", "6:00"],
					["Prepared speech", "5:00", "6:00", "7:00"],
					["Evaluation", "2:00", "2:30", "3:00"],
					["Table Topics", "1:00", "1:30", "2:00"],
				],
			),
		),
		h(Text, { key: "d", style: s.sectionTitle }, "Timing log"),
		h(
			View,
			{ key: "e" },
			table(
				[
					{ label: "Speaker / role", flex: 3 },
					{ label: "Assigned time", flex: 2 },
					{ label: "Actual time", flex: 2 },
					{ label: "Color", flex: 1 },
				],
				blank(12, 4),
			),
		),
	]);
}

function ahCounter(): ReactNode {
	return sheet("Ah-Counter's log", "Tally filler words and crutch phrases; report totals at the end.", [
		h(
			View,
			{ key: "a" },
			table(
				[
					{ label: "Speaker", flex: 2 },
					{ label: "Um / Ah", flex: 1 },
					{ label: "So", flex: 1 },
					{ label: "Like", flex: 1 },
					{ label: "And / But", flex: 1 },
					{ label: "You know", flex: 1 },
					{ label: "Other", flex: 1 },
					{ label: "Total", flex: 1 },
				],
				blank(12, 8),
			),
		),
	]);
}

function grammarian(): ReactNode {
	return sheet("Grammarian's log", "Introduce the Word of the Day and note memorable language.", [
		h(Text, { key: "a", style: s.sectionTitle }, "Word of the Day"),
		h(
			View,
			{ key: "b", style: s.box },
			h(Text, {}, "Word:"),
			h(View, { style: s.blankLine }),
			h(Text, { style: { marginTop: 8 } }, "Meaning / part of speech:"),
			h(View, { style: s.blankLine }),
			h(Text, { style: { marginTop: 8 } }, "Used well by:"),
			h(View, { style: s.blankLine }),
		),
		h(Text, { key: "c", style: s.sectionTitle }, "Good use of language"),
		...lines(6),
		h(Text, { key: "d", style: s.sectionTitle }, "Language to improve"),
		...lines(6),
	]);
}

function award(title: string): ReactNode[] {
	return [
		h(Text, { key: `${title}-t`, style: s.sectionTitle }, title),
		h(
			View,
			{ key: `${title}-g` },
			table(
				[
					{ label: "Nominee", flex: 3 },
					{ label: "Tally", flex: 2 },
					{ label: "Total", flex: 1 },
				],
				blank(5, 3),
			),
		),
		h(
			View,
			{ key: `${title}-w`, style: s.metaRow },
			h(Text, { style: s.metaField }, "Winner:"),
		),
	];
}

function ballotCounter(): ReactNode {
	return sheet("Ballot / Vote Counter tally", "Collect and tally the votes for each award.", [
		...award("Best Speaker"),
		...award("Best Evaluator"),
		...award("Best Table Topics"),
	]);
}

function generalEvaluator(): ReactNode {
	return sheet("General Evaluator notes", "Evaluate the meeting as a whole and lead the evaluation team.", [
		h(Text, { key: "a", style: s.sectionTitle }, "Meeting flow & timing"),
		...lines(4),
		h(Text, { key: "b", style: s.sectionTitle }, "Evaluators (evaluate the evaluators)"),
		...lines(4),
		h(Text, { key: "c", style: s.sectionTitle }, "Language roles (Timer / Ah-Counter / Grammarian)"),
		...lines(3),
		h(Text, { key: "d", style: s.sectionTitle }, "Environment & Sergeant at Arms"),
		...lines(3),
		h(Text, { key: "e", style: s.sectionTitle }, "Overall commendations"),
		...lines(3),
		h(Text, { key: "f", style: s.sectionTitle }, "Overall recommendations"),
		...lines(3),
	]);
}

// ---- Emit ------------------------------------------------------------------

const OUT = resolve(process.cwd(), "public", "role-sheets");
mkdirSync(OUT, { recursive: true });

const sheets: Array<[string, () => ReactNode]> = [
	["timer.pdf", timer],
	["ah-counter.pdf", ahCounter],
	["grammarian.pdf", grammarian],
	["ballot-counter.pdf", ballotCounter],
	["general-evaluator.pdf", generalEvaluator],
];

for (const [file, build] of sheets) {
	const buf = await renderToBuffer(build() as Parameters<typeof renderToBuffer>[0]);
	writeFileSync(resolve(OUT, file), buf);
	console.log(`wrote public/role-sheets/${file}`);
}
```

- [ ] **Step 2: Add the `build:role-sheets` script to `package.json`**

In the `"scripts"` block, add (next to the other `build:*` scripts):
```json
"build:role-sheets": "bun run scripts/build-role-sheets.ts",
```

- [ ] **Step 3: Generate the PDFs**

Run:
```bash
bun run build:role-sheets
```
Expected output:
```
wrote public/role-sheets/timer.pdf
wrote public/role-sheets/ah-counter.pdf
wrote public/role-sheets/grammarian.pdf
wrote public/role-sheets/ballot-counter.pdf
wrote public/role-sheets/general-evaluator.pdf
```

- [ ] **Step 4: Sanity-check the output**

Run:
```bash
ls -la public/role-sheets/ && file public/role-sheets/timer.pdf
```
Expected: five non-empty `.pdf` files; `timer.pdf` reports as `PDF document`.

- [ ] **Step 5: Typecheck the script**

Run:
```bash
bun run typecheck
```
Expected: no new errors from `scripts/build-role-sheets.ts` (the pre-existing `_authed/resources.tsx` errors persist until Task 9).

- [ ] **Step 6: Commit**

```bash
git add scripts/build-role-sheets.ts package.json public/role-sheets
git commit -m "feat(resources): generate blank role-sheet PDFs"
```

---

## Task 6: Prose styling

**Files:**
- Modify: `src/styles.css`

- [ ] **Step 1: Append the `.prose-gavelup` block to `src/styles.css`**

Add at the end of the file:
```css
/* Resource article prose (#310) — brand-token markdown styling. */
.prose-gavelup {
	color: var(--sea-ink);
	line-height: 1.65;
}
.prose-gavelup h1 {
	font-family: var(--font-display, "Fraunces", serif);
	font-size: 1.875rem;
	font-weight: 600;
	letter-spacing: -0.02em;
	margin: 0 0 0.5rem;
}
.prose-gavelup h2 {
	font-size: 1.25rem;
	font-weight: 600;
	letter-spacing: -0.01em;
	margin: 1.75rem 0 0.5rem;
}
.prose-gavelup h3 {
	font-size: 1.05rem;
	font-weight: 600;
	margin: 1.25rem 0 0.4rem;
}
.prose-gavelup p {
	margin: 0.75rem 0;
}
.prose-gavelup ul,
.prose-gavelup ol {
	margin: 0.75rem 0;
	padding-left: 1.35rem;
}
.prose-gavelup ul {
	list-style: disc;
}
.prose-gavelup ol {
	list-style: decimal;
}
.prose-gavelup li {
	margin: 0.3rem 0;
}
.prose-gavelup strong {
	font-weight: 700;
}
.prose-gavelup a {
	color: var(--lagoon-deep);
	text-decoration: underline;
}
.prose-gavelup blockquote {
	border-left: 3px solid var(--line);
	padding-left: 1rem;
	margin: 1rem 0;
	color: var(--sea-ink-soft);
}
.prose-gavelup table {
	width: 100%;
	border-collapse: collapse;
	margin: 1rem 0;
	font-size: 0.9rem;
}
.prose-gavelup th,
.prose-gavelup td {
	border: 1px solid var(--line);
	padding: 0.4rem 0.6rem;
	text-align: left;
}
.prose-gavelup th {
	background: var(--surface-strong);
	font-weight: 700;
}
.prose-gavelup code {
	font-family: ui-monospace, monospace;
	font-size: 0.85em;
	background: var(--surface-strong);
	padding: 0.1rem 0.3rem;
	border-radius: 4px;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/styles.css
git commit -m "feat(resources): brand-token prose styling"
```

---

## Task 7: Public shell component

A shared header/footer wrapper for the public resource pages — the lightweight "escape hatch" header (brand mark → home) and the disclaimer footer (spec §Signed-in UX / #317).

**Files:**
- Create: `src/components/resources/resources-shell.tsx`

- [ ] **Step 1: Create `src/components/resources/resources-shell.tsx`**

```tsx
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { BrandMark } from "#/components/brand-mark";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";

/**
 * Public wrapper for the `/resources` pages (#310). These routes render OUTSIDE
 * the `_authed` sidebar shell, so a signed-in visitor who lands here gets this
 * lightweight header (brand mark → home) as the way back. Wrapping public
 * routes in the full app shell for authed users is tracked in #317.
 */
export function ResourcesShell({ children }: { children: ReactNode }) {
	return (
		<div className="flex min-h-svh flex-col bg-[var(--foam)] text-[var(--sea-ink)]">
			<header className="mx-auto flex w-full max-w-4xl items-center justify-between px-5 py-5 sm:px-8">
				<Link to="/" className="no-underline">
					<BrandMark size="sm" />
				</Link>
				<Link
					to="/resources"
					className="text-sm font-semibold text-[var(--sea-ink)] no-underline hover:underline"
				>
					All resources
				</Link>
			</header>
			<main className="mx-auto w-full max-w-4xl flex-1 px-5 pb-16 sm:px-8">
				{children}
			</main>
			<footer className="border-t border-[var(--line)]">
				<div className="mx-auto w-full max-w-4xl px-5 py-8 sm:px-8">
					<p className="max-w-3xl text-xs leading-relaxed text-[var(--sea-ink-soft)]">
						{TOASTMASTERS_DISCLAIMER}
					</p>
				</div>
			</footer>
		</div>
	);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/resources/resources-shell.tsx
git commit -m "feat(resources): public shell wrapper"
```

---

## Task 8: Index route (`/resources`)

**Files:**
- Create: `src/routes/resources.index.tsx`
- Modify: `src/routeTree.gen.ts` (regenerated, not hand-edited)

- [ ] **Step 1: Create `src/routes/resources.index.tsx`**

```tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import {
	BookOpen,
	Clock,
	FileText,
	ListChecks,
	Star,
	Users,
} from "lucide-react";
import type { ComponentType } from "react";
import { ResourcesShell } from "#/components/resources/resources-shell";
import {
	type Resource,
	type ResourceIcon,
	resources,
	resourceToneGradient,
} from "#/data/resources";

const TITLE = "Toastmasters resources — GavelUp";
const DESCRIPTION =
	"What to expect at a Toastmasters meeting, what each role does, and printable role sheets.";

export const Route = createFileRoute("/resources/")({
	head: () => ({
		meta: [
			{ title: TITLE },
			{ name: "description", content: DESCRIPTION },
			{ property: "og:title", content: TITLE },
			{ property: "og:description", content: DESCRIPTION },
			{ property: "og:type", content: "website" },
		],
	}),
	component: ResourcesIndex,
});

const ICONS: Record<ResourceIcon, ComponentType<{ className?: string }>> = {
	book: BookOpen,
	clock: Clock,
	list: ListChecks,
	users: Users,
	doc: FileText,
	star: Star,
};

function ResourcesIndex() {
	return (
		<ResourcesShell>
			<div className="mb-6 pt-2">
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					Toastmasters resources
				</h1>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
					What to expect at a meeting, what each role does, and printable sheets
					you can bring along.
				</p>
			</div>
			<div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3.5">
				{resources.map((r) => (
					<ResourceCard key={r.slug} resource={r} />
				))}
			</div>
		</ResourcesShell>
	);
}

function ResourceCard({ resource }: { resource: Resource }) {
	const Icon = ICONS[resource.icon];
	return (
		<Link
			to="/resources/$slug"
			params={{ slug: resource.slug }}
			className="group flex flex-col gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-5 text-[var(--sea-ink)] no-underline shadow-[0_1px_0_var(--inset-glint)_inset,0_8px_20px_rgba(23,58,64,.05)] transition-all hover:-translate-y-0.5 hover:border-[var(--lagoon-deep)]"
		>
			<span
				className="flex size-10 items-center justify-center rounded-lg text-white"
				style={{ background: resourceToneGradient(resource.tone) }}
			>
				<Icon className="size-5" />
			</span>
			<div>
				<div className="text-sm leading-tight font-bold">{resource.title}</div>
				<p className="mt-1 text-xs leading-snug text-[var(--sea-ink-soft)]">
					{resource.desc}
				</p>
			</div>
		</Link>
	);
}
```

- [ ] **Step 2: Regenerate the route tree**

Run:
```bash
bun run generate-routes
```
Expected: no errors; `src/routeTree.gen.ts` now references `resources.index.tsx`.

- [ ] **Step 3: Commit**

```bash
git add src/routes/resources.index.tsx src/routeTree.gen.ts
git commit -m "feat(resources): public /resources index"
```

---

## Task 9: Article route + retire the mock + entry points

Add the `/resources/$slug` article route, delete the placeholder, and wire entry points. Doing these together keeps the route tree and typecheck consistent in one commit.

**Files:**
- Create: `src/routes/resources.$slug.tsx`
- Delete: `src/routes/_authed/resources.tsx`
- Modify: `src/routes/index.tsx`
- Modify: `src/routes/club.$clubId.index.tsx`
- Modify: `src/routeTree.gen.ts` (regenerated)

- [ ] **Step 1: Create `src/routes/resources.$slug.tsx`**

```tsx
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ArrowLeft, Download } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ResourcesShell } from "#/components/resources/resources-shell";
import { Button } from "#/components/ui/button";
import { getResourceMarkdown } from "#/data/resource-content";
import { resourceBySlug } from "#/data/resources";

export const Route = createFileRoute("/resources/$slug")({
	loader: ({ params }) => {
		const resource = resourceBySlug(params.slug);
		const markdown = getResourceMarkdown(params.slug);
		if (!resource || !markdown) throw notFound();
		return { resource, markdown };
	},
	head: ({ params }) => {
		const resource = resourceBySlug(params.slug);
		const title = resource
			? `${resource.title} — GavelUp`
			: "Resource — GavelUp";
		return {
			meta: [
				{ title },
				{ name: "description", content: resource?.desc ?? "" },
			],
		};
	},
	component: ResourceArticle,
});

function ResourceArticle() {
	const { resource, markdown } = Route.useLoaderData();
	return (
		<ResourcesShell>
			<Link
				to="/resources"
				className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-[var(--lagoon-deep)] no-underline hover:underline"
			>
				<ArrowLeft className="size-4" />
				All resources
			</Link>
			<article className="prose-gavelup mt-4">
				<ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
			</article>
			{resource.downloads?.length ? (
				<section className="mt-8 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-5">
					<h2 className="font-display text-lg font-semibold">
						Printable role sheets
					</h2>
					<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
						Blank forms to print and fill in by hand.
					</p>
					<div className="mt-3 flex flex-wrap gap-2">
						{resource.downloads.map((d) => (
							<Button key={d.href} asChild variant="outline" size="sm">
								<a href={d.href} download>
									<Download className="size-4" />
									{d.label}
								</a>
							</Button>
						))}
					</div>
				</section>
			) : null}
		</ResourcesShell>
	);
}
```

- [ ] **Step 2: Delete the placeholder route**

Run:
```bash
git rm src/routes/_authed/resources.tsx
```

- [ ] **Step 3: Add Resources links to the landing header + footer**

In `src/routes/index.tsx`, replace the header's Sign-in button:
```tsx
				<Button asChild variant="ghost" className="font-semibold">
					<Link to="/signin" search={{ redirect: "/officers" }}>
						Sign in
					</Link>
				</Button>
```
with a two-link nav:
```tsx
				<nav className="flex items-center gap-1">
					<Button asChild variant="ghost" className="font-semibold">
						<Link to="/resources">Resources</Link>
					</Button>
					<Button asChild variant="ghost" className="font-semibold">
						<Link to="/signin" search={{ redirect: "/officers" }}>
							Sign in
						</Link>
					</Button>
				</nav>
```

Then in the footer, replace:
```tsx
						<Link
							to="/signin"
							search={{ redirect: "/officers" }}
							className="font-semibold text-[var(--sea-ink)] no-underline hover:underline"
						>
							Sign in
						</Link>
```
with:
```tsx
						<div className="flex items-center gap-4">
							<Link
								to="/resources"
								className="font-semibold text-[var(--sea-ink)] no-underline hover:underline"
							>
								Resources
							</Link>
							<Link
								to="/signin"
								search={{ redirect: "/officers" }}
								className="font-semibold text-[var(--sea-ink)] no-underline hover:underline"
							>
								Sign in
							</Link>
						</div>
```

- [ ] **Step 4: Add a "what to expect" link to the club home**

In `src/routes/club.$clubId.index.tsx`, find the Header block:
```tsx
			{/* Header */}
			<div className="flex items-center justify-between pt-2">
				<h1 className="font-display text-2xl font-semibold tracking-tight">
					Hi {member?.name ?? "there"} 👋
				</h1>
```
Immediately **after** the closing `</div>` of that Header block (before the `{/* "This is me" … */}` comment), add:
```tsx
			<Link
				to="/resources/$slug"
				params={{ slug: "what-to-expect" }}
				className="inline-flex text-sm font-semibold text-[var(--lagoon-deep)] no-underline hover:underline"
			>
				New to Toastmasters? See what to expect at a meeting →
			</Link>
```
(`Link` is already imported in this file.)

- [ ] **Step 5: Regenerate the route tree**

Run:
```bash
bun run generate-routes
```
Expected: no errors; the tree now has `resources.$slug` and no longer has `_authed/resources`.

- [ ] **Step 6: Typecheck — now fully clean**

Run:
```bash
bun run typecheck
```
Expected: **PASS** (the `_authed/resources.tsx` errors are gone now that it's deleted).

- [ ] **Step 7: Lint/format**

Run:
```bash
bun run check
```
Expected: PASS (or auto-fixable formatting; re-run `bunx biome check --write` if it reports fixes, then re-stage).

- [ ] **Step 8: Commit**

```bash
git add src/routes/resources.$slug.tsx src/routes/index.tsx src/routes/club.$clubId.index.tsx src/routeTree.gen.ts
git commit -m "feat(resources): article route, retire mock, wire entry points"
```

---

## Task 10: Integrity guard test

Regression guard: every registry slug has a markdown file, and every download points at an existing PDF under `/role-sheets/`.

**Files:**
- Create: `src/data/resources.guard.test.ts`

- [ ] **Step 1: Write the guard test**

```ts
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resources } from "#/data/resources";

// Vitest runs from the repo root, so process.cwd() is the project root.
const ROOT = process.cwd();

describe("resources registry integrity (#310)", () => {
	for (const r of resources) {
		it(`${r.slug} has a markdown article`, () => {
			const md = resolve(ROOT, "content", "resources", `${r.slug}.md`);
			expect(existsSync(md), `missing ${md}`).toBe(true);
		});

		for (const d of r.downloads ?? []) {
			it(`${r.slug} download "${d.label}" points at an existing sheet`, () => {
				// Downloads must live under /role-sheets/ to avoid the /resources/$slug
				// route namespace (spec §Download path).
				expect(d.href.startsWith("/role-sheets/")).toBe(true);
				const pdf = resolve(ROOT, "public", d.href.replace(/^\//, ""));
				expect(existsSync(pdf), `missing ${pdf}`).toBe(true);
			});
		}
	}
});
```

- [ ] **Step 2: Run it**

Run:
```bash
bunx vitest run src/data/resources.guard.test.ts
```
Expected: **PASS** — 6 markdown checks + 5 download checks green.

- [ ] **Step 3: Prove it bites (optional sanity check)**

Temporarily rename one PDF and re-run to confirm the test fails, then rename it back:
```bash
mv public/role-sheets/timer.pdf public/role-sheets/timer.pdf.bak
bunx vitest run src/data/resources.guard.test.ts   # expect: 1 failing
mv public/role-sheets/timer.pdf.bak public/role-sheets/timer.pdf
```

- [ ] **Step 4: Commit**

```bash
git add src/data/resources.guard.test.ts
git commit -m "test(resources): registry ↔ markdown ↔ pdf guard"
```

---

## Task 11: Full verification + manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Typecheck, lint, and the full test suite**

Run:
```bash
bun run typecheck && bun run check && bun run test
```
Expected: all PASS. (`bun run test` needs the dev Postgres up for the DB-backed suites — it's the running `dev-postgres` container.)

- [ ] **Step 2: Manual smoke in the dev server**

Run `bun run dev`, then in a browser (or via the `/browse` skill) check:
- `/resources` — six cards render inside the public shell; footer shows the disclaimer.
- Click a card → `/resources/<slug>` renders the article with brand prose styling; "All resources" link returns to the index.
- `/resources/meeting-roles` — five **Download** buttons appear; each downloads its PDF (confirm `/role-sheets/timer.pdf` downloads, does NOT 404).
- `/resources/not-a-real-slug` → 404 (notFound).
- Landing `/` — header and footer show a **Resources** link.
- A club page `/club/<slug>` — the "what to expect" link appears and navigates to the article.

- [ ] **Step 3: Note the manual-regen caveat (no commit needed)**

Remember: editing `scripts/build-role-sheets.ts` later requires re-running `bun run build:role-sheets` and committing the regenerated PDFs. No CI check enforces this (accepted v1 trade-off, per spec).

---

## Self-Review Notes (author)

- **Spec coverage:** routes (T8/T9), typed registry (T2), markdown loader+files (T3/T4), react-markdown+prose (T1/T6), role-sheet PDFs at `/role-sheets/` (T5), entry points + retire mock (T9), disclaimer via shell + PDF footer (T5/T7), guard test (T10). All spec sections map to a task.
- **Namespace decision honored:** downloads served from `/role-sheets/`, asserted by the guard test (T10) — never `/resources/*`.
- **Signed-in UX limitation:** documented in the shell component and spec; tracked in #317 (not implemented here).
- **Type consistency:** `Resource`/`RoleSheet`/`resourceBySlug`/`getResourceMarkdown` names match across T2, T4, T8, T9, T10.
- **Deferred (tickets):** dynamic PDFs #311, more articles #312, filtering #313, member-gating #314, per-club #318, CTA #319.
