# theme-word-subroutes-666

Deferred from #666 (the focused `/me/theme` and `/me/word` editors). Nothing here is a
correctness bug; each is a shape worth revisiting.

- ~~**`updateMeeting` is a full REPLACE, and every partial editor has to know it.**~~
  **DONE — #772.** `applyMeetingMetaPatch` replaced it: `undefined` means unchanged,
  `null` or a blank string means clear, and the `set` it builds is SPARSE, so a column
  the caller did not send is absent from the SQL rather than rewritten. `themeOnlyUpdate`
  / `MeetingMetaEcho` and their enrollment sweep are deleted; the sweep moved to
  `src/server/meeting-meta-patch.guard.test.ts`, because the failure it guarded changed
  shape rather than going away (a field the echo forgot was NULLED; a field the writer
  forgets is IGNORED — both silent, both typecheck). The lost update below went with it.
  The one thing the change had to undo in the same breath: the admin dialog relied on
  omission-means-clear to clear a field, so `meetingUpdateFromForm` now sends `null` for
  a blanked input and `undefined` only for one the form never rendered.

- **Both editors load the whole meeting payload for a one-field page.** They fork
  `context.shell ? getMeetingByKey : getPublicMeetingByKey` exactly as the meeting page
  does, which is ~8-12 queries (officers, next meeting, template content, the plan
  ladder, every slot with speech details) to render one input on a phone. That was not
  gratuitous when it was written: the theme editor needed the six meta fields it had to
  echo, and the word editor needs `wod_definition` / `wod_example`, and NEITHER travels on #665's
  personal-meeting payload. The bullet this was waiting on has landed (#772), and it
  decided the question: the theme editor needs only the theme, so all that is left to
  fetch is the WOD prefill, which `loadPublicPersonalMeetingView` could carry in two
  extra columns rather than a third narrow reader over the same row.
  **Priority:** P3 — unblocked, not done.

- **The checklist links into a closed window.** `personal-meeting-body.tsx` renders a
  duty row whatever the meeting's state, so on a completed, cancelled or past meeting a
  member taps "Set the meeting theme" and lands on a card whose only content explains
  why there is nothing to do. Correct, and better than a form that would be refused,
  but the tap is avoidable: the checklist already computes `writesClosed` for the answer
  buttons and could render the rows as plain text. Left alone deliberately — that file
  and the route beside it are #676's, which was running in parallel.
  **Priority:** P4

- **`editorBlockedReason` blocks a CANCELLED meeting; the agenda page does not.**
  `isMeetingLocked` is completed-only, so the full meeting page still lets a Toastmaster
  edit a cancelled meeting's meta, while these `/me/` editors refuse it — matching
  `personal-meeting-body.tsx`, which closes its answer buttons on `cancelled` for the
  same reason. Two surfaces, two answers to one question. The `/me/` behaviour is the
  one that reads right to a member; whether the agenda should follow is a product call.
  **Priority:** P4

## ~~The theme round trip is a LOST UPDATE, not just a full replace~~ (CLOSED by #772)

Found by the authorization review pass on PR #698, and closed by #772 along with the
parent item. Kept because it is the concrete failure, and the test that now holds it
(`meeting-meta-patch.integration.test.ts`, "does not revert a field another officer
saved after the page loaded") reads as an abstraction without it:

`themeOnlyUpdate` echoed `location / wordOfTheDay / wodDefinition / wodExample /
notes / reminders` from `Route.useLoaderData()`, captured ONCE at navigation. The
route never revalidated. So:

1. The TMOD opens `…/me/theme`. The loader snapshots the meeting, WOD empty.
2. The Grammarian opens `…/me/word` and saves "ineffable".
3. The TMOD types a theme and presses Save.
4. `applyMeetingUpdate` wrote the TMOD's page-load snapshot back — **the Word of
   the Day was silently reverted to empty**, and the save reported success.

Both are pre-meeting duties typically done the same evening from a shared
WhatsApp link, so this was not a contrived interleave.

**One-directional.** The mirror case never existed: `applyWordOfTheDayUpdate` sets
only the three WOD columns and physically cannot reach `theme`, `location` or
`notes`. So a word save never clobbered a theme; only the theme save clobbered.

The patch writer closed both this and the full-replace class in one move, as
predicted. Revalidating before save would only have narrowed the window.

## ~~`themeOnlyUpdate`'s echo depends on `loadMeetingDetail` returning an unprojected row~~ (MOOT — #772)

Also from review (Standards axis), and moot as that entry predicted: there is no echo
left to depend on the reader's shape. A theme save now names one column, so narrowing
`loadMeetingDetail` can cost a PREFILL — an input rendering blank — but it can no longer
null six columns on save. The word editor is the one that still needs its three WOD
columns present on the payload, and `EditorMeeting` names exactly those.
