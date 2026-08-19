# ADR-0014: Meeting minutes as a record over the meeting (attendance, Table Topics speakers, awards)

Status: Accepted (where attendance is CAPTURED, and the role-slot pre-fill, are corrected by the
Amendment below — read it before trusting either)

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

## Amendment — attendance is recorded in the attendance panel, not the Minutes card (#548, v1.20.0.0)

Status: Accepted. Moves WHERE attendance is captured and drops one pre-fill rule. The three child
tables, the member-XOR-guest constraint, the completion-gated visibility of Table Topics speakers and
awards, and the `@react-pdf/renderer` export are all unchanged.

1. **One recorder, and it is not here.** The Minutes card's `AttendanceSection` / `GuestAdder` are
   deleted. Attendance — members and guests — is recorded in the officer's attendance panel beside
   the agenda, in its **roll** mode (`panelMode = phase === "upcoming" ? "plan" : "roll"`), which is
   where the officer already is on meeting day. An admin opening the Minutes card gets a one-line
   pointer to the panel; a member who cannot edit gets `AttendanceRecord`, a read-only view of the
   counts and every member's status. Two surfaces writing one row is how a club ends up present on
   one screen and absent on the other with the emailed PDF agreeing with neither, so
   `absorbed-surfaces.guard.test.ts` fails if `meeting-minutes.tsx` names `setAttendance`,
   `addMinutesGuest` or `removeMinutesGuest` again.

2. **A role slot no longer pre-fills `present`** (#218, before this release). The Decision above says
   members are "pre-filled to `present` when they hold a role slot"; `loadMinutes` does not do that
   and has not for some time — `status: saved?.status ?? null`, and `hasRole` rides along as
   information only. A member with no row is **unmarked**, a fourth state that is the ABSENCE of a
   record rather than a value of the enum, and treating it as `absent` is the specific bug #218
   closed: a meeting nobody took the roll at would otherwise report the whole club absent. Roll mode
   instead offers a DASHED suggestion derived from planned attendance (`coming → Present?`,
   `not_coming → Excused?`, `reached_out → nothing`) which writes nothing until it is tapped, and a
   row can carry a recorded status **or** a suggestion, never both — that mutual exclusion is what
   keeps a plan from reading as a record, which is what #548 was.

3. **The lock exemption is now load-bearing, not incidental.** "Editable through and after
   completion" used to matter mainly for Table Topics and awards. It now covers correcting a
   mis-marked member days after the gavel: `setAttendance` gates on `gateAdmin` and
   `assertAttendanceRecordable` (has the meeting DAY arrived) and on nothing else — it has never had a
   view of `meetings.status`,
   and the panel drops the lifecycle gate in roll mode alone (`writesLocked = roll ? false : locked`)
   so the replacement is not stricter than the recorder it absorbed. Plan mode still respects the
   lock. Reopen is not the correction route.

4. **A departed member still appears on a past meeting's roll.** The Decision's "saved rows are a
   snapshot" is now enforced on the read as well: `loadMinutes` returns the active roster **∪** any
   member with a saved row for that meeting, and `deriveRollRoster` appends the same rows on the
   client tagged `departed: true`. Such a row skips the contact affordance, and `departed` is a TAG
   rather than a `phone === null && email === null` check on purpose: an appended row carries neither,
   and `NudgeButtons`' "No contact on file" copy is useful advice for an ACTIVE member (go add a
   number) and noise for someone who has left, which a null-check at the render site cannot tell
   apart. Marked present in March and gone in April, they are still in March's counts, which is what
   the PDF and the emailed minutes have always printed.

5. **Writes go through the offline queue, not straight to the server.** Roll call happens in halls
   with bad wifi, so every roll write is queued on the device and drained on reconnect. See
   ADR-0015's amendment for that mechanism and its invariants; the one that matters here is that the
   queue is the ONLY channel while a queue exists, so a new attendance write wired past
   `useOfflineMinutes` loses ordering and the write deadline silently.
