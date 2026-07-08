# Meeting present mode — projected slide deck

**Date:** 2026-07-08
**Status:** Approved (brainstorm + grilling) — ready for implementation plan
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

## Access model

Public-by-URL, **no auth gate** — matches the sibling `.print` route, which is
not under `_authed` and treats the session as optional (used only to compute
`canManage`). Anyone with the meeting link can project it. Present mode is
strictly **read-only**; nothing can be edited from it. Meeting data (names,
speech titles) is already exposed by `.print` under the same model.

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
- Driven by a hardcoded ordered **`SLIDE_TEMPLATE`** — the slide analogue of
  `RUN_OF_SHOW` — whose section-emitters pull from the meeting's slots. The
  standard Toastmasters ordering is fixed in this constant.
- Reuses the `AgendaSlot` shape and helpers from `agenda-runsheet.ts`
  (`OPEN_LABEL`, `buildLegend`, and the `evaluatesSlotId` → speaker pairing).
  The evaluator ordering helper `orderEvaluators` (and the `numbered` label
  helper) are currently module-private in `agenda-runsheet.ts`; the
  implementation **exports** them there so the generator shares one ordering
  rather than duplicating it.
- Standard durations that are **not** in the data model are defined as named
  constants in this module (see "Timing" below).
- Pure function, no DB access — imported freely by client route code and
  client-safe by construction (the `server-modules.guard.test.ts` boundary is
  not even in play).

### 2. Route + presentation shell

New route `src/routes/club.$clubId_.meeting.$meetingId.present.tsx` (the
`$clubId_` escape matches the sibling `.print` route so it renders outside the
app shell):

- Loader reuses `getMeeting({ data: meetingId })` and `resolveClubOrRedirect`,
  verifies `meeting.clubId === club.id` (mirrors the print route), then builds
  the deck with `buildSlideDeck`.
- Renders one slide at a time in a full-screen component. Each `Slide` kind maps
  to a small presentational sub-component.
- **Current slide index is local component state** (`useState`) — not in the
  URL. A refresh returns to the title slide (acceptable: you set up before
  presenting). No deep-linking/`?slide=` param in v1.
- Controls:
  - `←` / `PageUp` / click-left-zone → previous
  - `→` / `Space` / `PageDown` / click-right-zone → next
  - `F` → toggle fullscreen (Fullscreen API; user-gesture initiated, not
    auto-fullscreen on load)
  - `Esc` → exit back to the meeting page
  - dot / index indicator for position
- Slide transitions kept minimal and gated by `prefers-reduced-motion`.
- Reads live data; agenda edits reflect on reload.

### 3. Entry point

A **"Present"** button (lucide `Presentation`/`Play` icon) beside the existing
**"Print agenda"** button on the meeting detail page
(`src/routes/club.$clubId.meeting.$meetingId.tsx`, ~line 352), visible to anyone
who can see the meeting page. This is the sole entry point — no nav item, no
dashboard shortcut in v1.

## Data changes

Three **nullable** text columns added to the `meetings` table
(`src/db/schema.ts`), via `bun run db:generate` + `db:migrate`:

| Column          | Purpose                                              |
| --------------- | ---------------------------------------------------- |
| `wodDefinition` | Word-of-the-Day dictionary definition (plain line)   |
| `wodExample`    | Word-of-the-Day example sentence (italic, quoted)    |
| `reminders`     | Free-text club announcements for this meeting        |

`reminders` is a **new, distinct** field — it is **not** the existing `notes`
column. `notes` reads as a private organizer scratch field (written by the edit
dialogs, not displayed anywhere); keeping them separate avoids projecting
private notes onto the wall.

Surfaced in the existing `EditMeetingMetaDialog`
(`src/routes/club.$clubId.meeting.$meetingId.tsx`, ~line 662):

- two inputs under the existing "Word of the day" field (definition, example),
- a `Textarea` for reminders,
- wired through the `updateMeeting` server fn alongside the current
  `theme` / `wordOfTheDay` / `notes` fields.

No new tables. `theme` and `wordOfTheDay` already exist and are reused. The new
columns ride along on the existing `getMeeting` return automatically.

## Slide inclusion rules

Deck length flexes with the meeting:

**Always-on anchor slides** (regardless of slots):

- **Title** — club name, district, club number, meeting date, start time.
- **Toastmaster** — TMOD name, `— open —` if unassigned.
- **Thank You** — next meeting date/time.

**Conditional-on-content slides:**

- **Theme** — only if `theme` is non-blank.
- **Word of the Day** — only if `wordOfTheDay` is non-blank; the definition and
  example lines render only when *their* fields are filled.
- **Reminders** — only if `reminders` is non-blank.

**Section slides** — emitted only if the section has ≥1 corresponding slot on
the meeting (a meeting with zero speaker slots has no speech/vote-speaker
slides). Open-but-unassigned slots still render as `— open —`:

- **Speech** — one per speaker slot.
- **Vote for Best Speaker** — lists assigned speaker names (open slots omitted
  from the list); shown if the speaker section exists.
- **Table Topics** — if a Table Topics role slot exists.
- **Vote for Best Table Topics** — prompt-only (no participant names — not
  tracked); shown if the Table Topics section exists.
- **GE intro** — if a General Evaluator slot exists.
- **Evaluation** — one per evaluator slot.
- **Vote for Best Evaluator** — lists evaluator names; shown if the evaluator
  section exists.
- **General Evaluation** — if a General Evaluator slot exists.
- **Awards** — shows only the category labels whose section exists (omit "Best
  Table Topic" with no TT section, "Best Speaker" with no speakers, etc.); the
  whole Awards slide is dropped if all three are absent.

## Slide content details

- **Title** — club + district + club number + meeting date + start time. No
  meeting number ("Meeting #54") — not modeled today.
- **Toastmaster** — name only (`— open —` if unassigned).
- **Theme** — the theme text.
- **Word of the Day** — the word (always, when the slide shows) + definition line
  + italic quoted example line (each conditional on its field).
- **GE intro** — GE name + the meeting's **actual functionary roles/assignees**
  derived via `buildLegend()` (e.g. "Grammarian · Jane, Timer · Bob,
  Ah-Counter · — open —"), not a static generic team list.
- **Speech** — speaker number, speaker name, speech title, project level, and the
  **real** time range from the joined `speeches` row (e.g. "5–7 minutes").
- **Table Topics** — Topicsmaster name + a fixed generic label ("Impromptu
  speaking") + hardcoded standard speaker timing (see Timing).
- **Evaluation** — evaluator → speaker (via `evaluatesSlotId`) + hardcoded
  standard evaluation timing (see Timing).
- **Awards** — category labels only, no names (winners announced live).
- **Reminders** — the free-text `reminders` content.
- **Thank You** — next meeting date/time.

### Timing

- **Prepared speeches** use the **real** `minMinutes`/`maxMinutes` from the
  joined `speeches` row.
- **Table Topics** and **Evaluations** have no per-slot timing in the data model,
  so they use **hardcoded standard-Toastmasters constants** defined in
  `agenda-slides.ts` (Table Topics ≈ "1–2 minutes per speaker"; evaluations ≈
  "2–3 minutes"). Named constants so they're trivial to tweak later. The app
  does **not** fabricate club-specific numbers beyond these standard defaults.

## Slide sequence (fully-populated meeting)

1. Title
2. Toastmaster
3. Theme *(if set)*
4. Word of the Day *(if set)*
5. General Evaluator intro
6..N. Speech — one per speaker slot
- Vote for Best Speaker
- Table Topics
- Vote for Best Table Topics
- Evaluation intro *(GE + standard time)*
- Evaluation — one per evaluator slot
- Vote for Best Evaluator
- General Evaluation
- Awards
- Reminders *(if set)*
- Thank You

## Testing

- Unit tests for `buildSlideDeck` in `src/lib/agenda-slides.test.ts`
  (patterned on `agenda-runsheet.test.ts`):
  - fully-populated meeting → expected ordered list of slide `kind`s;
  - blank `theme` / `wordOfTheDay` / `reminders` → those slides omitted;
  - blank `wodDefinition`/`wodExample` → word slide omits those lines;
  - N speaker slots → N speech slides + a vote-speaker slide;
  - zero speaker slots → no speech/vote-speaker slides;
  - open/unassigned slot → `— open —` surfaces;
  - Awards slide shows only the categories whose sections exist; dropped when
    all absent;
  - evaluator → speaker pairing matches `orderEvaluators`.
- `server-modules.guard.test.ts` already enforces the client-bundle boundary;
  `agenda-slides.ts` is pure and client-safe by construction.
- Thin smoke render of the present component to catch obvious render errors.

## Visual treatment

- Projection-optimized: large type, high contrast, one idea per slide.
- v1 palette explored in the mockup (maroon/gold, nodding to Toastmasters
  heritage) is **not load-bearing** — the exact palette will be iterated during
  build. Must be legible projected in both bright and dim rooms.

## Out of scope (v1)

- **Live speech timer** on timed slides (green/yellow/red countdown) — filed as
  GitHub issue #138. `buildTimeline`'s `TimingMarks` already exist to drive it
  later.
- Speaker's personal content slides (authored per speaker).
- `.pptx` download / Google Slides export.
- Static "Evaluation Tips" coaching slide.
- Per-club slide theming, reordering, or a configurable template.
- Per-participant Table Topics tracking / named TT vote nominees.
- A stored meeting-number for the title slide.
- URL-persisted slide position / deep-linking.
