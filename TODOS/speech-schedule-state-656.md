# speech-schedule-state-656

Noticed while fixing #656 (dashboard speech-log badge). Nothing here blocked the fix.

- **A cancelled meeting still reads "Completed" in the speech log.** `loadSpeechLog`
  (`src/server/my-activity-logic.ts`) neither filters nor selects `meetings.status`, so a slot on a
  meeting that was cancelled is a past instant like any other and `speechScheduleState` calls it
  delivered. `loadMyCommitments` beside it *does* exclude `ne(meetings.status, "cancelled")`, so the
  two lists disagree here for exactly the reason #656 was about — just on a different axis, and only
  for a club that cancels meetings rather than deleting them. Fixing it means adding
  `meetings.status` to the `SpeechLogRow` select and a third state to
  `src/lib/speech-schedule-state.ts`, which needs a pill design decision (a cancelled speech is
  neither scheduled nor delivered). Promote to an issue if a club hits it.
  **Priority:** P3

- **`SpeechStatePill` is now duplicated in both route files.** The two bodies are identical apart
  from one decorative dot the dashboard's Completed pill has and the profile's does not — a
  difference that predates this branch and that the issue put out of scope (no restyling). The
  *decision* and the *wording* are shared, which is what #656 asked for; the chrome is not. If a
  third speech-log surface ever appears, lift the component to `src/components/` and settle the dot
  at the same time.
  **Priority:** P4

- **`speeches.title`'s `"TBA"` sentinel has no single display helper.** `speechLogHeadline` is the
  second reader to handle it (after `role-duties.ts`), and both go through `isRealSpeechTitle`, so
  nothing is currently wrong. But other surfaces render `speechTitle` raw —
  `pathways-progress.tsx` and the dashboard's own "My upcoming roles" line
  (`r.speechTitle ?? r.theme`) among them — and would show the placeholder verbatim. Worth a sweep
  the next time someone is in that neighbourhood; not worth a change on its own.
  **Priority:** P4

## The complement with `loadMyCommitments` is skew-wide, not exact

Found by the Spec review axis on PR #693. `loadMyCommitments`
(`src/server/my-activity-logic.ts:194`) filters `gte(meetings.scheduledAt, new Date())`
on the SERVER; `now: Date.now()` in `dashboard.tsx`'s loader runs in the BROWSER on
any client-side navigation. So the two instants agree to within clock skew rather
than exactly, and a client clock running fast can badge a row `Completed` in the
speech log while "My upcoming roles" still lists it as signed up — the same #656
contradiction, narrowed from always-wrong to a skew-wide window.

Fix: have the server fn return the instant it filtered on and thread that down,
instead of sampling a second one in the loader. That is a change to
`my-activity-logic.ts` / the payload type, outside #656's `## Files`.
**Priority: P3** — the window is a mis-set client clock wide, and main was
unconditionally wrong here.

## The source guard encodes the `SpeechStatePill` duplication

Also from the Standards axis. The guard asserts
`/<SpeechStatePill\s+state=\{state\}\s*\/>/` and `/state === "scheduled"/` in a
`describe.each` over BOTH routes. So extracting the duplicated pill into
`src/components/` later requires editing the guard too — Shotgun Surgery baked
into a test. Not wrong today (the duplication is real and the guard should see
it), but whoever extracts the pill should expect to move the guard with it.
**Priority: P4.**

## This guard lives in a `.test.ts`, not a `.guard.test.ts`

~30 source guards here are named `*.guard.test.ts`; this one is a `describe`
block inside `speech-schedule-state.test.ts`. Splitting it out would match the
convention and make it greppable with its siblings. **Priority: P4.**
