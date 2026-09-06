# personal-meeting-polish-676

Noticed while landing #676 (personal meeting page polish). Nothing here is a bug a user can hit
today.

- **The 44px tap-target floor has no gate that can see a BOX.** `min-h-11` is asserted as a class
  string in `personal-meeting-body.test.tsx`, which is a deletion gate and nothing more — jsdom
  performs no layout, so it cannot see an ancestor that clips the row or a competing utility that
  beats the class. The repo has four browser-backed harnesses (print sheets, print density, pinned
  columns, dialog keyboard reach) and none of them measures a tap target. If a fifth is ever worth
  standing up, the shape is `pinned-column-reachability.test.ts`'s: read the real `className`
  strings out of source, lay a synthetic box out in headless Chrome, and assert the measured
  height — which would then cover every `size="lg"` call site in the app, not just this page's
  two buttons. Not worth it for one surface.
  **Priority:** P4

- **The page shows a start time but cannot show a finish time.** `formatMeetingTimeRange` exists
  and is what the schedule and agenda surfaces use, but it needs `lengthMinutes` and
  `loadPublicPersonalMeetingView` does not select it. Adding the column to that payload is a
  one-line seam change plus its integration-test payload assertion (which exists deliberately, to
  stop the roster row shipping email and phone — #560), so it is cheap but it is not this issue's
  file. Only worth doing if a member ever asks when the meeting ENDS, which is not the question
  this page is built around.
  **Priority:** P4

- **`formatMeetingKeyLabel`'s westward-shift protection cannot be reproduced by a test.** It parses
  the date key as a local calendar date precisely so a reader west of Greenwich is not shown the
  day before the one in their own URL, but whether the naive `new Date("2026-09-05")` would differ
  depends on the RUNNER's zone, and CI is UTC — where both forms agree. The suite pins the calendar
  round trip instead. A `TZ=America/Chicago` matrix run in CI would close it (and would close the
  same hole for every other date helper in `src/lib/format.ts`), but that is a CI-shape change, not
  a code one.
  **Priority:** P3

- **"See the full meeting page" is offered on the not-found state, where it points at a meeting
  that does not exist.** It is in the shell, so all five states carry it; the previous `BackLink`
  had exactly the same property, so this is not a regression. Suppressing it on that one branch
  means threading a prop through the shell for a link that 404s to the same "we couldn't find it"
  answer the page is already giving. Left as is.
  **Priority:** P4

## Review residue from PR #695

Judgement calls from the Standards and Spec axes, none blocking, none worth an
issue under CLAUDE.md's bar.

- **`EYEBROW` is `text-xs`, not `roles-guide.tsx:74`'s `text-[11px] tracking-[0.04em] uppercase`.**
  The issue cited that recipe for the ROLE GROUP label, and the same constant is
  now reused for the meeting-time eyebrow — so the time and the section heading
  render identically, when the time is the page's headline fact and the h2 is a
  divider. Worth splitting into two constants. **P4.**
- **`FullMeetingLink` has no `hover:`/`focus-visible:` affordance** while every
  other link on the page carries `hover:underline`. Undercuts the same
  consistency argument this diff makes for "Not you?". **P4.**
- **Three near-identical `Shell → Notice → Button` blocks stay in the route
  module**, along with `<Button className="min-h-11 w-full">Pick your name</Button>`
  — so those three buttons' copy and tap-target floor are gated by nothing, in
  the module the diff argues is untestable. The headings beside them ARE gated.
  Finishing the extraction would close it. **P3.**
- **`pending = "release"` also fires for "Yes, I can't make it" when `holdsRole`
  is false**, where nothing is released. Mysterious Name, no behavioural effect.
  **P4.**
- **Answer-button gap moved `gap-2` → `gap-3`** with no stated reason; the issue
  named 8px as the problem but not 12px as the answer. **P4.**

Resolved in review, not parked: `formatMeetingKeyLabel` re-derived
`parseMeetingKey`'s classification and already disagreed with it (it accepted
`-2599`, which the router rejects because 25:99 rolls into the next day). It now
delegates, held by an agreement test over both.
