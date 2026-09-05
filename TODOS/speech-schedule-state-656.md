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
