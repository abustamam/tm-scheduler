# Word of the Day Poster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single letter-portrait printable page showing a meeting's Word of the Day in display type, with its definition and example usage beneath, reachable from a new button on the meeting page.

**Architecture:** A pure sizing function and a presentational React component (no data access, so both are unit-testable), rendered by a new public standalone route that reuses the existing print route's loader pattern. The button that opens it is hidden when the meeting has no word. No schema change, no server change, no service-worker change.

**Tech Stack:** TanStack Start (file-based routing), React 19, Vitest + React Testing Library (jsdom), Biome (tabs, double quotes), TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-07-31-word-of-the-day-poster-design.md`

---

## Orientation for the engineer

Read this before Task 1. It is the context you would otherwise have to reverse-engineer.

**Where the data comes from.** A meeting row carries three nullable text columns: `wordOfTheDay`, `wodDefinition`, `wodExample` (`src/db/schema.ts:611-613`). The public loader `getPublicMeetingByKey` (`src/server/meetings.ts:429`) delegates to `loadMeetingDetail`, which reads the meeting with `db.query.meetings.findFirst` — that returns the whole row, so **all three fields are already on the payload**. You are not adding a server function, a query, or a column.

**The print aesthetic is shared.** `src/components/agenda/print-theme.tsx` exports the brand tokens (`INK`, `MUTED`, `FOREST`, `SERIF`, `SANS`, `PAGE_W`, `PAGE_H`), the `FitPage` one-page wrapper, the `Kick` uppercase eyebrow, and `DarkFooter` (which renders a left/right line plus the Toastmasters non-affiliation disclaimer). Use these. Do not introduce new colors or fonts.

**`FitPage` matters.** It renders children at the natural 816px width, measures once after webfonts settle, and scales down if content exceeds 1056px. It also supplies the `.agenda-page` class that the print CSS keys on. Wrap the poster in it.

**Route file naming.** `club.$clubId_.meeting.$meetingId.word.tsx` — the trailing underscore on `$clubId_` escapes the parent layout so the page renders standalone rather than inside the club shell. This mirrors the existing `club.$clubId_.meeting.$meetingId.print.tsx`. After creating the file run `bun run generate-routes`; **never hand-edit `src/routeTree.gen.ts`.**

**Commands.**
- Single test file: `bunx vitest run <path>`
- Type check: `bun run typecheck` — this is the ONLY thing that type-checks. `bun run build` and `bun run test` transpile without checking types.
- Lint gate: `bunx biome check --diagnostic-level=error src/` — `src/db/seed.ts` carries ~118 pre-existing warnings that bury real errors at the default level.
- Formatting is tabs and double quotes, enforced by Biome.

**Import alias.** Prefer `#/*` → `src/*`. Sibling files in the same directory use relative imports (`./print-theme`), matching `club-role-sheet.tsx`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/word-poster.ts` (create) | `posterWordSize(word)` — pure length→px mapping. Lives in `lib/` because it is logic, not markup, and needs no React. |
| `src/lib/word-poster.test.ts` (create) | Bucket-boundary tests for `posterWordSize`. |
| `src/components/agenda/word-of-the-day-poster.tsx` (create) | The presentational poster. Props in, markup out — no data access, no routing. |
| `src/components/agenda/word-of-the-day-poster.test.tsx` (create) | RTL tests for rendering and the independently-optional definition/example. |
| `src/lib/pdf-filename.ts` (modify) | `meetingPdfBasename` gains a segment parameter so the poster gets its own filename. |
| `src/lib/pdf-filename.test.ts` (modify or create) | Covers the new parameter and the preserved default. |
| `src/routes/club.$clubId_.meeting.$meetingId.word.tsx` (create) | Loader, `<title>`, print CSS, toolbar, and the no-word empty state. |
| `src/components/club/meeting-view-actions.tsx` (modify) | New optional `wordOfTheDay` prop gating a "Word poster" button. |
| `src/components/club/meeting-view-actions.test.tsx` (create) | Button visibility across null / empty / whitespace / real word. |
| `src/routes/club.$clubId.meeting.$meetingId.tsx` (modify, ~line 615) | Passes `meeting.wordOfTheDay` to `MeetingViewActions`. |

Tasks 1, 2, and 3 are independent of each other. Task 4 depends on 1 and 2. Task 5 depends on 3. Task 6 depends on 5.

---

## Task 1: The word-sizing function

A three-letter word and a sixteen-letter word cannot share a font size. This maps length to a display size deterministically — no measurement, no layout thrash, and testable without a DOM.

**Files:**
- Create: `src/lib/word-poster.ts`
- Test: `src/lib/word-poster.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/word-poster.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { posterWordSize } from "./word-poster";

describe("posterWordSize", () => {
	it("gives short words the largest size", () => {
		expect(posterWordSize("apt")).toBe(200);
		expect(posterWordSize("candid")).toBe(200);
	});

	it("steps down at each bucket boundary", () => {
		// Lengths are spelled out because the boundary is the whole point.
		expect(posterWordSize("candid")).toBe(200); // 6
		expect(posterWordSize("aplomb!")).toBe(150); // 7
		expect(posterWordSize("ephemeral!")).toBe(150); // 10
		expect(posterWordSize("ephemerally")).toBe(112); // 11
		expect(posterWordSize("magnanimously!")).toBe(112); // 14
		expect(posterWordSize("circumlocution!")).toBe(88); // 15
		expect(posterWordSize("a".repeat(18))).toBe(88); // 18
		expect(posterWordSize("a".repeat(19))).toBe(68); // 19
	});

	it("floors at the smallest size for pathological input", () => {
		expect(posterWordSize("a".repeat(60))).toBe(68);
	});

	it("measures the trimmed word, so padding does not shrink it", () => {
		expect(posterWordSize("   apt   ")).toBe(200);
	});

	it("falls back to the largest size for an empty word", () => {
		expect(posterWordSize("")).toBe(200);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/lib/word-poster.test.ts`

Expected: FAIL — `Failed to resolve import "./word-poster"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/word-poster.ts`:

```ts
// src/lib/word-poster.ts
//
// Display sizing for the Word of the Day poster
// (`components/agenda/word-of-the-day-poster.tsx`). "Apt" and
// "obstreperousness" cannot share a font size, and the poster's whole job is to
// be readable from the back of the room, so the word is sized from its length.
//
// Deterministic buckets rather than a measure-and-scale pass: this runs during
// SSR, needs no DOM, and is unit-testable. The poster also sets `overflowWrap`
// as a backstop for anything longer than the last bucket anticipates.

/** Longest word length that still earns each size, largest bucket first. */
const BUCKETS: readonly (readonly [maxLength: number, size: number])[] = [
	[6, 200],
	[10, 150],
	[14, 112],
	[18, 88],
];

/** Size for anything longer than the last bucket. */
const SMALLEST = 68;

/** Display font size in px for `word`, from its trimmed length. */
export function posterWordSize(word: string): number {
	const length = word.trim().length;
	for (const [maxLength, size] of BUCKETS) {
		if (length <= maxLength) return size;
	}
	return SMALLEST;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/lib/word-poster.test.ts`

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/word-poster.ts src/lib/word-poster.test.ts
git commit -m "feat(word-poster): size the display word from its length"
```

---

## Task 2: The poster component

**Files:**
- Create: `src/components/agenda/word-of-the-day-poster.tsx`
- Test: `src/components/agenda/word-of-the-day-poster.test.tsx`

Note the `// @vitest-environment jsdom` pragma on the first line of the test file — component tests in this repo need it (see `club-role-sheet.test.tsx`).

- [ ] **Step 1: Write the failing test**

Create `src/components/agenda/word-of-the-day-poster.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WordOfTheDayPoster } from "./word-of-the-day-poster";

afterEach(cleanup);

const base = {
	word: "Ephemeral",
	definition: "Lasting for a very short time; fleeting.",
	example: "The applause was ephemeral, but the lesson stayed.",
	clubName: "Downtown Toastmasters",
	dateLong: "Friday, July 31, 2026",
};

describe("WordOfTheDayPoster", () => {
	it("renders the word, definition, and example", () => {
		render(<WordOfTheDayPoster {...base} />);
		expect(screen.getByText("Ephemeral")).toBeTruthy();
		expect(
			screen.getByText("Lasting for a very short time; fleeting."),
		).toBeTruthy();
		expect(
			screen.getByText(/The applause was ephemeral, but the lesson stayed\./),
		).toBeTruthy();
	});

	it("renders the club name and date in the footer", () => {
		render(<WordOfTheDayPoster {...base} />);
		expect(screen.getByText("Downtown Toastmasters")).toBeTruthy();
		expect(screen.getByText("Friday, July 31, 2026")).toBeTruthy();
	});

	it("sizes the word from its length", () => {
		const { unmount } = render(<WordOfTheDayPoster {...base} word="Apt" />);
		expect(screen.getByText("Apt").style.fontSize).toBe("200px");
		unmount();
		render(<WordOfTheDayPoster {...base} word="Circumlocution!" />);
		expect(screen.getByText("Circumlocution!").style.fontSize).toBe("88px");
	});

	it("omits the definition block when there is no definition", () => {
		render(<WordOfTheDayPoster {...base} definition={null} />);
		expect(screen.getByText("Ephemeral")).toBeTruthy();
		expect(screen.queryByTestId("wod-definition")).toBeNull();
		// The example still renders on its own.
		expect(screen.getByTestId("wod-example")).toBeTruthy();
	});

	it("omits the example block when there is no example", () => {
		render(<WordOfTheDayPoster {...base} example={null} />);
		expect(screen.getByTestId("wod-definition")).toBeTruthy();
		expect(screen.queryByTestId("wod-example")).toBeNull();
	});

	it("renders the word alone when neither definition nor example is set", () => {
		render(<WordOfTheDayPoster {...base} definition={null} example={null} />);
		expect(screen.getByText("Ephemeral")).toBeTruthy();
		expect(screen.queryByTestId("wod-definition")).toBeNull();
		expect(screen.queryByTestId("wod-example")).toBeNull();
	});

	it("treats a whitespace-only definition as absent", () => {
		render(<WordOfTheDayPoster {...base} definition="   " />);
		expect(screen.queryByTestId("wod-definition")).toBeNull();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/components/agenda/word-of-the-day-poster.test.tsx`

Expected: FAIL — `Failed to resolve import "./word-of-the-day-poster"`.

- [ ] **Step 3: Write the implementation**

Create `src/components/agenda/word-of-the-day-poster.tsx`:

```tsx
// src/components/agenda/word-of-the-day-poster.tsx
//
// A one-page printable carrying a meeting's Word of the Day in display type,
// with its definition and example usage beneath. Printed on letter portrait and
// taped to the wall so the room can read it from any seat for the whole
// meeting.
//
// Presentational only — no data access, no routing — so it unit-tests the way
// `club-role-sheet.tsx` does. Shares the print aesthetic (brand tokens,
// one-page FitPage, Kick, DarkFooter) via `./print-theme` (#345).
//
// Deliberately does NOT credit the Grammarian, unlike the Present-mode Word of
// the Day slide: this hangs for the whole meeting, where attribution reads as
// clutter and goes stale if the role is reassigned after printing.
import { posterWordSize } from "#/lib/word-poster";
import { DarkFooter, FitPage, Kick, MUTED, SANS, SERIF } from "./print-theme";

export function WordOfTheDayPoster({
	word,
	definition,
	example,
	clubName,
	dateLong,
}: {
	word: string;
	definition: string | null;
	example: string | null;
	clubName: string;
	dateLong: string;
}) {
	// Whitespace-only is absent: an all-spaces definition must not print an empty
	// block, and the route's "is there a word" check trims the same way.
	const def = definition?.trim() || null;
	const ex = example?.trim() || null;

	return (
		<FitPage>
			<div
				style={{
					flex: 1,
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					justifyContent: "center",
					padding: "64px 56px",
					textAlign: "center",
				}}
			>
				<Kick style={{ fontSize: 15, letterSpacing: ".22em" }}>
					Word of the Day
				</Kick>

				<div
					style={{
						fontFamily: SERIF,
						fontSize: posterWordSize(word),
						fontWeight: 600,
						lineHeight: 1.05,
						margin: "40px 0",
						// Backstop for a word longer than the smallest bucket expects.
						overflowWrap: "anywhere",
						maxWidth: "100%",
					}}
				>
					{word}
				</div>

				{def ? (
					<p
						data-testid="wod-definition"
						style={{
							fontFamily: SANS,
							fontSize: 30,
							lineHeight: 1.4,
							fontWeight: 500,
							margin: 0,
							// ~55 characters, so lines don't run the full page width.
							maxWidth: "26em",
						}}
					>
						{def}
					</p>
				) : null}

				{ex ? (
					<p
						data-testid="wod-example"
						style={{
							fontFamily: SANS,
							fontSize: 23,
							lineHeight: 1.5,
							fontStyle: "italic",
							color: MUTED,
							margin: def ? "34px 0 0" : 0,
							maxWidth: "26em",
						}}
					>
						{`“${ex}”`}
					</p>
				) : null}
			</div>

			<DarkFooter left={clubName} right={dateLong} />
		</FitPage>
	);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/components/agenda/word-of-the-day-poster.test.tsx`

Expected: PASS, 7 tests.

If the "sizes the word from its length" test fails on `.style.fontSize`, React has rendered the numeric `fontSize` as `"200px"` — that is what the assertion expects. A failure here means the size is not being applied to the element holding the text; keep `posterWordSize(word)` on the same element the word is a child of.

- [ ] **Step 5: Commit**

```bash
git add src/components/agenda/word-of-the-day-poster.tsx src/components/agenda/word-of-the-day-poster.test.tsx
git commit -m "feat(word-poster): add the one-page Word of the Day printable"
```

---

## Task 3: A filename segment for the poster PDF

Browsers derive the "Save as PDF" filename from `document.title`. `meetingPdfBasename` hardcodes `-meeting-`; parameterize that segment so the poster gets `Downtown-Toastmasters-word-of-the-day-2026-07-31` without duplicating the club-slug and ISO-date helpers.

**Files:**
- Modify: `src/lib/pdf-filename.ts`
- Test: `src/lib/pdf-filename.test.ts`

First check whether the test file already exists: `ls src/lib/pdf-filename.test.ts`. If it does, ADD the two new tests below to its existing `describe` block rather than overwriting the file.

- [ ] **Step 1: Write the failing test**

In `src/lib/pdf-filename.test.ts` (creating it with this scaffold if absent):

```ts
import { describe, expect, it } from "vitest";
import { meetingPdfBasename } from "./pdf-filename";

describe("meetingPdfBasename", () => {
	it("defaults to the meeting segment", () => {
		expect(
			meetingPdfBasename("Downtown Toastmasters", "2026-07-31T18:45:00Z", "UTC"),
		).toBe("Downtown-Toastmasters-meeting-2026-07-31");
	});

	it("accepts a custom segment for other printables", () => {
		expect(
			meetingPdfBasename(
				"Downtown Toastmasters",
				"2026-07-31T18:45:00Z",
				"UTC",
				"word-of-the-day",
			),
		).toBe("Downtown-Toastmasters-word-of-the-day-2026-07-31");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/lib/pdf-filename.test.ts`

Expected: the default-segment test PASSES; the custom-segment test FAILS, because the 4th argument is ignored and the result still reads `-meeting-`. (If TypeScript complains about the extra argument, that is the same failure.)

- [ ] **Step 3: Write the implementation**

In `src/lib/pdf-filename.ts`, replace the `meetingPdfBasename` function and update its docblock:

```ts
/**
 * Filename-safe basename for a meeting's printable/downloadable PDF, e.g.
 * "Downtown-Toastmasters-meeting-2026-07-22". When a print page is saved as PDF,
 * browsers derive the filename from `document.title`, so the agenda print route
 * uses this as its <title>; a future server-generated agenda PDF permalink can
 * reuse it for the `content-disposition` filename.
 *
 * - Club name is slugified: case preserved, runs of non-alphanumerics collapse
 *   to a single "-", leading/trailing "-" trimmed. Empty/punctuation-only ⇒
 *   "agenda".
 * - Date is the meeting's calendar day in the club's timezone, ISO "YYYY-MM-DD"
 *   (sortable and locale-independent).
 * - `segment` names the artifact between the two. It defaults to "meeting" (the
 *   agenda); the Word of the Day poster passes "word-of-the-day" so its saved
 *   file is not mistaken for an agenda.
 */
export function meetingPdfBasename(
	clubName: string,
	scheduledAt: Date | string,
	timeZone?: string,
	segment = "meeting",
): string {
	return `${slugifyClubName(clubName)}-${segment}-${isoDateInTimeZone(scheduledAt, timeZone)}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/lib/pdf-filename.test.ts`

Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pdf-filename.ts src/lib/pdf-filename.test.ts
git commit -m "refactor(pdf-filename): parameterize the artifact segment"
```

---

## Task 4: The poster route

Depends on Tasks 1–3.

**Files:**
- Create: `src/routes/club.$clubId_.meeting.$meetingId.word.tsx`
- Modify (generated, do not hand-edit): `src/routeTree.gen.ts`

- [ ] **Step 1: Write the route**

Create `src/routes/club.$clubId_.meeting.$meetingId.word.tsx`:

```tsx
// src/routes/club.$clubId_.meeting.$meetingId.word.tsx
//
// The Word of the Day poster: one letter-portrait sheet with the meeting's word
// in display type, for taping to the wall so the room can read it all meeting.
//
// PUBLIC, like the sibling /print and /present routes — it shows only what the
// public agenda already shows. The `$clubId_` escape renders it standalone,
// outside the club shell.
//
// Offline works for free: `isOfflineRoute` in public/sw.js matches
// /^\/club\/[^/]+\/meeting\//, which this path already satisfies.
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { WordOfTheDayPoster } from "#/components/agenda/word-of-the-day-poster";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { meetingPdfBasename } from "#/lib/pdf-filename";
import { getPublicMeetingByKey } from "#/server/meetings";

export const Route = createFileRoute("/club/$clubId_/meeting/$meetingId/word")({
	loader: async ({ params, location }) => {
		const club = await resolveClubOrRedirect(params.clubId, location);
		const data = await getPublicMeetingByKey({
			data: { clubId: club.id, key: params.meetingId },
		});
		if (data.meeting.clubId !== club.id) throw notFound();
		return data;
	},
	component: WordPoster,
	// The <title> becomes the browser's default "Save as PDF" filename.
	// loaderData is absent during the pending state → fallback.
	head: ({ loaderData }) => ({
		meta: [
			{
				title: loaderData
					? meetingPdfBasename(
							loaderData.clubName,
							loaderData.meeting.scheduledAt,
							loaderData.timezone,
							"word-of-the-day",
						)
					: "Word of the Day — GavelUp",
			},
			{ name: "robots", content: "noindex, nofollow" },
		],
	}),
});

function WordPoster() {
	const { clubId: clubIdParam, meetingId } = Route.useParams();
	const { meeting, timezone, clubName } = Route.useLoaderData();

	// Whitespace-only counts as unset, matching the button-visibility check in
	// `MeetingViewActions` so the two can never disagree about whether this
	// meeting has a word.
	const word = meeting.wordOfTheDay?.trim() || null;

	const dateLong = new Intl.DateTimeFormat(undefined, {
		weekday: "long",
		month: "long",
		day: "numeric",
		year: "numeric",
		timeZone: timezone,
	}).format(new Date(meeting.scheduledAt));

	// Reached only by a typed or shared URL — the button is hidden when there is
	// no word. Offer the way back rather than a blank sheet to print.
	if (!word) {
		return (
			<div style={emptyWrapStyle}>
				<p style={{ fontSize: 17, fontWeight: 600, margin: 0 }}>
					No Word of the Day set for this meeting yet.
				</p>
				<Link
					to="/club/$clubId/meeting/$meetingId"
					params={{ clubId: clubIdParam, meetingId }}
					style={{ color: "#328f97", fontWeight: 700, fontSize: 14 }}
				>
					← Back to the meeting
				</Link>
			</div>
		);
	}

	return (
		<div>
			<div className="no-print" style={toolbarStyle}>
				<button
					type="button"
					onClick={() => window.print()}
					style={printBtnStyle}
				>
					Print
				</button>
			</div>
			<style>{`
				@media screen { body { background: #d8e6dd; } }
				.pgwrap { padding: 28px 0; }
				@media print {
					.no-print { display: none !important; }
					body { background: #fff; }
					.agenda-page { box-shadow: none !important; }
					@page { size: letter portrait; margin: 0; }
				}
			`}</style>
			<div className="pgwrap" style={{ display: "flex", justifyContent: "center" }}>
				<WordOfTheDayPoster
					word={word}
					definition={meeting.wodDefinition}
					example={meeting.wodExample}
					clubName={clubName}
					dateLong={dateLong}
				/>
			</div>
		</div>
	);
}

const emptyWrapStyle: React.CSSProperties = {
	minHeight: "60vh",
	display: "flex",
	flexDirection: "column",
	alignItems: "center",
	justifyContent: "center",
	gap: 12,
	color: "#173a40",
	fontFamily: "'Manrope', ui-sans-serif, system-ui, sans-serif",
	textAlign: "center",
	padding: 24,
};

const toolbarStyle: React.CSSProperties = {
	position: "fixed",
	top: 12,
	right: 12,
	zIndex: 10,
	display: "flex",
	gap: 8,
	alignItems: "center",
	background: "#fff",
	borderRadius: 10,
	padding: 6,
	boxShadow: "0 6px 20px rgba(23,58,64,.18)",
};

const printBtnStyle: React.CSSProperties = {
	padding: "6px 14px",
	background: "#328f97",
	color: "#fff",
	border: 0,
	borderRadius: 7,
	fontSize: 13,
	fontWeight: 700,
	cursor: "pointer",
};
```

- [ ] **Step 2: Regenerate the route tree**

Run: `bun run generate-routes`

Expected: exits 0 and `src/routeTree.gen.ts` now contains `/club/$clubId_/meeting/$meetingId/word`. Verify with:

`grep -c 'meeting/\$meetingId/word' src/routeTree.gen.ts`

Expected: a non-zero count. Do not hand-edit this file — if the route is missing, the filename is wrong.

- [ ] **Step 3: Type check**

Run: `bun run typecheck`

Expected: no errors. This is the only step that type-checks the new route; `vitest` and `build` will both pass on type-broken code.

- [ ] **Step 4: Commit**

```bash
git add src/routes/club.\$clubId_.meeting.\$meetingId.word.tsx src/routeTree.gen.ts
git commit -m "feat(word-poster): add the public poster route"
```

---

## Task 5: Gate the button on the meeting having a word

The button appears only when the meeting has a word. That "only when" is a real branch, and per `CLAUDE.md`'s coverage notes it needs a test that can actually fail — so the test comes first.

**Files:**
- Modify: `src/components/club/meeting-view-actions.tsx`
- Test: `src/components/club/meeting-view-actions.test.tsx` (create)

`MeetingViewActions` renders TanStack `<Link>` components, which need a router in the test. Render it inside a memory router using the app's real route tree — that keeps the `to`/`params` props honest.

- [ ] **Step 1: Write the failing test**

Create `src/components/club/meeting-view-actions.test.tsx`:

```tsx
// @vitest-environment jsdom
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MeetingViewActions } from "./meeting-view-actions";

afterEach(cleanup);

/**
 * Render the actions inside a minimal router. The component's <Link>s are typed
 * against the real route tree, but for a rendering test any router whose routes
 * cover the paths they point at is enough.
 */
function renderActions(props: { wordOfTheDay?: string | null }) {
	const rootRoute = createRootRoute({
		component: () => (
			<MeetingViewActions
				clubSlug="downtown"
				meetingId="2026-07-31"
				{...props}
			/>
		),
	});
	const indexRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/",
		component: () => null,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([indexRoute]),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	// biome-ignore lint/suspicious/noExplicitAny: test-local router, not the app's typed tree
	return render(<RouterProvider router={router as any} />);
}

describe("MeetingViewActions", () => {
	it("always offers Print agenda, Present, and Role sheet", async () => {
		renderActions({});
		expect(await screen.findByText("Print agenda")).toBeTruthy();
		expect(screen.getByText("Present")).toBeTruthy();
		expect(screen.getByText("Role sheet")).toBeTruthy();
	});

	it("shows the Word poster button when the meeting has a word", async () => {
		renderActions({ wordOfTheDay: "Ephemeral" });
		expect(await screen.findByText("Word poster")).toBeTruthy();
	});

	it("hides the Word poster button when there is no word", async () => {
		renderActions({ wordOfTheDay: null });
		await screen.findByText("Present");
		expect(screen.queryByText("Word poster")).toBeNull();
	});

	it("hides the Word poster button when the prop is omitted", async () => {
		renderActions({});
		await screen.findByText("Present");
		expect(screen.queryByText("Word poster")).toBeNull();
	});

	it("hides the Word poster button for an empty or whitespace-only word", async () => {
		const { unmount } = renderActions({ wordOfTheDay: "" });
		await screen.findByText("Present");
		expect(screen.queryByText("Word poster")).toBeNull();
		unmount();

		renderActions({ wordOfTheDay: "   " });
		await screen.findByText("Present");
		expect(screen.queryByText("Word poster")).toBeNull();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/components/club/meeting-view-actions.test.tsx`

Expected: FAIL — the "shows the Word poster button" test cannot find that text, and TypeScript rejects the unknown `wordOfTheDay` prop.

- [ ] **Step 3: Write the implementation**

In `src/components/club/meeting-view-actions.tsx`:

1. Extend the import on line 2 to pull in the icon:

```tsx
import { ClipboardList, Presentation, Printer, Type } from "lucide-react";
```

2. Add the prop to the signature and its type:

```tsx
export function MeetingViewActions({
	clubSlug,
	meetingId,
	printLayout = "grid",
	deck,
	clubName,
	wordOfTheDay,
}: {
	clubSlug: string;
	meetingId: string;
	printLayout?: AgendaLayout;
	deck?: Slide[];
	clubName?: string;
	wordOfTheDay?: string | null;
}) {
```

3. Insert this block after the "Role sheet" `<Button>` and before the `deck && clubName` line:

```tsx
			{/* Word of the Day wall poster (#487). Hidden when the meeting has no
			    word — there would be nothing to print. Whitespace-only counts as
			    unset, matching the route's own check. */}
			{wordOfTheDay?.trim() ? (
				<Button asChild variant="outline" size="sm">
					<Link
						to="/club/$clubId/meeting/$meetingId/word"
						params={{ clubId: clubSlug, meetingId }}
						target="_blank"
						rel="noopener noreferrer"
					>
						<Type />
						Word poster
					</Link>
				</Button>
			) : null}
```

4. Extend the component's docblock with a sentence:

```tsx
 * A "Word poster" action appears only when the meeting has a Word of the Day —
 * with no word there is nothing to print, so the button is hidden rather than
 * leading to an empty sheet.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/components/club/meeting-view-actions.test.tsx`

Expected: PASS, 5 tests.

- [ ] **Step 5: Verify the test can actually fail**

Temporarily change the condition to `{wordOfTheDay !== undefined ? (` and re-run. The "hides … when there is no word" and "empty or whitespace-only" tests must FAIL. Then restore `{wordOfTheDay?.trim() ? (` and confirm all 5 pass again.

This step exists because a visibility test written against a wrongly-scoped condition can pass while protecting nothing — see the coverage traps in `CLAUDE.md`.

- [ ] **Step 6: Commit**

```bash
git add src/components/club/meeting-view-actions.tsx src/components/club/meeting-view-actions.test.tsx
git commit -m "feat(word-poster): add the Word poster button, gated on a word"
```

---

## Task 6: Wire the button into the meeting page

Depends on Task 5.

**Files:**
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx` (~line 615)

- [ ] **Step 1: Pass the word through**

Find the `<MeetingViewActions>` call (around line 615) and add the prop:

```tsx
					<MeetingViewActions
						clubSlug={clubId}
						meetingId={urlKey}
						deck={deck}
						clubName={clubName}
						wordOfTheDay={meeting.wordOfTheDay}
					/>
```

- [ ] **Step 2: Type check**

Run: `bun run typecheck`

Expected: no errors. `meeting` is already in scope at that call site — the `<MeetingRoleSheets meetingId={meeting.id} />` line a few rows below uses it.

- [ ] **Step 3: Commit**

```bash
git add src/routes/club.\$clubId.meeting.\$meetingId.tsx
git commit -m "feat(word-poster): surface the poster button on the meeting page"
```

---

## Task 7: Full verification

- [ ] **Step 1: Run the whole suite with a database**

Integration suites SKIP silently without a database, and the pass count still reads green:

```bash
export TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test"
bun run test
```

Expected: all tests pass, including the ~630 integration tests. If the count looks far below that, `TEST_DATABASE_URL` did not take effect — check `docker ps` for the `dev-postgres` container.

- [ ] **Step 2: Type check**

Run: `bun run typecheck`

Expected: no errors.

- [ ] **Step 3: Lint gate**

Run: `bunx biome check --diagnostic-level=error src/`

Expected: no errors. The default level buries real errors under ~118 pre-existing warnings in `src/db/seed.ts`.

If Biome reports formatting diffs, run `bun run format` and re-check. Formatting is tabs and double quotes.

- [ ] **Step 4: Look at the poster in a browser**

```bash
GSTACK_CHROMIUM_NO_SANDBOX=1 bun run dev
```

Open a meeting that has a Word of the Day, confirm the "Word poster" button appears, click it, and check:
- the word is large and centered, definition and example beneath it;
- the browser print preview shows exactly ONE page, letter portrait, no second blank sheet;
- a meeting with no word does not show the button, and visiting `/club/<slug>/meeting/<key>/word` directly shows the prompt with no Print button.

Try a long word (set one to "circumnavigation") and confirm it still fits on one line or wraps without overflowing.

- [ ] **Step 5: Commit anything outstanding**

```bash
git status
```

Expected: clean. Note that `bun run build` appends an SSR Register block to `src/routeTree.gen.ts` that `generate-routes` omits — if you ran a build, `git checkout src/routeTree.gen.ts` before committing so the artifact does not land.

---

## Out of scope

Do not do these, even though they look adjacent:

- **No schema change.** There is no part-of-speech column. The poster prints `wodDefinition` as typed.
- **No Grammarian credit.** Present mode credits the Grammarian on its slide; the poster deliberately does not.
- **No service-worker change.** `/club/:slug/meeting/:key/word` already matches `isOfflineRoute`'s club regex in `public/sw.js`. No version bump.
- **No changes** to the Present slide, the agenda print header, or the role-sheet PDFs.
