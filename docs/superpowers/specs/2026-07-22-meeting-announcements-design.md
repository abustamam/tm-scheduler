# Meeting Announcements — Design

**Date:** 2026-07-22
**Status:** Approved (brainstorming) — ready for implementation plan

## Summary

Give each meeting an optional **Announcements** field that organizers can edit
and that is displayed on the meeting agenda. This reuses the existing
`meetings.reminders` free-text column (schema comment: *"Free-text club
announcements projected on the present-mode Reminders slide"*), which is already
validated, persisted, and returned on every read path but currently has **no
editor** and is **only shown on the present-mode slide deck**.

The feature is therefore: (1) add an editor for the field, (2) render it on the
on-screen agenda and the printed one-pager, and (3) unify the product-facing name
to "Announcements".

## Decisions (locked during brainstorming)

- **Reuse `meetings.reminders`** — no schema change, no migration. Announcements
  ARE this field.
- **Single multi-line text box** — one `<textarea>`; each line is one
  announcement. Matches the existing single-column storage and how the
  present-mode slide already renders the value. No child table, no JSON.
- **Line rule (agenda + print):** split on `\n`, trim, drop blank lines. Present
  mode keeps its existing blank-line-as-spacer behavior.
- **On-screen agenda = plain inline section**, not a highlighted callout.
- **Display surfaces:** on-screen agenda (new, plain inline), printed agenda
  across **all four layouts** (new — see §3 for per-layout placement),
  present-mode slide (already exists — kept as-is functionally).
- **Naming:** label the field **"Announcements"** everywhere in the UI, and
  rename the present-mode slide's visible title from **"Reminders" → "Announcements"**
  so one word maps to one concept. The DB column stays named `reminders`
  (internal only — renaming it would be a pointless migration).
- **Public/guest visibility: yes.** Announcements are shown to anyone who can
  view the agenda (guests included). Consistent with the present-mode slide
  already being public and the field already being present on public read
  payloads. Announcements are meant to be broadcast.
- **Create form: excluded.** Announcements are added by editing a meeting, not at
  creation time. `createMeetingSchema` and `meetings.new.tsx` are untouched.

## Data model — no schema change

Column already exists:

```
meetings.reminders  text  (nullable)
```

Already wired end-to-end server-side:

- `updateMeetingSchema` (`src/server/meetings.ts`) accepts
  `reminders: z.string().trim().optional()`.
- `updateMeetingMeta` (`src/server/meetings-logic.ts`) persists
  `reminders: input.reminders?.trim() || null` — so whitespace-only input is
  normalized to `null` (empty ⇒ nothing stored, nothing rendered).
- `loadMeetingDetail` returns the full meeting row (no column projection), so
  `meeting.reminders` is already present on `getMeeting`, `getMeetingByKey`, and
  the public `getPublicMeetingByKey`.

No changes to schema, migrations, zod, or the persistence layer are required.

## Components & data flow

### 1. Editing — `MeetingMetaDialog`

`src/components/agenda/meeting-meta-dialog.tsx`

- Add an **"Announcements"** multi-line `<textarea>` to the meta form, placed
  among the public-facing fields (theme / word-of-the-day), NOT next to notes.
- Add `reminders` to the dialog's local form state (initialized from
  `meeting.reminders ?? ""`).
- Include `reminders` in the payload the dialog sends to `updateMeeting`
  (it currently omits `reminders`). The server fn already accepts it.
- Gate: unchanged — the dialog is already rendered only under
  `viewer.canEditMeetingMeta`, which resolves to **admin OR the meeting's
  Toastmaster (TMOD), and only within the editable window** (false for a past
  meeting). The Grammarian's narrow WOD-only editor does NOT gain announcements.
  This is the intended audience — no new permission.
- **Make visibility explicit in the copy** so the public/private split is
  obvious (both fields are free text in one dialog):
  - Announcements help text: *"Shown publicly on the agenda, printout, and
    slides — visible to guests. One per line."*
  - Notes label/help: *"Private — only visible to organizers."*

### Line rendering (shared rule)

A small pure helper turns the stored blob into display lines: **split on `\n`,
trim each line, drop blank lines** → an array of non-empty strings, each one
announcement. Used by the on-screen agenda and all print surfaces so they render
an identical clean list. Present mode keeps its own existing behavior (splits on
`\n`, blank lines become vertical spacers) — deliberately unchanged, since a
centered slide is a different visual context. This helper is unit-tested.

### 2. On-screen agenda display

`src/routes/club.$clubId.meeting.$meetingId.tsx`

- Where `theme` and `wordOfTheDay` are rendered in the meeting header, add a
  **plain inline "Announcements" section** (NOT a highlighted callout) directly
  beneath the header and above the role list.
- Render the shared line list (bullets / stacked lines).
- Hidden entirely when `meeting.reminders` is empty/null (no empty section) — a
  normal agenda is visually unchanged.
- Visible to all viewers (signed-in and guest) — no gating.

### 3. Printed agenda — all four layouts

`src/components/agenda/meeting-agenda-print.tsx` +
`src/routes/club.$clubId_.meeting.$meetingId.print.tsx`

- Add an `announcements` field to the `AgendaHeader` type; pass `meeting.reminders`
  from the print route (alongside `theme` / `wordOfTheDay` / `location`).
- A shared `AnnouncementsBlock` print component ("Announcements" `Kick` label +
  the shared line list, styled with `print-theme.tsx` tokens). Rendered only when
  announcements exist. Per-layout placement:
  - **Editorial** (`FitPage`, one page): bottom of the **left rail**, after the
    Club Mission block.
  - **Grid** (`FitPage`, one page): a compact section **after the Run of Show
    table, before the pinned officer footer**. `FitPage` scale-to-fits, so the
    sheet shrinks slightly if needed — it stays **one page** regardless.
  - **Spacious** (`TwoPage`): in the page-2 `NotesBlock`/`VotesBlock` row,
    **swap the `NotesBlock` (3 ruled "Meeting Notes" lines) for the announcements
    block WHEN announcements exist; otherwise keep the ruled lines.** `VotesBlock`
    unchanged.
  - **Timing** (`TwoPage`): same conditional swap for its `NotesBlock` (4 lines);
    `VotesBlock` unchanged.
- No hard line cap. `FitPage` guarantees one page for Grid/Editorial; the
  two-pagers have ample room. Truncating on the un-scrollable printout would hide
  real content, so we don't.

### 4. Present-mode slide (rename only)

`src/lib/slide-layout.ts` (the `case "reminders"` descriptor, ~line 179) — the
present deck itself (`buildSlideDeck` in `src/lib/agenda-slides.ts`) is unchanged.

- Functionally unchanged — `buildSlideDeck` already emits the reminders slide
  from `meeting.reminders`, and the descriptor already splits on `\n`.
- Update the slide's **visible title** from `content("Reminders", …)` to
  `content("Announcements", …)` for naming consistency. The slide `kind` string
  stays `"reminders"` internally; only user-visible text changes.

## Error / edge handling

- Empty or whitespace-only input ⇒ stored as `null` (existing
  `updateMeetingMeta` behavior) ⇒ no section rendered on any surface.
- Long text: the textarea scrolls; agenda/print sections wrap naturally. No
  length cap beyond what the DB text column allows (none needed).
- No new failure modes — no new server fn, no new query, no migration.

## Testing

- **Line helper (unit):** `split \n → trim → drop blanks` returns the expected
  array; empty/whitespace-only input ⇒ `[]`.
- `src/components/agenda/meeting-meta-dialog.test.tsx`
  - Submitting the dialog includes `reminders` in the `updateMeeting` payload.
  - Editing to empty submits empty (⇒ server normalizes to null).
- Agenda render test (route/component):
  - Plain announcements section appears when `meeting.reminders` is present;
    absent when null/empty; multi-line value renders each line as a separate item.
- `src/components/agenda/meeting-agenda-print.test.tsx`
  - Announcements section renders when present / hidden when empty, per layout.
  - **Two-pager conditional swap:** Spacious & Timing show announcements in the
    notes slot when present, and fall back to the ruled `NotesBlock` when empty;
    `VotesBlock` present in both cases.
- `src/lib/slide-layout.test.ts` (or `meeting-present.test.tsx`)
  - Present-slide visible title asserts "Announcements".

## Out of scope (YAGNI)

- No structured/discrete announcement items (add/remove rows) — single text box.
- No new DB column and no column rename migration.
- No announcements field on the meeting-create form.
- No new visibility/permission model — reuse `canEditMeetingMeta` for editing;
  read is public like the rest of the agenda.

## Touch list (for the implementation plan)

| File | Change |
|------|--------|
| shared line helper (new, e.g. in `src/lib/`) | `split \n → trim → drop blanks`; unit-tested |
| `src/components/agenda/meeting-meta-dialog.tsx` | Add Announcements textarea (public) + form state + include `reminders` in update payload; make notes/announcements visibility explicit in copy |
| `src/routes/club.$clubId.meeting.$meetingId.tsx` | Render plain inline Announcements section under the header |
| `src/components/agenda/meeting-agenda-print.tsx` | Add `announcements` to `AgendaHeader`; add `AnnouncementsBlock`; place in Editorial (left rail), Grid (after Run of Show), and conditionally swap `NotesBlock` in Spacious + Timing |
| `src/routes/club.$clubId_.meeting.$meetingId.print.tsx` | Pass `meeting.reminders` into the print header |
| `src/lib/slide-layout.ts` (line ~179) | Rename visible slide title "Reminders" → "Announcements" (slide `kind` stays `"reminders"`) |
| Tests | Line helper, editor payload, agenda render, print render (per layout + two-pager swap), slide title |
