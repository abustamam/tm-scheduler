# Meeting present mode — projected slide deck

**Date:** 2026-07-08
**Status:** Approved (brainstorm) — ready for implementation plan
**Branch:** `feat/meeting-present-mode`

## Summary

Toastmasters clubs currently hand-author a PowerPoint/Google Slides deck for
every meeting that "more or less mimics the agenda" (title, toastmaster, theme,
word of the day, speeches, table topics, evaluations, votes, awards, thank you).
Almost all of that content already lives in the app's meeting/role/speech data.

This feature adds an **in-app present mode**: a full-screen, keyboard-navigable
slide deck rendered from the live meeting data at
`/club/$clubId/meeting/$meetingId/present`. It is projected during the meeting,
stays in sync with agenda edits (on reload), and requires no file export.

The **speaker's own content slides** (e.g. a speaker's "Chai" or PR deck) are
authored per-speaker and are explicitly **out of scope**.

## Motivation

- Clubs re-type the same agenda-shaped deck by hand every meeting.
- The app already holds the data (`meetings`, `roleSlots`, `speeches`,
  `clubs`) and already renders a run-of-show for the printable agenda
  (`src/lib/agenda-runsheet.ts`).
- A projected deck is the one meeting artifact the app doesn't yet produce.

## Output format decision

**In-app slideshow (present mode)**, not a `.pptx` download and not a Google
Slides export. Rationale: it's app-native, always in sync with live agenda
edits, reuses React/Tailwind and the existing data-loading path, and needs no
external API/OAuth. Trade-off accepted: it cannot embed a speaker's personal
slides and there's no downloadable file (both fine for v1 — see Out of scope).

## Architecture

Mirrors the existing printable-agenda split (pure logic module + thin
renderer), keeping `pg` out of the client bundle.

### 1. Slide generator (pure, testable)

New module `src/lib/agenda-slides.ts`:

```ts
export function buildSlideDeck(
	meeting: MeetingForDeck,
	club: ClubForDeck,
	slots: AgendaSlot[],
): Slide[]
```

- `Slide` is a discriminated union keyed by `kind`:
  `title | toastmaster | theme | wordOfDay | geIntro | speech | voteSpeaker |
  tableTopics | voteTableTopics | evalIntro | evaluation | voteEvaluator |
  generalEvaluation | awards | reminders | thankYou`.
- Reuses the `AgendaSlot` shape and helpers from `agenda-runsheet.ts`
  (`OPEN_LABEL`, and the `evaluatesSlotId` → speaker pairing). The evaluator
  ordering helper `orderEvaluators` (and the `numbered` label helper) are
  currently module-private in `agenda-runsheet.ts`; the implementation
  **exports** them there so the generator can share one ordering, rather than
  duplicating the logic.
- It is a **sibling generator, not a change to `expandRunSheet`**: slides need a
  different granularity than run-sheet rows (title/vote/awards slides don't map
  to agenda rows; several agenda rows collapse into one slide).
- Pure function, no DB access — imported freely by client route code.

### 2. Route + presentation shell

New route `src/routes/club.$clubId_.meeting.$meetingId.present.tsx` (the `$clubId_`
escape matches the sibling `.print` route so it renders outside the app shell):

- Loader reuses `getMeeting({ data: meetingId })` and `resolveClubOrRedirect`,
  verifies `meeting.clubId === club.id` (mirrors the print route), then builds
  the deck with `buildSlideDeck`.
- Renders one slide at a time in a full-screen component. Each `Slide` kind maps
  to a small presentational sub-component.
- Controls:
  - `←` / `PageUp` / click-left-zone → previous
  - `→` / `Space` / `PageDown` / click-right-zone → next
  - `F` → toggle fullscreen (Fullscreen API)
  - `Esc` → exit back to the meeting page
  - dot / index indicator for position
- Reads live data; agenda edits reflect on reload.

## Data changes

Three **nullable** text columns added to the `meetings` table
(`src/db/schema.ts`), via `bun run db:generate` + `db:migrate`:

| Column          | Purpose                                    |
| --------------- | ------------------------------------------ |
| `wodDefinition` | Word-of-the-Day dictionary definition      |
| `wodExample`    | Word-of-the-Day example sentence           |
| `reminders`     | Free-text club announcements for this mtg  |

Surfaced in the existing `EditMeetingMetaDialog`
(`src/routes/club.$clubId.meeting.$meetingId.tsx`, ~line 662):

- two inputs under the existing "Word of the day" field (definition, example),
- a `Textarea` for reminders,
- wired through the `updateMeeting` server fn alongside the current
  `theme` / `wordOfTheDay` / `notes` fields.

No new tables. `theme` and `wordOfTheDay` already exist and are reused.

## Skip / flex logic

`buildSlideDeck` produces a deck whose length flexes with the meeting:

- **Word of the Day** always renders the word; the definition and example lines
  render only when their fields are non-blank.
- **Reminders** slide is emitted **only if** `reminders` is non-blank.
- **Speech / evaluation / vote slides** scale to the actual number of speaker and
  evaluator slots — a 2-speaker meeting yields 2 speech slides and a 2-name
  "Vote for Best Speaker" slide.
- **Open/unassigned slots** render `— open —` (`OPEN_LABEL`) so an incomplete
  agenda still projects cleanly rather than crashing or showing blanks.

## Slide sequence (fully-populated meeting)

1. Title — club name, district, club number, meeting date, start time
2. Toastmaster — TMOD name
3. Theme — meeting theme
4. Word of the Day — word (+ definition/example if present)
5. General Evaluator intro — GE name + team
6..N. Speech — one per speaker slot (number, speaker, title, project level, time range)
- Vote for Best Speaker — speaker names
- Table Topics — TT Master + timing text
- Vote for Best Table Topics
- Evaluation intro — GE + time
- Evaluation — one per evaluator slot (evaluator → speaker, time)
- Vote for Best Evaluator — evaluator names
- General Evaluation — GE closing
- Awards — Best TT / Best Evaluator / Best Speaker
- Reminders — only if non-blank
- Thank You — next meeting date/time

## Testing

- Unit tests for `buildSlideDeck` in `src/lib/agenda-slides.test.ts`
  (patterned on `agenda-runsheet.test.ts`):
  - fully-populated meeting → expected ordered list of slide `kind`s;
  - blank `reminders` → no reminders slide;
  - blank `wodDefinition`/`wodExample` → word slide omits those lines;
  - N speaker slots → N speech slides + N-name vote slide;
  - open/unassigned slot → `— open —` surfaces.
- `server-modules.guard.test.ts` already enforces the client-bundle boundary;
  `agenda-slides.ts` is pure and client-safe by construction.
- Thin smoke render of the present component to catch obvious render errors.

## Visual treatment

- Projection-optimized: large type, high contrast, one idea per slide.
- v1 palette explored in the mockup (maroon/gold, nodding to Toastmasters
  heritage) is **not load-bearing** — the exact palette will be iterated during
  build. Must be legible projected in both bright and dim rooms.

## Out of scope (v1)

- **Live speech timer** on timed slides (green/yellow/red countdown). Genuinely
  valuable — filed as its own GitHub issue. `buildTimeline`'s marks already
  exist to drive it later.
- Speaker's personal content slides (authored per speaker).
- `.pptx` download / Google Slides export.
- Static "Evaluation Tips" coaching slide.
- Per-club slide theming, reordering, or a configurable template.
- A stored meeting-number for the title slide (not modeled today; the title
  shows club + date + start time instead of "Meeting #54").
