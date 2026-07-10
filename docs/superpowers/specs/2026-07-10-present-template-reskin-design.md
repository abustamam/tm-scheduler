# Present-mode deck — template re-skin

**Date:** 2026-07-10
**Branch:** `feat/present-template-reskin`
**Status:** Design approved (visual review via HTML mockup)

## Goal

Re-skin the meeting present deck — **both** the live present view
(`meeting-present.tsx`) and the downloadable PowerPoint (`deck-to-pptx.ts`) — to
match the club's official Toastmasters template (see
`samples/Meeting_Progression_Presentation_MT55_070926.pptx.pdf`). The sample's
slide 8 is a speaker's own deck and is **not** part of the template.

This is a **visual re-skin only**. No schema changes, no new stored data, with
one small read-side addition (next-meeting date, below).

## Scope

**In scope**

- New per-slide chrome and layout for every slide kind, matching the template.
- A shared, pure layout descriptor (`slideLayout`) consumed by both renderers,
  replacing the drifting `slideContent` (pptx) + bespoke JSX `switch` (present).
- Deck structural changes in `buildSlideDeck` (merge/reorder — see below).
- A recreated Toastmasters International wordmark used on splash + footer.
- Next-meeting date/time on the Thank-You slide (small read-side query).
- An overflow guard so a pathologically long title/name never clips.

**Out of scope (deferred)**

- **Per-speech presentation links** ("Link: Presentation" in the sample) — a new
  `presentationUrl` on speeches + entry UI + clickable link in both renderers.
  Tracked in a separate GitHub issue.
- **Meeting number** ("Meeting #55") — not stored; intentionally omitted from the
  title slide.

## Decisions (from review)

- **Data-driven, template-styled.** Where the sample shows generic boilerplate but
  the app knows real data (e.g. the GE-intro slide), render the real
  names/roles/times in the template's visual style.
- **Headers are the slide title only.** Drop the `"{Club}: "` prefix. The club
  name + meeting date move to the footer.
- **Footer** (content slides): navy bar, white TI wordmark left, club name + compact
  meeting date right.
- **Drop the word "Session"** from section titles ("Speech Evaluation", "General
  Evaluation", "Award Presentation", "Table Topics").
- **Logo:** recreate the official wordmark (swap-in point for the real brand file).

## Architecture

`buildSlideDeck(meeting, club, slots, nextMeetingAt)` stays the single pure deck
builder producing `Slide[]`. A new pure module maps each `Slide` to a
presentation-agnostic **layout descriptor**:

```
src/lib/slide-layout.ts   →  slideLayout(slide: Slide): SlideLayout
```

Both renderers consume `SlideLayout`; neither re-derives content or copy. This
kills the current drift between the two renderers (e.g. present said "Cast your
vote" while the template wants "Ask for speaking time / Please Vote…") and makes
future slide tweaks a one-place edit.

```
Slide[]  ──slideLayout()──▶  SlideLayout
                              ├─ meeting-present.tsx  (Tailwind / cqw, on screen)
                              └─ deck-to-pptx.ts      (pptxgenjs shapes, .pptx)
```

### The descriptor

```ts
type Line =
  | { role: "head"; text: string }   // big bold ink
  | { role: "name"; text: string }   // medium bold, "•" prefix (vote lists)
  | { role: "muted"; text: string }  // small muted (e.g. GE team line)
  | { role: "spacer" };              // vertical gap between groups

type Body =
  | { form: "centered"; lines: Line[] }
  | { form: "bullets"; items: string[] }   // left-aligned "•", big bold
  | { form: "numbered"; items: string[] }  // "1." "2." "3."
  | { form: "word"; word: string; definition: string | null; example: string | null };

type SlideLayout =
  | { chrome: "splash"; tone: "light" | "dark"; headline: string; sub: Line[] }
  | { chrome: "content"; header: string; body: Body };
```

**Footer identity is derived, not threaded per slide.** Both renderers already
have (or can read) the title slide, which carries `clubName`, `scheduledAt`, and
`timezone`. The content footer's club name + date come from there — no new
per-slide fields.

### Section-title map (content chrome header)

| Slide kind         | Header                        |
|--------------------|-------------------------------|
| `toastmaster`      | Toastmaster                   |
| `toastmasterIntro` | Toastmaster Intro             |
| `geIntro`          | General Evaluator Intro       |
| `wordOfDay`        | Word of the Day               |
| `speech`           | First/Second/Third… Speech (single speaker → "Speech") |
| `voteSpeaker`      | Vote for Best Speaker         |
| `tableTopics`      | Table Topics                  |
| `voteTableTopics`  | Vote for Best Table Topic     |
| `evalIntro`        | Speech Evaluation             |
| `evaluation`       | Speech Evaluation             |
| `voteEvaluator`    | Speech Evaluation             |
| `generalEvaluation`| General Evaluation            |
| `awards`           | Award Presentation            |
| `reminders`        | Reminders                     |

## Deck structure changes (`buildSlideDeck`)

1. **Merge** the announcement of theme + Word-of-the-Day into one new
   `toastmasterIntro` slide (sample slide 3: "Meeting Theme: …" + "Word of the
   Day: …"). Render only the parts present.
2. **Keep** a standalone `wordOfDay` slide (the big word + definition + example),
   emitted **only when** a definition or example exists.
3. **Order** to match the sample:
   `title → toastmaster → toastmasterIntro → geIntro → wordOfDay → speeches →
   voteSpeaker → tableTopics → voteTableTopics → evalIntro → evaluations →
   voteEvaluator → generalEvaluation → awards → reminders → thankYou`.
4. **Speech labels** become ordinal words ("First Speech", "Second Speech",
   "Third Speech", "Fourth Speech", "Fifth Speech"; beyond that fall back to
   "Speech N"). A lone speech is just "Speech".
5. `thankYou` gains `nextMeetingAt: Date | null`.

Each emitted slide stays conditional on its data exactly as today (no GE slot →
no GE slides, etc.).

## Slide content (data-driven, template-styled)

- **title** (splash-light): color logo, navy rule, **club name** headline; sub =
  `District…`, `Club #…`, full date ("Thursday, July 9, 2026"), `Start time: 6:45 PM`.
- **toastmaster** (centered): body is the name only (header already says
  "Toastmaster").
- **toastmasterIntro** (centered): `head` lines "Meeting Theme:", `"{theme}"`,
  `spacer`, "Word of the Day:", `"{word}"` (only present groups).
- **geIntro** (centered): "General Evaluator:", **{name}**, then a `muted` team
  line built from the legend (roles · assignees).
- **wordOfDay** (word): big `{word}`, `{definition}`, `"{example}"`.
- **speech** (bullets): "Speaker: {name}", `Speech Title: "{title}"`,
  optional "Project: {projectLevel}", "Time: {time}". *No Link bullet (deferred).*
- **voteSpeaker** (centered): "Ask for speaking time.", "Please Vote for Best
  Speaker:", then `name` lines.
- **tableTopics** (bullets): "Table Topic Master: {master}", "Impromptu Speeches",
  "Speaker time: {timing}".
- **voteTableTopics** (centered): "Ask for Table Topics times.", "Please Vote for
  Best Table Topic Speaker:".
- **evalIntro** (centered): "General Evaluator:", **{name}**, "Time: {time}".
- **evaluation** (centered): "Evaluator: {evaluator}", optional "Speaker:
  {speaker}", "Time: {time}".
- **voteEvaluator** (centered): "Ask for timer's report:", "Please Vote for Best
  Evaluator:", then `name` lines.
- **generalEvaluation** (centered): "General Evaluator", "Closing Remarks",
  "Time: {time}".
- **awards** (numbered): the categories, 1·2·3.
- **reminders** (centered): the reminder text (app extra; not in the sample, kept
  and styled consistently; only when present).
- **thankYou** (splash-dark): navy gradient; white logo + rule; **gold "Thank
  You"**; club name; "CONGRATULATIONS on another great learning session!"; then
  "Next Meeting:" + `{nextMeetingAt}` date + time. Falls back to "We meet
  {meetingSchedule}" when there is no next meeting.

## Palette

Reuse the existing constants; add gold.

| Token   | Hex       | Use                                   |
|---------|-----------|---------------------------------------|
| INK     | `#2b2b2b` | body text, headlines                  |
| MAROON  | `#9b1c2e` | header underline                      |
| NAVY    | `#0a3a5a` | footer bar, Thank-You ground          |
| GROUND  | `#f3f4f4` | content/title ground                  |
| MUTED   | `#565656` | sub-lines, definitions, team line     |
| GOLD    | `#f3dd94` | "Thank You" headline (new)            |

Thank-You ground is a vertical navy gradient (`#0d4467 → #062a41`).

## Logo asset

Recreate the Toastmasters International wordmark (two-line lockup: "TOASTMASTERS"
over letter-spaced "INTERNATIONAL"; navy/maroon on light, white on dark).

- **Web:** an inline SVG React component (`toastmasters-wordmark.tsx`) with a
  `tone: "color" | "white"` prop — scales crisply at any slide size.
- **PPTX:** a matching text lockup (two `addText` calls with letter-spacing) so
  the `.pptx` needs no binary asset and stays editable. Visually identical to the
  SVG because both are just the wordmark set in a bold sans.
- **Swap point:** to use the official brand raster later, drop the file in and
  switch the component to an `<img>` and the pptx to `addImage`.

Trademark: the user (an MCF club member) authorized recreating the mark for their
own club's deck.

## Data plumbing (next-meeting date)

The only new read: the club's next meeting after the current one.

- Add `nextMeetingAt: Date | null` to the meeting data source that the present
  route and `meetings.$id` loader already use (extend `getMeeting` /
  `meetings-logic`): `SELECT scheduled_at FROM meetings WHERE club_id = ? AND
  scheduled_at > ? ORDER BY scheduled_at ASC LIMIT 1`.
- Thread it into `buildSlideDeck(..., nextMeetingAt)` at both call sites
  (`present.tsx`, `meetings.$id.tsx`). Date formatting stays in the renderers.

## Overflow guard

- **Web:** a small fit-to-box hook on the content body — measure `scrollHeight`
  vs `clientHeight` and step a font-scale down until it fits (bounded min). Sizes
  in the mockup already fit the worst case (3 speakers/evaluators, wrapping
  titles); the guard is insurance for outliers.
- **PPTX:** use pptxgenjs text `fit: "shrink"` on the headline/body boxes.

## Testing

- `agenda-slides.test.ts` — update deck order + the `toastmasterIntro` merge +
  standalone `wordOfDay` condition + ordinal speech labels + `thankYou.nextMeetingAt`.
- `slide-layout.test.ts` (new) — pure `slideLayout(slide)` per kind: header text
  (section-title map, no "Session"), body form + lines/items, toastmaster body =
  name only, vote prompt copy.
- `deck-to-pptx.test.ts` — update to the new content (both renderers now driven by
  `slideLayout`); keep pptx-specific assertions (file name, slide count, chrome).
- `meeting-present.test.tsx` — update rendered-content assertions.

Both renderers being descriptor-driven means most assertions live on
`slideLayout`, with thin renderer smoke tests.

## Files touched

- `src/lib/agenda-slides.ts` — deck merge/reorder, ordinal labels, `nextMeetingAt`.
- `src/lib/slide-layout.ts` — **new** shared descriptor + `slideLayout`.
- `src/components/agenda/meeting-present.tsx` — render `SlideLayout` (chrome, forms,
  splash, footer, fit guard).
- `src/lib/deck-to-pptx.ts` — render `SlideLayout` via pptxgenjs (header + maroon
  rule shape, navy footer + logo/meta, splash, gradient Thank-You, gold, shrink).
- `src/components/agenda/toastmasters-wordmark.tsx` — **new** SVG wordmark.
- Meeting data source (`getMeeting` / `meetings-logic`) + both call sites —
  `nextMeetingAt`.
- Tests as above.

## Follow-up

- Open a GitHub issue for per-speech presentation links (schema `presentationUrl`,
  edit-speech field, clickable "Link: Presentation" in both renderers).
