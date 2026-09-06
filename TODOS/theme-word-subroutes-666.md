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

## The theme round trip is a LOST UPDATE, not just a full replace (sharpens P2)

Found by the authorization review pass on PR #698. The P2 above ("partial-update
writer for `updateMeeting`") is the fix; this is the concrete failure it
prevents, recorded so the next agent has the repro rather than the abstraction.

`themeOnlyUpdate` echoes `location / wordOfTheDay / wodDefinition / wodExample /
notes / reminders` from `Route.useLoaderData()`, captured ONCE at navigation. The
route never revalidates. So:

1. The TMOD opens `…/me/theme`. The loader snapshots the meeting, WOD empty.
2. The Grammarian opens `…/me/word` and saves "ineffable".
3. The TMOD types a theme and presses Save.
4. `applyMeetingUpdate` writes the TMOD's page-load snapshot back — **the Word of
   the Day is silently reverted to empty**, and the save reports success.

Both are pre-meeting duties typically done the same evening from a shared
WhatsApp link, so this is not a contrived interleave.

**One-directional.** The mirror case does not exist: `applyWordOfTheDayUpdate`
(`meetings-logic.ts:162-166`) sets only the three WOD columns and physically
cannot reach `theme`, `location` or `notes`. So a word save never clobbers a
theme; only the theme save clobbers.

A partial-update writer closes both this and the full-replace class in one move.
Revalidating before save would only narrow the window, not close it.
**Priority: P2**, same as the parent item — this is why it is P2 and not P3.

## `themeOnlyUpdate`'s echo depends on `loadMeetingDetail` returning an unprojected row

Also from review (Standards axis). The echo only works because
`loadMeetingDetail` does `db.query.meetings.findFirst` with no `columns` filter,
so all six fields are present on both the public and authed payloads. If that
reader is ever narrowed to select specific columns, an anonymous TMOD's theme
save silently nulls six fields — **and every test here stays green**, because the
integration test builds its echo from `STORED_META` rather than from a loader
payload. `EditorMeeting extends MeetingMetaEcho` makes a *dropped type* a compile
error, but not a *narrowed query*.

Worth one assertion that the public meeting payload actually carries all six
`MeetingMetaEcho` fields. Moot once the P2 partial writer lands. **Priority: P3.**
