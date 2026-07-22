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
- **Display surfaces:** on-screen agenda (new), printed one-page agenda (new),
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

- Add an **"Announcements"** multi-line `<textarea>` to the meta form, beside
  theme / word-of-the-day / notes.
- Add `reminders` to the dialog's local form state (initialized from
  `meeting.reminders ?? ""`).
- Include `reminders` in the payload the dialog sends to `updateMeeting`
  (it currently omits `reminders`). The server fn already accepts it.
- Gate: unchanged — the dialog is already rendered only under
  `viewer.canEditMeetingMeta`, so the same admins / VPE who edit meeting meta
  can edit announcements.
- Helper text: *"Shown on the agenda and the present-mode slides. One per line."*

### 2. On-screen agenda display

`src/routes/club.$clubId.meeting.$meetingId.tsx`

- Where `theme` and `wordOfTheDay` are rendered in the meeting header, add an
  **Announcements callout** directly beneath the header and above the role list.
- Render as a labeled section ("Announcements") with each non-empty line as a
  bullet; preserve line breaks.
- Hidden entirely when `meeting.reminders` is empty/null (no empty section).
- Visible to all viewers (signed-in and guest) — no gating.

### 3. Printed one-page agenda

`src/components/agenda/meeting-agenda-print.tsx` +
`src/routes/club.$clubId_.meeting.$meetingId.print.tsx`

- Add an `announcements` field to the `AgendaHeader` type.
- Pass `meeting.reminders` from the print route into the header
  (alongside the existing `theme` / `wordOfTheDay` / `location`).
- Render an **"Announcements"** section in the one-page layout, styled with the
  existing print theme tokens (`print-theme.tsx`). Hidden when empty.

### 4. Present-mode slide (rename only)

`src/lib/agenda-slides.ts` / `src/components/agenda/meeting-present.tsx`

- Functionally unchanged — `buildSlideDeck` already emits the reminders slide
  from `meeting.reminders`.
- Update the slide's **visible title** from "Reminders" to "Announcements" for
  naming consistency. The slide `kind` string may stay `"reminders"` internally;
  only user-visible text changes.

## Error / edge handling

- Empty or whitespace-only input ⇒ stored as `null` (existing
  `updateMeetingMeta` behavior) ⇒ no section rendered on any surface.
- Long text: the textarea scrolls; agenda/print sections wrap naturally. No
  length cap beyond what the DB text column allows (none needed).
- No new failure modes — no new server fn, no new query, no migration.

## Testing

- `src/components/agenda/meeting-meta-dialog.test.tsx`
  - Submitting the dialog includes `reminders` in the `updateMeeting` payload.
  - Editing to empty submits empty (⇒ server normalizes to null).
- Agenda render test (route/component):
  - Announcements callout appears when `meeting.reminders` is present.
  - Callout is absent when `reminders` is null/empty.
  - Multi-line value renders each line as a separate item.
- `src/components/agenda/meeting-agenda-print.test.tsx`
  - Announcements section renders when present; hidden when empty.
- `src/lib/agenda-slides.test.ts` (or `meeting-present.test.tsx`)
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
| `src/components/agenda/meeting-meta-dialog.tsx` | Add Announcements textarea + form state + include `reminders` in update payload |
| `src/routes/club.$clubId.meeting.$meetingId.tsx` | Render Announcements callout under the header |
| `src/components/agenda/meeting-agenda-print.tsx` | Add `announcements` to `AgendaHeader`; render section |
| `src/routes/club.$clubId_.meeting.$meetingId.print.tsx` | Pass `meeting.reminders` into the print header |
| `src/lib/agenda-slides.ts` / `src/components/agenda/meeting-present.tsx` | Rename visible slide title "Reminders" → "Announcements" |
| Tests (4 files above) | Coverage for editor payload, agenda render, print render, slide title |
