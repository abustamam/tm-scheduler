# theme-word-subroutes-666

Deferred from #666 (the focused `/me/theme` and `/me/word` editors). Nothing here is a
correctness bug; each is a shape worth revisiting.

- **`updateMeeting` is a full REPLACE, and every partial editor has to know it.**
  `applyMeetingUpdate` writes `location: input.location?.trim() || null` and the same
  line for `wordOfTheDay`, `wodDefinition`, `wodExample`, `notes` and `reminders`, so an
  omitted field is not "leave it alone" — it is *null it*. #666 handled that with
  `#/lib/meeting-meta-update`'s `themeOnlyUpdate`, an echo the caller must remember to
  use, plus an enrollment sweep over `updateMeetingSchema` so a NEW field cannot fall
  outside the echo silently. That closes the hole for callers who go through the echo;
  it does not remove the class. A `applyMeetingMetaPatch` that treats `undefined` as
  "unchanged" and only `null` as "clear" would, and would let a focused editor send
  three fields instead of nine. It is a change to the writer every existing caller
  shares, so it needs its own issue and its own test pass rather than riding here.
  The CONTROL in `personal-duty-edit.integration.test.ts` reproduces the damage against
  the real writer, so the cost is written down and reproducible.
  **Priority:** P2

- **Both editors load the whole meeting payload for a one-field page.** They fork
  `context.shell ? getMeetingByKey : getPublicMeetingByKey` exactly as the meeting page
  does, which is ~8-12 queries (officers, next meeting, template content, the plan
  ladder, every slot with speech details) to render one input on a phone. That is not
  gratuitous today: the theme editor needs the six meta fields it must echo, and the
  word editor needs `wod_definition` / `wod_example`, and NEITHER travels on #665's
  personal-meeting payload. Two ways out, and the right one depends on the bullet
  above — a partial writer would leave only the WOD prefill to fetch, which
  `loadPublicPersonalMeetingView` could carry in two extra columns. Reaching for a new
  narrow public reader BEFORE that decision would be a third seam over the same row.
  **Priority:** P3

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
