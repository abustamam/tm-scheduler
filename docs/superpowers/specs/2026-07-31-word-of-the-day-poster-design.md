# Word of the Day poster

A single printable sheet carrying a meeting's Word of the Day in display type,
with its definition and example usage beneath. Printed on letter portrait and
taped to the wall or whiteboard so the whole room can read it from any seat.

## Why

The Word of the Day already lives on `meetings` (`wordOfTheDay`,
`wodDefinition`, `wodExample`) and surfaces three ways: a small line in the
print agenda header, a slide in Present mode, and a word-plus-note line on
role-sheet PDFs. None of those is a wall artifact. A club that does not project
its agenda has no way to keep the word visible for the hour members are supposed
to be using it.

## Scope

One new public print page and the button that opens it. No schema change, no
change to the Present slide, the agenda header, or the role-sheet PDFs.

## Route and entry point

New file `src/routes/club.$clubId_.meeting.$meetingId.word.tsx`, following the
escaped-parent standalone pattern of the existing print route so it renders
outside the club shell.

- Public, `robots: noindex, nofollow`, matching the other print surfaces.
- Loader: `resolveClubOrRedirect(params.clubId, location)` then
  `getPublicMeetingByKey({ clubId, key })`, with the same
  `meeting.clubId !== club.id → notFound()` check the print route makes.
- No server change. `loadMeetingDetail` reads the meeting via
  `db.query.meetings.findFirst`, so `wodDefinition` and `wodExample` are already
  on the public payload.

`<title>` becomes the browser's default Save-as-PDF filename.
`meetingPdfBasename` in `src/lib/pdf-filename.ts` hardcodes the middle segment
`-meeting-`; give it a segment parameter rather than duplicating the club-slug
and ISO-date helpers, so this page yields
`Downtown-Toastmasters-word-of-the-day-2026-07-31`. The existing call site keeps
its current output.

`MeetingViewActions` (`src/components/club/meeting-view-actions.tsx`) gains an
optional `wordOfTheDay?: string | null` prop and renders a "Word poster" button
only when that value is non-blank. Its single caller,
`src/routes/club.$clubId.meeting.$meetingId.tsx:619`, passes
`meeting.wordOfTheDay`.

## The poster component

`src/components/agenda/word-of-the-day-poster.tsx` — presentational only, props
`{ word, definition, example, clubName, dateLong }`. It touches no data layer,
so it is testable with React Testing Library the way `club-role-sheet.tsx` is.

Built from `src/components/agenda/print-theme.tsx`:

- `SERIF` (Fraunces) for the word, `SANS` for everything else.
- `INK`, `FOREST`, `MUTED` for color.
- `PAGE_W` / `PAGE_H` for the letter-portrait sheet.
- `Kick` for the "Word of the Day" eyebrow.
- `DarkFooter` for club name, date, and the non-affiliation disclaimer the other
  sheets already carry.

The sheet is wrapped in `FitPage`, like the other printables. Content should fit
by construction, but `FitPage` supplies the `.agenda-page` class and
`PAGE_OUTER` styling that the print CSS keys on, and gives a true WYSIWYG
on-screen preview if a long definition ever pushes past the page.

Layout, top to bottom: eyebrow, the word centered in the page's optical middle,
then definition and example in a measure of roughly 55 characters so lines do
not run the full page width. The example is italic and quoted.

Definition and example are independently optional. When one is absent its block
is omitted entirely and the word centers in the extra space; the poster never
renders an empty label or a stray rule.

## Page chrome and print CSS

The print route carries a fixed toolbar of layout tabs, a share button, a Print
button, and an offline badge. The poster has exactly one layout and one job, so
its toolbar is a single `.no-print` Print button calling `window.print()`,
reusing that route's button styling. No layout tabs, no share button, no offline
badge.

The page carries the same inline `<style>` block the print route uses — a
tinted screen background, white on print, `.no-print { display: none
!important }`, and `@page { size: letter portrait; margin: 0 }` — plus one rule
the print route does not have. Inside `@media print` it must reset
`.pgwrap { padding: 0 !important }`, overriding the `28px 0` screen padding.
That reset is load-bearing: without it the wrapper's padding pushes the
single sheet past one page and the browser emits a blank second page.

## Sizing the word

"Apt" and "Obstreperousness" cannot share a font size. A pure function decides
it from length:

```ts
export function posterWordSize(word: string): number; // px
```

There are **two** bucket tables, because capitals run 20–30% wider than
lowercase and no single table can serve both — at the ordinary sizes `POWWOW`
reaches 122% of the usable width and `GROUNDWORK` 132%, each breaking mid-word.
Sizing the ordinary table down far enough to absorb that would shrink every
normal word to pay for a styling choice, so an all-caps word (contains a letter
and equals its own uppercase) selects its own smaller table instead.

| length | ordinary | ALL CAPS |
| ------ | -------- | -------- |
| ≤6     | 173      | 141      |
| ≤10    | 116      | 94       |
| ≤14    | 90       | 65       |
| ≤18    | 74       | 52       |
| else   | 61       | 44       |

Both tables are derived against a **685px** target rather than the **704px**
true content width (`PAGE_W` 816 less 2 × 56px padding). The ~19px difference
is deliberate slack for cross-browser rendering variance: these were measured
in one headless Chrome, and hinting, subpixel positioning and font-version
differences move text width by fractions of a percent elsewhere. Every size is
the largest that clears the target against every lowercase common word in
`/usr/share/dict/words` (~64k), in lowercase, Capitalised and ALL-CAPS forms.

The word element also carries `overflow-wrap` as a backstop for anything
pathological.

This is deterministic, SSR-safe, and unit-testable, with no measurement pass and
no layout thrash at render time. The derivation itself is a committed harness,
`scripts/measure-word-poster.ts`, which reads the sizes, boundaries, weight and
font family from source and re-verifies them against a real browser; the numbers
above are not maintained by hand.

Rejected alternative: an SVG `viewBox` auto-fitting the word to the page width
regardless of glyph metrics. More robust in the extreme case, but it puts
display type inside an SVG — worse text selection, worse print rasterization on
some drivers — to solve a case that does not occur, since a word of the day is
a single word.

## When no word is set

The button is hidden upstream, so the page is reached only by a typed or shared
URL. In that case it renders an on-screen card reading "No Word of the Day set
for this meeting yet." with a link back to
`/club/$clubId/meeting/$meetingId`. No poster, no Print button — nothing that
would produce a blank sheet.

"Blank" means null, empty, or whitespace-only; the button-visibility check and
the page's own check must use the same trimmed test so they cannot disagree.

## Offline

No change needed. `isOfflineRoute` in `public/sw.js` names `/present` and
`/print` explicitly, but it also matches `/^\/club\/[^/]+\/meeting\//` — and
`/club/:slug/meeting/:key/word` already satisfies that regex. The poster lands
in the navigation cache for free, with no service worker version bump.

The page deliberately does not show the "Available offline" badge the print
route carries; see "Page chrome" above.

## Testing

- `word-of-the-day-poster.test.tsx` (RTL, patterned on
  `club-role-sheet.test.tsx`): the word renders; definition and example render;
  each is independently omissible without leaving an empty block; the footer
  carries club name and date.
- `posterWordSize` unit tests at every bucket boundary.
- Route-level test for the no-word state: the prompt renders, the poster and
  Print button do not.
- `MeetingViewActions` test that the button is hidden for `null`, `""`, and
  `"   "`, and shown for a real word. This branch exists only because of the
  hide-the-button decision, so it needs a test that can actually fail —
  see the coverage traps in `CLAUDE.md`.

## Out of scope

- **No schema change.** There is no part-of-speech column. The poster prints
  `wodDefinition` as typed; clubs wanting a part of speech already write
  "adj. lasting a short time" into it. Adding a column would mean touching the
  Word of the Day dialog, the slide builder, and the role-sheet PDF for a
  cosmetic gain.
- **No Grammarian credit.** Present mode credits the Grammarian on its Word of
  the Day slide. A poster hangs for the whole meeting, where attribution reads
  as clutter and goes stale if the role is reassigned after printing.
- No change to the Present slide, the agenda print header, or the role-sheet
  PDFs.
