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

## Grill resolutions (2026-07-10)

Stress-tested with the user; each answer is baked into the sections below.

1. **Logo:** use the official vendored assets in `src/assets/` (no recreation).
2. **PPTX Thank-You background:** solid navy `#004062` (pptxgenjs has no gradients).
3. **`nextMeetingAt`:** relative to this meeting's date, excluding cancelled.
4. **District line:** render `club.district` verbatim; no new division field.
5. **Speech project/level:** show as a bullet when present.
6. **GE team line:** filled roles only.
7. **Overflow:** fit-to-box guard (web hook + pptx `fit:"shrink"`).
8. **Palette:** align navy/maroon to the official brand hexes (`#004062`/`#770D29`).

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
  line built from the legend (roles · assignees), **filled roles only** — open
  slots omitted; if none are filled, drop the team line. Filtering is scoped to
  this slide in `slideLayout`, leaving `buildLegend`'s other consumers unchanged.
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
| MAROON  | `#770D29` | header underline (official brand)     |
| NAVY    | `#004062` | footer bar, Thank-You ground (official brand) |
| GROUND  | `#f3f4f4` | content/title ground                  |
| MUTED   | `#565656` | sub-lines, definitions, team line     |
| GOLD    | `#f3dd94` | "Thank You" headline (new)            |

Navy + maroon are the official wordmark colors (sampled from
`ToastmastersWordmarkColor.svg`) so the footer bar and header rule match the logo;
these deepen the tones slightly versus the approved mockup. Thank-You ground is a
vertical navy gradient derived from the brand navy (`#0a4f78 → #002a41`) on the
web; the `.pptx` uses solid `#004062` (pptxgenjs has no gradient fill).

## Logo asset

Use the official vendored brand files in `src/assets/` (no recreation):

- `ToastmastersWordmarkColor.svg` (navy `#004062` / maroon `#770D29`) — title splash.
- `ToastmastersWordmarkWhite.svg` — content footer + Thank-You splash.
- `ToastmastersWordmarkBlack.svg` and `ToastmastersLogo3Color.svg` (the full globe
  emblem + banner) are also vendored; the full logo is an option for the title
  splash if we later want more presence there.

- **Web:** import the SVGs (Vite resolves the import to a URL) and render via
  `<img>`, sized by slide width. The Color/White wordmark SVGs ship on a padded
  US-Letter canvas (`viewBox 0 0 612 792`, artwork ~420×84 with contradictory
  `width`/`height` attrs), so **normalize once** to a tight transparent
  `viewBox`; commit the normalized SVGs. (The White/Black PNGs are already tightly
  cropped; the Color PNG is padded at 1836×2376.)
- **PPTX:** embed tight transparent **PNG** variants via `addImage` (base64) —
  Color for the title, White for the footer + Thank-You. Rasterize from the
  normalized SVGs so all variants share one tight frame.

Brand colors are taken from these files (navy `#004062`, maroon `#770D29`); the
deck palette uses them so chrome matches the wordmark.

## Data plumbing (next-meeting date)

The only new read: the club's next meeting after the current one.

- Add `nextMeetingAt: Date | null` to the meeting data source that the present
  route and `meetings.$id` loader already use (extend `getMeeting` /
  `meetings-logic`): `SELECT scheduled_at FROM meetings WHERE club_id = ? AND
  scheduled_at > ? AND status <> 'cancelled' ORDER BY scheduled_at ASC LIMIT 1`.
  Relative to **this meeting's** `scheduledAt` (not wall-clock now), so it is
  correct when re-presenting a past meeting and stays deterministic/testable.
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
- `src/components/agenda/toastmasters-wordmark.tsx` — **new** thin `<img>` wrapper
  over the vendored brand SVGs (`color` / `white`); plus normalized tight SVGs and
  rasterized PNGs added under `src/assets/`.
- Meeting data source (`getMeeting` / `meetings-logic`) + both call sites —
  `nextMeetingAt`.
- Tests as above.

## Follow-up

- Open a GitHub issue for per-speech presentation links (schema `presentationUrl`,
  edit-speech field, clickable "Link: Presentation" in both renderers).
