# ADR-0014: Meeting minutes as a record over the meeting (attendance, Table Topics speakers, awards)

Status: Accepted

## Context

The app captures a meeting's **plan** — role slots (ADR-0005), speeches (ADR-0009), Word of the
Day, reminders — but nothing about what *actually happened*. A club secretary's **minutes** need
three things that live nowhere today (#152):

- **Attendance** — who was present. There is no attendance model at all; a member's only link to
  a meeting is a claimed role slot, and plenty of members attend without a role.
- **Table Topics speakers** — the impromptu responders. Only the *Table Topics Master* role
  exists; the people who actually spoke are unrecorded and are frequently guests.
- **Award winners** — Best Speaker / Best Evaluator / Best Table Topics ribbons, the classic
  payload of minutes.

ADR-0013 explicitly deferred "a guest attendance list for non-role guests" and "Table Topics
participation recording" to a later issue — this is that issue.

We also need to distribute the result as a **PDF**, and there is no PDF generation anywhere (the
present/print routes are HTML; `deck-to-pptx.ts` is the only document exporter).

## Decision

Model minutes as a **record over the existing `meetings` row** — no "minutes header" table — via
three child tables, and export it as a server-generated PDF.

- **No minutes header.** The `meetings` row *is* the header (date, theme, Word of the Day). A
  meeting has minutes iff it has any of the child rows below.
- **`meeting_attendance`** — `meeting_id` (cascade), an assignee that is a **member XOR guest**
  (`member_id` / `guest_id` nullable, DB check constraint enforcing at most one — the same
  invariant as `role_slots`), and a **presence enum** `present` / `absent` / `excused`
  (default `absent`). Members are enumerated from the active roster and default to `absent`,
  **pre-filled to `present` when they hold a role slot** on that meeting. Guests are added
  explicitly and stored `present` (a guest who didn't come simply isn't listed). Saved rows are a
  snapshot: they persist even if the member's roster status later changes.
- **`table_topics_speakers`** — `meeting_id` (cascade), member XOR guest, optional `topic` text,
  and an ordering column. An ordered list of who spoke, distinct from the Table Topics Master
  role definition.
- **`meeting_awards`** — `meeting_id` (cascade), an award-category enum
  (`best_speaker` / `best_evaluator` / `best_table_topics`), member XOR guest. All optional.
- **Guests reuse ADR-0013.** Added by picking an existing club guest (repeat visitors accumulate
  history) or creating a new `guests` row. The existing `guests` table already carries
  `name`/`email`/`phone`, so **no guest schema change** is needed. Guests holding a role slot are
  pre-listed as present.
- **Admin-authored, completion-gated visibility.** All minutes mutations gate on the club
  `admin` role (`requireClubRole(..., ["admin"])`), consistent with every other meeting/agenda
  mutation. Members see the minutes **read-only, and only once the meeting is `completed`**
  (ADR-0012). Admins always see the section, to fill it in. Minutes are editable **through and
  after** completion and are **not** subject to the ADR-0012 agenda lock — the secretary writes
  up TT speakers and awards after the gavel, without reopening the meeting.
- **PDF via `@react-pdf/renderer`.** A pure-JS, server-side renderer produces the minutes PDF as a
  buffer. Chosen over headless-Chrome (Puppeteer) because the runtime image is `node:22-slim` on
  Railway (ADR-0007) with a single Node server and no browser — pulling Chromium in would bloat
  the image and fight that model. `deck-to-pptx.ts` (pptxgenjs) is precedent for JS-based document
  generation. The PDF contains the meeting header, attendance (present/absent/excused counts +
  names + guests), Table Topics speakers + topics, awards, and a compact program section (roles +
  speeches, summary-level).

## Consequences

- **Attendance is now first-class**, opening later use (e.g. feeding the #8 VPE overdue view, or
  guest follow-up). This ADR only *records* attendance; analytics/trends are out of scope.
- A member's participation in a meeting can now be expressed two independent ways — a role slot
  (the plan) and an attendance row (what happened) — which the pre-fill reconciles but does not
  merge. They stay distinct records.
- **Emailing the PDF is a separate slice (#165):** it extends `sendEmail` (`src/lib/email.ts`)
  with Resend attachments and a recipient UI. The MVP (#152) ships capture + PDF **download** only.
- Out of scope (future issues): member-attendance analytics, guest→member promotion (still
  anticipated per ADR-0013), per-speaker Table Topics timing, and any scheduled/automatic sending.
