# CONTEXT.md — tm-scheduler

A mobile-first web app for scheduling Toastmasters club meetings. Members claim meeting
roles from their phone in one tap; a VP Education / admin creates meetings, which auto-
generate the roles to be filled. It replaces a shared spreadsheet, whose real failings were
no reminders, no at-a-glance "what's still open," and edit conflicts.

## Glossary

Use these exact terms in issues, ADRs, tests, and code. They map Toastmasters vocabulary to
the nouns in `src/db/schema.ts`.

- **Club** — a Toastmasters club (`clubs`). A person can belong to several (see ADR-0006). A club
  can be **soft-archived** by a superadmin (`clubs.archived_at`; NULL = active): a reversible flag
  that blocks all reads — authed writes (`requireMembership`), authed reads (`grantView`, behind
  `requireClubViewAccess` / `requireClubAdminView`, which do NOT route through `requireMembership`
  — #560) and public (every session-less reader gates itself; see **Invariants**) — except the
  superadmin console, retaining every row and keeping the slug reserved. `isClubArchived`
  (`src/lib/club-archive.ts`) carries the canonical list of enforcement points; this entry said
  there was one until #560, which is how the read gates came to be missed. Archiving is the platform **takedown** lever: it is how a club, and
  with it the club's own name, roster and uploaded logo, comes off GavelUp (ADR-0024). Writes are
  not yet blocked (#555). See ADR-0016 / #186 / #544.
- **Club logo** — one image a club uploads for itself (`club_logos`; at most one row per club,
  bytes stored inline as `bytea`). PNG or JPEG, ≤256 KB **and** ≤2000px on each side — the pixel
  cap bounds DECODE cost, which the byte cap does not, and it matters because the role-sheet PDF
  decodes the image server-side on a public endpoint. Rendered on the four print layouts, the
  projected deck, the `.pptx` export, the Word of the Day poster and the club role sheets (HTML
  and PDF); a club with no logo sees every surface exactly as before. GavelUp supplies no image
  of its own and never shares one club's upload with another — see ADR-0024 and **Invariants**.
  Shipped #495 (print), extended to the remaining surfaces #496.
- **Person** — a human (`people`), keyed by their Toastmasters Customer ID (`PN-…`, nullable;
  unique when present, with email as a fallback match key). Holds the facts that are the same
  across *every* club a person belongs to: name, contact, `original_join_date` (first-ever TM
  join), `preferred_name` (what they go by — see **Goes-by name**), enrolled Pathways paths, and
  the optional link to their sign-in account (`user_id`).
  `user_id` is **not unique**: one account can link several Person rows (duplicates predate the
  #329 dedupe-on-write and are merged by hand), so resolving a signed-in user to a Person is a
  deliberate choice, not a lookup — see **Invariants**. See ADR-0008 / #64.
- **Membership** — a Person's participation in one Club (`members`; one row per person per
  club). Holds the *per-club* facts: role (`club_role` — `admin`/`vpe`/`member`; only
  `admin`/`vpe` may create meetings), `joined_at` ("member of *this* club since"), office
  (see #63), and status. This roster row is what meeting roles are claimed against. See
  ADR-0008.
- **Goes-by name** (`preferred_name`, #486) — what a human is actually CALLED, when it isn't the
  first token of their stored `name`. Every intake path gives one full-name string (the
  Toastmasters export has a single `Name` column, in both "First Last" and "Last, First" shapes),
  so "Abdul-Rasheed Bustamam" who goes by Rasheed cannot be greeted right by splitting. Nullable
  on `people`, `members` and `guests`. The **membership is authoritative for its club**; the
  read is `coalesce(members.preferred_name, people.preferred_name)`, so a value recorded in one
  club follows the human into the next unless that club records its own. Replication upward is
  one-way and NULL-guarded (a membership edit seeds the Person only when the Person has none);
  clearing a membership's value also clears the Person copy it seeded, or the coalesce would
  resurrect it. Resolved for display by `greetingName` (`#/lib/person-name`), which falls back to
  the first token. Used only to address people in nudge drafts — never as a display name.
- **Guest** — a club-scoped visitor (`guests`) who can be assigned to a role slot as an
  alternative to a member (real case: a visitor served as evaluator). A lightweight, durable
  identity (name + optional contact), **not** a Person and **not** a Membership: no login, no
  Pathways, no roster/officer presence, and NOT a `members` status. A slot references at most one
  assignee — a member (`assigned_member_id`) OR a guest (`assigned_guest_id`), never both
  (enforced in logic + a DB check constraint). Guests never appear in the member roster/picker;
  guest-held slots render the name with a subtle "· Guest" marker and count as filled. Admin-only
  to assign (not on the public/TMOD view). A guest also carries a pipeline `stage` and, once
  promoted, a `converted_membership_id` — see **Guest pipeline**. See ADR-0013 / #151.
- **Guest pipeline** — the VP-Membership funnel over the `guests` entity (ADR-0018 / #208):
  **capture → stage-tracked prospect list → convert-to-member**. A guest's **stage**
  (`guest_stage` enum) is `prospect → following_up → joined → lost`: new guests default
  `prospect`, `following_up`/`lost` are manual admin transitions, and `joined` is set **only**
  by convert-to-member (alongside `converted_membership_id`). Each guest's **visit count** and
  **first-visit date** are *derived* from `meeting_attendance` (never a stored counter). The
  admin pipeline view lives at `/admin/vp-membership`; the assign-guest picker excludes `joined`
  and `lost` guests (`stage in (prospect, following_up)`).
- **Guest book** — the public, no-auth capture front door (ADR-0018, absorbing #239):
  `/club/:clubId/guest-book`, escaping the member-identity shell. A visitor self-enters
  name + optional email/phone; the server **creates-or-finds** the guest (dedup club-scoped, by
  email, then by phone whose stored name AGREES — `namesAgree`, since a household sharing a
  number is two prospects; phone normalized to E.164 digits on both sides).
  A `meeting_attendance` visit is recorded **only while a meeting is in progress** — an
  ABSOLUTE-time window, `[scheduledAt − 90 min, end + 60 min]` (`isAtMeetingNow` /
  `GUEST_BOOK_GRACE_*`, `src/lib/guest-book-window.ts`), never a club-local calendar-day compare.
  Signing outside the window (or with no meeting at all) still creates the guest at `prospect`,
  so the VP Membership sees the prospect; there is simply no visit to count until they turn up.
  **Attendance means "was in the room"** — the row reaches the meeting's official minutes, which
  read `meeting_attendance` with no date gate. See ADR-0018's amendment / #319.
  **Two front doors:** a **stable per-club QR** on the VP-Membership view (printable table-tent),
  and the "Planning a visit?" invitation on the public club page (#319), which is hidden from
  anyone who already has a club identity — signed-in **or** anonymous roster pick. The QR never
  needs regenerating because the route resolves the current meeting itself.
- **Convert-to-member** — the admin action that promotes a guest into a Membership (ADR-0018):
  dedup/link the Person (phone → email), create the club Membership (`clubRole: member`,
  `joinedAt` today) or reuse the person's existing one, re-point the guest's role-slot
  assignments to the new member, stamp the guest `stage: joined` + `converted_membership_id`
  (the guest row persists as history — its past attendance stays), and log `member_add`.
- **`club_memberships`** — legacy auth-only link (signed-in `user` ↔ club) that today still
  resolves `club_role` in the auth path; being absorbed into Membership (ADR-0008, follow-up
  to #64). Not the roster.
- **Officer position** — a Person's elected club job on a Membership, drawn from the standard
  Toastmasters club officers: President, VP Education, VP Membership, VP Public Relations,
  Secretary, Treasurer, Sergeant at Arms, Immediate Past President. A structured enum
  (`src/lib/officers.ts`) replacing the old free-text `office`; in-app editing is authoritative
  (CSV import only fills empties). Distinct from `club_role` (permission) — though President /
  VP Education *default* a linked account to `admin`. See #63.
- **Officer term** (`officer_terms`) — the source of truth for who holds which office (#100):
  one row per office a Membership holds, over a span (`term_start` … `term_end`). A Membership's
  **current office(s)** are DERIVED as its open terms (`term_end IS NULL`) — it may hold several
  concurrently (e.g. Secretary + Treasurer). Removing an office closes its term (sets `term_end`),
  retaining it as history (officer recognition / term reporting); rows are never deleted on
  removal. Replaced the single `members.officer_position` column. See #100.
- **`club_role`** — the app **permission** on a Membership: `admin` (may create/edit meetings,
  manage roster/roles) or `member`. Bound to the sign-in account, enforceable independent of
  roster metadata; defaulted from Officer position but stored explicitly (ADR-0008). (`vpe`
  was a third value that behaved identically to `admin`; it collapses into `admin`.)
- **Superadmin** — a **platform-level** capability (`user.is_superadmin`), ORTHOGONAL to `club_role`
  and layered on top of club membership (a superadmin still earns per-club admin rights the normal
  way). Provisioned, not self-serve: reconciled two-way from the `SUPERADMIN_EMAILS` env allowlist
  (case-insensitive) on every sign-in — adding an email grants on next sign-in, removing it revokes;
  unset ⇒ nobody (fail closed). Enforced by `requireSuperadmin` (a separate guard — it does NOT
  bypass `requireClubRole`; no ambient cross-club access). Surfaced by `getAuthContext.isSuperadmin`.
  See ADR-0016 / #183. (Console UI #182, impersonation #185.)
- **Impersonation session** (`impersonation_sessions`) — a superadmin's time-bounded, single-club
  grant to a club they aren't a member of (ADR-0020 / #185, #246). The durable audit record of
  cross-club access, and the ONLY thing that grants such access. Not ambient: no active session ⇒
  no access. Starting one forces the club active in `getAuthContext` (rendering a persistent
  banner) and writes a start entry to the club's activity feed. Two `mode`s:
  - **`read_only`** — "View as this club" (60-min TTL). Consulted only by the read-access guards
    (`requireClubViewAccess` / `requireClubAdminView`, used by GET server fns); the mutating guards
    resolve real memberships only, so read-only holds **by construction** — a superadmin with an
    active read-only session passes the read guards but still fails `requireClubRole` /
    `requireMembership`. Start logs `superadmin_viewed`.
  - **`read_write`** — "Act as admin" (#246; 15-min TTL, a required `reason`). The **deliberate
    inversion**: the mutating guards ALSO honor an active read-write session as a **memberless
    effective-admin** (`requireMembership` / `requireClubRole` return a synthetic admin with `id:
    null`; no roster row is created), so the superadmin can do anything a club admin can. Every
    write is attributed to the real superadmin via `activity_log.impersonated_by` (with
    `actor_member_id` null), stamped by `logActivity` from a request-scoped marker the guards set.
    Start logs `superadmin_acted` with the reason. The banner turns danger-styled ("changes are
    live").
- **Provisioned onboarding** — a new club is created only by a **superadmin** through the
  console (`/superadmin`, #182), never self-serve: one atomic transaction writes the club (unique
  number + derived slug) + the 9 standard role definitions + a first admin (a Person with
  `user_id` NULL and an `admin` Membership); the admin's account links on their first sign-in
  (#188), and their email is editable in the console only while still unclaimed. See ADR-0016.
- **Dues period** — a club-defined membership-billing window (`dues_periods`): a `label`, a
  `due_date`, and an optional `default_amount_cents`. Periods are DATA, not a hardcoded cadence,
  because clubs bill differently (annual, semi-annual, custom); the default is semi-annual with the
  Toastmasters Apr 1 / Oct 1 renewal presets one click away. The **active** period (the Treasurer
  view's default) is the one whose window — its own `due_date` up to the next period's — contains
  today, else the nearest upcoming. Managed by the Treasurer (a club `admin`). See ADR-0017 / #206.
- **Dues status** — a member's payment state for a period (`member_dues`, keyed on
  `(membership_id, dues_period_id)`): `paid` or `waived`. **Unpaid is the ABSENCE of a row** — the
  table is never pre-seeded, so a member owes a period exactly when they have no `paid`/`waived`
  row for it. A **full-year** pre-payment is two `paid` rows (this period + the next) sharing one
  `paid_at`. **Overdue** = an active member owing a period whose `due_date` has passed (full-year
  payers are excluded for free). Amounts are integer cents, optional. Deliberately DECOUPLED from
  Membership `status`: no dues action ever changes roster/renewal state. See ADR-0017 / #206.
- **Meeting** — a single club session (`meetings`) with a date, theme, and word of the day.
  Its `status` follows a lifecycle: `scheduled → completed` (admin **Complete**, only on/after
  the meeting date) and `completed → scheduled` (admin **Reopen**, any time). A **completed**
  meeting is **locked** — read-only, every agenda mutation is rejected server-side and shows a
  "This meeting is locked." banner. Speech-delivered stays date-derived (ADR-0009). Completing a
  meeting also force-closes any open **Digital vote** session (#510). See ADR-0012.
- **Meeting phase** — a *separate axis* from `status`, and UI-only: `upcoming` / `today` /
  `completed` (`meetingPhase`, `src/lib/meeting-lifecycle.ts`, #541), at club-local day
  granularity. It re-weights the meeting view's chrome — which action is primary — and never
  grants or removes a SERVER-side capability. What it does do is SWITCH one surface's job. The
  officer's attendance panel is one component in every phase but not one tool:
  `panelMode = phase === "upcoming" ? "plan" : "roll"` is the only place that choice is made (one
  expression in `club.$clubId.meeting.$meetingId.tsx`, pinned by
  `attendance-panel-wiring.guard.test.ts`), so phase `upcoming` writes RUNGS
  (`meeting_attendance_plan`) while `today` and `completed` write the RECORD (`meeting_attendance`)
  — see **Attendance / Presence**. Phase still gates the plan half outright
  (`showPlanPanel = runsThisMeeting && phase === "upcoming"`, v1.15.0.0): there is no rung-writing UI
  on meeting day even though `setPlannedAttendance` still accepts the write. Before v1.20.0.0 that
  left the later phases with no panel at all. The overlap is deliberate but confusing: a meeting
  whose day has passed that nobody pressed **Complete** on is phase `completed` while its
  status is still `scheduled`, unlocked, and an admin may still edit it. Phase `completed` ≠ locked.
- **Role definition** — a club's template for a fillable role (`role_definitions`), e.g.
  Toastmaster of the Day (TMOD), Speaker, Evaluator, Table Topics Master, General Evaluator
  (GE), Timer, Ah-Counter, Grammarian, Vote Counter. Carries `default_count`, `sort_order`, and
  `enabled` — false means new meetings generate no slot for it (a "skeleton crew" club retiring
  a role it doesn't run); already-generated slots are untouched. See #368.
- **Role name vs role key** — a club renames any role freely (`role_definitions.name`, via
  `updateClubRole`); identity lives in `role_definitions.key`, the immutable snake_case handle
  for one of the 9 standard roles (`ROLE_TEMPLATE`), NULL for a club-invented one. Agenda beats
  bind to roles by `key` (`matchesRole`), so a rename never breaks the binding — and every
  surface DISPLAYS the club's own `name`: the roster, the projected legend, and every row of the
  printed run sheet. Our canonical name survives in one spot only, a beat for a role the club
  runs none of, where there is no club name to read. **Three roles' PERMISSIONS key off it too** —
  the TMOD's self-serve agenda editing and planned-attendance panel (ADR-0010 / #576), the
  Grammarian's Word-of-the-Day edit (#296),
  and the Vote Counter's control of the digital ballot (#510, see **Digital vote**) — so a rename
  never moves a capability and a club-invented role that merely *sounds* like one never gains it.
  See #367 / #368 / #445 / #464 / #510.
- **Role slot** — one concrete, claimable agenda row for a meeting (`role_slots`). Generated
  from role definitions when a meeting is created. THE source of truth and history — see
  ADR-0005. A slot is `open`, `claimed`, or `confirmed`.
- **Claim / release** — a member takes (`claimSlot`) or gives up (`releaseSlot`) a slot.
  Claiming a speaker slot captures a **Speech** (or leaves it TBA to attach later).
- **Speech** — a prepared speech a **Person** owns (`speeches`): title, optional introduction,
  Pathways path/project/level, and min/max minutes. Durable and independent of the schedule —
  a speaker slot *references* one via nullable `role_slots.speech_id` rather than embedding it,
  so reassigning or rescheduling a slot never destroys the speech. Person-owned and *club-less*
  (a delivery's club comes from the slot it's attached to). Replaces the old slot-bound
  `speaker_details`. Scheduling state (unscheduled / scheduled / delivered) is **derived** from
  slot linkage, not stored. See ADR-0009 / #79.
- **Minutes** — the post-meeting *record of what actually happened*, distinct from the agenda
  (the plan). Not its own table: the `meetings` row is the header, and the record is the three
  child sets below (attendance, Table Topics speakers, awards). Admin-authored on the meeting
  view; members see it read-only, and only once the meeting is `completed`. Editable through and
  after completion — **not** covered by the ADR-0012 lock. Exportable as a PDF. See ADR-0014 / #152.
  One of the three is no longer authored HERE: since v1.20.0.0 attendance is recorded in the
  attendance panel's roll mode, and the Minutes card holds no attendance control at all — an admin
  gets a one-line pointer to the panel, and a member who cannot edit gets `AttendanceRecord`, the
  read-only counts plus every member's status. Two recorders for one row is how a club ends up
  present on one screen and absent on another; `absorbed-surfaces.guard.test.ts` fails if
  `meeting-minutes.tsx` names `setAttendance`, `addMinutesGuest` or `removeMinutesGuest` again.
- **Attendance / Presence** — per-meeting record of who was there (`meeting_attendance`), the
  RECORD half of the plan-vs-record boundary in **Planned attendance** below. A member's presence
  status is `present` / `absent` / `excused`; the column defaults `absent`, but **no row at all is
  the fourth state — "unmarked"** (#218), and a role slot never infers presence (`hasRole` on the
  payload is informational only; the "pre-filled to `present` for anyone holding a role slot" rule
  this entry used to state was removed). **Guests** present are added to the same record (present by
  definition — no absent/excused). Rows reference a member **or** a guest, never both (XOR check
  constraint, like `role_slots`). See ADR-0014 and its v1.20.0.0 amendment.
  **Where it is taken:** the officer's attendance panel in **roll** mode, from phase `today`
  onward, by a signed-in club `admin` or a read-write impersonation session
  (`showRollPanel = effectiveCanManage && minutes.canEdit`) — note the TMOD arm that reaches plan
  mode does NOT reach roll, since `showRollPanel` is deliberately not built on `runsThisMeeting`.
  `buildRollPanel` (`src/lib/roll-panel.ts`) is the derivation, a SIBLING of `buildPlanPanel` rather
  than a flag inside it, and rows sort alphabetically because a register is read down and plan
  mode's chase-worthy-first order would reorder the list under the officer's finger.
  Three properties are worth knowing before touching it. A row carries a recorded `status`
  **or** a dashed `suggestion`, never both — `coming → Present?`, `not_coming → Excused?`,
  `reached_out → nothing` — which is what makes a plan physically unmistakable for a record (the
  guard against #548); a suggestion writes nothing and counts as `unmarked` until it is tapped.
  Roll mode deliberately IGNORES the completed-meeting lock (`writesLocked = roll ? false : locked`)
  because correcting a mis-marked member days later is a normal club task and Reopen would otherwise
  be the only route; the server never gated on `status` either — `setAttendance` checks the club
  `admin` role and `assertAttendanceRecordable` (has the meeting DAY arrived), and nothing more.
  And a member who has since LEFT the roster still appears, twice over: `loadMinutes` returns the
  active roster ∪ any member with a saved row, and `deriveRollRoster` appends the same rows
  client-side tagged `departed: true` (they skip the contact affordance — a `departed` row carries no
  phone or email, and "No contact on file" is advice for an ACTIVE member and noise for someone who
  has gone, which a null-check at the render site cannot tell apart).
  Three more things about roll mode are easy to miss. **Guests are added and removed here too**
  (`AttendanceGuestsGroup`), picked from the club's own guest list with the ones already present
  filtered out, so a repeat visitor stays one `guests` row instead of three; their add/remove ride the
  same queue ops as a member's status. **Contact affordances vanish for EVERY roll row once the phase
  is `completed`** (`hideContact = roll && phaseCompleted`), which is a different rule from the
  `departed` tag — nobody is being chased about a meeting that is over. And **the message copy
  changes**: on meeting day a row's nudge uses a fourth `NudgeMode`, `arriving` — "we've started our
  `<date>` meeting, are you on your way?" — because asking whether someone *can* make a meeting that
  has already begun is the wrong question. That copy reaches a member and is in no other doc.
  What a MEMBER is told about their own attendance reads this record, never their plan — that
  confusion was #548. `MeetingPersonalStrip`'s `myAttendance` is three-valued on purpose:
  a status gives one of three sentences (including "You were excused from this meeting."), `null`
  means a session exists and nobody recorded a row, and `undefined` means there is no session to
  resolve "my" against. Both of the last two render NOTHING, because guessing was the bug.
  Separately, roll writes go through the **Offline write queue** below
  — the panel is used standing up in a hall, so the queue, not the server, is the write channel.
- **Planned attendance** — where the outreach for an UPCOMING meeting got to, one row per
  (member, meeting) in `meeting_attendance_plan` carrying `reached_out` | `coming` |
  `not_coming`. **Row absent = "no answer"**; there is no fourth value, because a row meaning
  "nothing is known" is one every reader has to remember to ignore. Deliberately NOT
  **Attendance / Presence** above: that is the RECORD written after the meeting, and a plan must
  never be storable as a record. It replaced two presence-means-true tables
  (`member_availability`, `meeting_outreach`) that answered overlapping questions, could
  disagree, and between them could not express "she replied, she's coming" — so `not_coming` is
  now the ONLY encoding of unavailable, and row presence answers nothing. Consequence for
  readers: filter on the STATUS, never on the row existing. `reached_out` is the private record
  of having asked, kept from MEMBERS rather than from everyone who runs the meeting; `coming` and
  `not_coming` are the member's own answer and are self-serve. All three rungs are STORED values;
  since v1.19.0.0 the officer's rail also DERIVES one, and the two must not be confused.
  `buildPlanPanel` (`src/lib/attendance-panel.ts`) resolves a DISPLAY status per member: an
  explicit `coming` / `not_coming` wins, because their own word outranks anything inferred; else a
  **confirmed role slot** on this meeting reads as `coming` with the row flagged `assumed`; else
  the stored `reached_out`, else nothing. It writes NOTHING — the table still has no row, and the
  seam's readers (`listComingForMeeting`, `listPlanForMeetings`) still report stored rungs only, so
  the rail's coming COUNT is deliberately a superset of theirs and a second consumer of "who is
  coming" has to decide which of the two it means. Two properties hold it together. A derived
  Coming must never render identically to an answered one, which is what `assumed` carries to the
  row; and ranking a confirmed slot ABOVE `reached_out` is load-bearing rather than cosmetic — a
  confirmed member has no plan row, so messaging them inserts `reached_out`, and ranked the other
  way an officer would watch the Toastmaster they just confirmed fall from Coming back to Asked.
  On the meeting payload that boundary is
  TWO arrays rather than one filtered at each consumer: `plan` (the whole ladder,
  admin-only) feeds the attendance panel, and `answeredRungs` (`coming` / `not_coming` only,
  public) is what the personal strip reads to show a member their OWN answer. The server cannot
  resolve "my" — the viewer is known only on the client, since the anonymous roster pick is the
  dominant identity here — so the public array must never carry `reached_out` in the first place
  (v1.15.0.0). The meeting's Toastmaster reads the same ladder through a THIRD path (#576):
  not the payload, but `getTmodPanelData`, which verifies a self-asserted member id against the
  meeting's TMOD slot. Deliberately separate, because widening the payload's `canManage` gate to
  accept a client claim would put the private rung behind a forgeable flag on the array every
  anonymous visitor already receives. That reader splits its two halves by TRUST: the ladder and
  member NAMES ride the self-asserted claim (names are already public), but phone and email need a
  real SESSION whose own membership is the Toastmaster. The claim is not a secret — the id ships
  as `assigneeId` on the public payload and the roster picker hands any visitor any id — so an
  anonymous Toastmaster plans attendance with the drafts dark and signs in to message. See
  `getPublicMeetingByKey`: "The soft honor-system gate on `/club/:clubId` must never carry PII." Reached
  through one seam (`src/server/attendance-plan-logic.ts`), which owns actor attribution and the
  predicates that stop one rung overwriting another — but NOT the archive gate or the write
  ladder, which live in the callers. See the 2026-08-11 spec.
  Since v1.20.0.0 the same panel has a second mode that writes the RECORD instead
  (**Attendance / Presence** above), so the plan now has a consumer downstream of itself: a rung is
  what roll mode SUGGESTS on meeting day. Two things not to assume about that. The seam is
  untouched by roll mode (`attendance-plan-logic.ts` has zero changes in v1.20.0.0), and the
  DERIVED `assumed` Coming does **not** reach it — `buildRollPanel` reads the raw rungs, so a
  confirmed role-holder who never replied reads `Coming · assumed` in the rail on Monday and gets
  **no** dashed `Present?` on Wednesday. That divergence is deliberate-for-now rather than settled
  (it appeared when v1.19.0.0 merged into the roll branch, and neither side's tests could see it);
  it is documented at the derivation site and filed P1 in `TODOS.md`.
- **Table Topics speaker** — an impromptu participant who answered a Table Topic
  (`table_topics_speakers`), captured as an ordered list of member-or-guest (XOR) + optional
  topic text. Distinct from the **Table Topics Master** role (the role definition that runs the
  segment). See ADR-0014.
- **Award** — a meeting's ribbon winner (`meeting_awards`): Best Speaker, Best Evaluator, or Best
  Table Topics, each an optional member-or-guest (XOR). Set directly by an admin, or confirmed by
  the Ballot Counter from a **Digital vote**. See ADR-0014.
- **Digital vote** — the QR-reachable public ballot (#510) for Best Speaker, Best Evaluator and
  Best Table Topics, run by whoever holds the meeting's **Vote Counter** slot (the "Ballot
  Counter" in the UI — the third capability role, see **Role name vs role key**). A **vote
  session** (`meeting_vote_sessions`, one row per `(meeting, category)`) is the open/close window:
  `closed_at IS NULL` means open, and re-opening a closed vote clears it on the same row rather
  than inserting a second one. A **ballot** (`meeting_votes`) is one vote per voter per category —
  member-or-guest voter XOR, member-or-guest candidate XOR — enforced by a pair of plain
  (non-partial) unique indexes, so re-voting inside an open window upserts the pick instead of
  duplicating. The Ballot Counter alone sees the running count; everyone else sees only that a
  vote is open. Nothing writes `meeting_awards` automatically — the Ballot Counter taps the winner
  in, the same table the minutes and printed awards beat already read. Completing a meeting
  force-closes any open vote session. A guest may vote only after joining THIS meeting's ballot
  (`meeting_ballot_guests`, a `(meeting_id, guest_id)` link) — a guest id from any other surface
  (the guest book, an officer's manual add) is not itself a ballot identity, which is what bounds
  the public per-meeting guest cap to actual ballot joins rather than `guests` row inserts.
  Reached from a QR on the present-mode vote slides and all four printed agenda layouts, or
  directly at `/club/:clubId/meeting/:key/vote`. See
  `docs/superpowers/specs/2026-08-08-digital-voting-design.md`.
- **Offline write queue** — the single write channel for a meeting's minutes record (attendance,
  Table Topics speakers, awards) on the venue wifi this product actually runs on (#176; hardened and
  made load-bearing by roll call in v1.20.0.0). One IndexedDB store
  (`src/lib/offline-minutes-queue.ts`: DB `gavelup-offline`, object store `minutes-kv`) holds two
  keys per meeting — `queue:<meetingId>`, an ordered array of `MinutesOp`s (eight variants, one per
  minutes mutation), and `snapshot:<meetingId>`, the last server state seen. What every surface
  RENDERS is `projectMinutes` (`src/lib/project-minutes.ts`): the snapshot (or the live payload when
  online) with the queue replayed over it by `deriveMinutes`, so the panel and the Minutes card
  cannot disagree about a queued tap. `projectMinutes` keeps a ONE-ENTRY memo in module-level
  mutable state, keyed on the reference identity of all four inputs — the four same-render callers
  would otherwise pay four `structuredClone`s of the snapshot per tap. Deliberate impurity in a
  `lib/` module, and safe on the server for a stated reason rather than by luck: `minutes`, `snapshot`
  and `queue` are all per-request objects, so two requests cannot key alike. The projection replays
  **even when online**, because a write abandoned at its deadline queues with `navigator.onLine`
  still true. Five properties hold it together, and all
  but the drain's ordering were written after something went wrong without them. **While a queue
  exists the queue is the only channel**
  (`if (!online || queue.length > 0) queueOp(...)`, `src/hooks/use-offline-minutes.ts`) — otherwise a
  direct write races a queued one for the same member and the OLDER answer wins on reconnect.
  **Every write has a deadline** (`ONLINE_WRITE_TIMEOUT_MS`, `src/lib/offline-write-deadline.ts`),
  applied to the online write and to each drain dispatch, because `navigator.onLine` is TRUE for a
  phone associated to an access point that routes nowhere; without it a tap hung forever with every
  control disabled and no message. Nothing is ABORTED at the deadline, so **every op must converge
  on replay** — which is why `moveTableTopics` carries an absolute destination (`toIndex`) as well as
  its relative `direction`. `toIndex` is optional only for ops already sitting in a device's
  IndexedDB from before it existed, which keep the old relative semantics; it is the one op field
  whose absence is a correctness hazard rather than a back-compat nicety, so every op minted now
  carries it.
  **The drain stops at the first failure** (`drainMinutesQueue`, `src/lib/drain-minutes.ts`) and
  leaves that op and every successor queued in order; there is no per-op retry, and retrying is the
  caller's job (automatic on reconnect, or the indicator's Retry). And **one `useOfflineMinutes` per
  meeting** — two instances own separate `draining` flags over one read-modify-write IndexedDB key,
  so `use-offline-minutes-instance.guard.test.ts` pins the caller set rather than trusting the
  optional `offline` prop. `SyncStatus` (`src/components/club/sync-status.tsx`) is what the officer
  sees: syncing, a pending count, an assertive error with a Retry, or nothing. Offline **auth** is
  still not built — see ADR-0015's amendment for what that ADR now gets wrong.
- **Pathways** — Toastmasters' education program. A **path** (e.g. *Presentation Mastery*) is
  enrolled and owned by a **Person**, independent of any club; a person may work several paths
  at once. When a path **level** is completed, the credit is attributed to *one* of the
  person's clubs — the only club-scoped Pathways concept. Base Camp exposes neither the
  completion date nor the crediting club, so both are **inferred at sync time** and stored
  write-once on `path_level_progress` as `completed_at` (first sync that witnessed `approved`
  flip false→true) and `credited_club_id` (the syncing club; first-syncer-wins). Both are null
  for levels already approved before we ever synced the enrollment — an *observed* completion,
  not a Base Camp mirror field. Consumed by DCP education-goal derivation (#245). See ADR-0022.
  A speaker's project belongs to a path.
- **Evaluator → speaker link** — an evaluator slot points at the speaker slot it evaluates
  via `role_slots.evaluates_slot_id` (self-reference).
- **Distinguished Club Program (DCP)** — Toastmasters International's annual club-recognition
  program: 10 standardized goals across a **program year** (Jul 1 – Jun 30). Recognition tiers
  are **Distinguished** (5 goals), **Select Distinguished** (7), **President's Distinguished**
  (9), each also requiring the **membership base** (≥20 active members OR net growth of +5). The
  President owns the club's progress. In GavelUp it's a **President-owned scoreboard** — every
  goal is hand-entered, with roster and Pathways assists offered as editable suggestions rather
  than applied automatically. The goal catalog (labels + targets) is static code
  (`src/lib/dcp.ts`); only per-club progress is stored, and the tier/base are DERIVED, never
  stored. See ADR-0019 / #207, and #245 for the education assist.
- **Program year** — the Toastmasters year, Jul 1 – Jun 30, keyed by its **starting calendar
  year** (e.g. 2026 = Jul 1 2026 – Jun 30 2027).
- **DCP scoreboard** (`dcp_scoreboards`) — a club's DCP record for one program year: the parent
  row holding the auto-snapshotted, President-editable `base_member_count` (for the net-+5 base
  test). **DCP goal progress** (`dcp_goal_progress`) is one hand-entered `achieved` value per
  catalog goal (`met = achieved ≥ target`; composite goals 9 & 10 are a 0/1 toggle). The two
  new-member goals are roster-derived (pre-filled at start from `members.joined_at` in the
  program-year window); the six education goals carry a live Pathways **suggestion** the
  President reviews and applies (#245). Stored progress remains the only thing that scores —
  a suggestion counts toward nothing until applied.
- **Education award** — the atomic unit the DCP education goals count: **one approved Pathways
  level, credited to this club, completed inside the program year**. Counted per completion,
  NOT per member — one person finishing the same level in two paths is two enrollments and so
  two awards. Levels whose `completed_at` is null (approved before this club first synced) are
  excluded and need entering by hand. Awards map onto goals as n(L1)→g1, n(L2)→g2/g3 (cap 2
  each), n(L3)→g4, n(L4)+n(L5)→g5/g6 (cap 1 each); "a Path" in the goal 5/6 wording ≡ Level 5,
  as the count-based mirror carries no separate path-complete signal. See #245 / ADR-0022.

**Meeting template** — a named bundle of a role set plus a flat run-of-show, letting a meeting
run a shape other than the club's standard night (today: **Speech Contest**).
`meetings.template_id` NULL is the standard meeting and reads the code-derived `RUN_OF_SHOW`;
a templated meeting reads `meeting_template_beats` through `resolveAgendaRows`, which builds
`AgendaRow[]` **directly** rather than going through `Beat` / `expandRunSheet` — `Beat` exists
to GATE on which roles a club runs and to FAN OUT one beat across a role's slots, and a
template needs neither.

A template's roles are COPIED into `role_definitions` with `template_id` set, because
`role_slots.role_definition_id` is NOT NULL and restricting, so a claimable contest role has to
be a real row. Copy-once: a later seed edit does not reach a club that already used the
template, exactly as editing `ROLE_TEMPLATE` never reaches an existing club.
`scripts/resync-template-roles.ts` is the deliberate escape hatch.

**SEVEN readers select role definitions by club, and every one is choosing a slot source** —
`role-definitions-logic`, `meetings-logic`, `batch-meetings-logic`, `schedule-topup-logic`,
`slots-logic` (twice) and `meetings.ts`'s "+ Add role" picker. They share `roleDefScope`.
Leave any unscoped and every standard meeting created after a club runs one contest gains that
contest's roles, because `generateSlotRows` filters on `enabled`, not `template_id`. The two
club-scoped bulk syncs additionally EXCLUDE templated meetings from their meeting sets.

Templates are GLOBAL (`meeting_templates.club_id IS NULL`) in Phase 1; club-authored ones and
the editor are Phase 2. See `docs/superpowers/specs/2026-08-19-agenda-templates-design.md`.

## Scope

**MVP (built):** magic-link auth, schedule view, meeting detail with one-tap claim, speaker-
detail capture, `/me` commitments with release, admin meeting creation with slot generation,
seed data.

**Out of scope (schema must not block, but build no logic):** swap matching, role-rotation
fairness, Pathways progress dashboards, calendar export. These are the later phases.

**Reminders are fully built.** The `notifications` table is drained by an in-process poller
(#271 / ADR-0023), the role-assignment producer enqueues rows (#272), and the control layer —
per-Person opt-out, the no-auth `/unsubscribe` link, and per-club settings — ships alongside it
(#274, `notification-prefs-logic.ts`). Multi-club switching is built too (`club-switcher.tsx`).

## Invariants

- A slot moves to `claimed` only via a conditional update guarding against double-claims
  (ADR-0005). Never set `assigned_user_id` without that guard.
- Only an active member of a meeting's club may claim its slots; only the assignee or a
  club `admin`/`vpe` may release.
- A meeting's **agenda content** — meta (theme, Word of the Day, notes, location) and slot
  assignment / count — may be edited by a club `admin`/`vpe` **or** by the self-asserted
  member holding that meeting's Toastmaster (TMOD) slot. **Reschedule, cancel, and status
  stay `admin`/`vpe`-only.** TMOD self-serve editing is an interim self-assert measure pending
  real auth (ADR-0010).
- A meeting's **Word of the Day** alone may also be edited by the self-asserted member holding
  that meeting's **Grammarian** slot — a narrower capability than the TMOD's, on the same
  self-assert trust (#296).
- A meeting's **planned attendance** rides that same self-assert trust since #576, and is NOT
  agenda content, so it has its own ladder: `resolveActor` (`src/server/attendance-plan.ts`) has
  three arms — club `admin` → this meeting's TMOD → self — and `viaManager` (either of the first
  two), not a session, is what admits a write of ANY member's rung including the officer-private
  `reached_out`. Three things stay narrower than the write. **Clearing** a rung that is not the
  caller's own answer stays on the OFFICER arm (`via === "officer"`, which requires a session),
  because deleting someone else's record of having asked is not what the panel is for. A TMOD
  write may only ever REPLACE `reached_out`, never a member's real `coming` / `not_coming`. And on
  the read (`getTmodPanelData` → `loadTmodPanelData`) the rungs and member NAMES ride the claim
  while phone and email require a real session whose own membership IS the TMOD — see the
  **Planned attendance** entry above and `getPublicMeetingByKey`'s PII rule. Which arm granted a
  write is persisted as `activity_log.detail.grantedVia`, which is what makes ADR-0010's "made
  safe by the activity log" true for an honour-system grant.
- All three capability slots are resolved by `role_definitions.key`, **never by the club's display
  name**: renaming a role must not move a capability, and a club-invented role whose name merely
  resembles one must not gain it. A row whose `key` is still NULL falls back to an **exact**
  canonical-name match, never a prefix. One resolver family (`findTmodSlot` / `findGrammarianSlot`
  / `findVoteCounterSlot`, `src/lib/meeting-roles.ts`) serves both the route affordance and the
  server check for all three, so the button and the mutation cannot disagree (#464 / #510).
- A **Digital vote** ballot is not anonymous in the database — `meeting_votes` stores the voter,
  because the voter is exactly what the one-vote-per-person-per-category unique index enforces.
  Secrecy is a query-shape property only: `loadTally` (`src/server/voting-logic.ts`) returns
  counts, never rows, and the Ballot Counter is the only reader of even that. Paper slips are
  genuinely anonymous; this trades that for enforceability — a deliberate, stated property of the
  design, not an oversight. See #510.
- A **completed** meeting is **locked**: every agenda mutation (assign/claim/takeover,
  confirm/unconfirm, move/add/remove role/speaker, availability / planned-attendance write,
  meta edit) is rejected server-side, regardless of surface or capability. Only an admin **Reopen** (→ `scheduled`)
  lifts the lock. Enforced at `resolveMeetingAgendaAuthz` / `assertMeetingNotLocked`, not the UI
  (ADR-0012). The **minutes record** is outside that list on purpose (ADR-0014), and since v1.20.0.0
  that includes attendance: `setAttendance` gates on the club `admin` role plus
  `assertAttendanceRecordable` — has the meeting DAY arrived — and has never had a view of `status`,
  while the panel drops the lifecycle gate in roll mode alone
  (`writesLocked = roll ? false : locked`). A club writes its minutes up days later, so
  making a mis-marked member require Reopen would make the replacement stricter than the Minutes-card
  recorder it absorbed. Plan mode keeps respecting the lock.
- `src/server/*` touches `db`/`pg` and must never be imported by client components.
- Every **public, session-less** club reader gates on `clubs.archived_at` **itself**, through
  `isReadableClub` / `isReadableClubForMeeting` / `isReadableClubForMember`
  (`src/server/club-readable-logic.ts`), and returns its own not-found shape — `null` for a row,
  `[]` for a list — so an archived club answers exactly like one that never existed. Archiving is
  the takedown lever (ADR-0016 / ADR-0024): a reader that skips the gate makes the lever do
  nothing. The `/club/$clubId` shell's `beforeLoad` is **not** this gate — it guards the caller,
  and a `createServerFn` is addressable with no session and no router. Reading it as coverage is
  why fourteen readers stayed open, including three keyed by a meeting or member id rather than a
  club id, so closing the club-keyed ones alone left a side door (#544).
  `public-readers-archive-gate.guard.test.ts` derives its candidate set from `src/server/*.ts`
  instead of listing one, so a new public reader must be gated or waived with a reason; the
  wiring half reads comment-blind for "must call" and raw for "must not call" (`guard-source.ts`).
- Every `club_logos` access — read, join, update or delete — is scoped to one club with
  `eq(clubLogos.clubId, <this club's id>)`. There is no shared library, template gallery or
  cross-club reuse of an upload, and adding one collapses ADR-0024's whole posture (constraint 2).
  A join condition is not scoping: `.innerJoin(clubLogos, eq(clubLogos.clubId, clubs.id))` with no
  `WHERE` returns an arbitrary club's bytes. Two further rules ride on every *public* read: it
  passes `isReadableClub` (the archive-gate invariant above — ADR-0024 constraint 4), and any path
  that decodes the bytes **inside the Node process** passes `isDecodeSafe` first, since compression
  ratio is unbounded and the role-sheet PDF endpoint is public and `no-store`. `club-logo-scope.guard.test.ts` sweeps `src/` for the
  cheap regressions, but it is a lexical net, not a proof — the real guarantee is the two-club
  seeding in `club-logo-logic.integration.test.ts`. See #495 / #496.
- Every user-controlled value that reaches the **role-sheet PDF** passes a cap. Its route
  (`/api/meetings/:id/role-sheets/:sheet/pdf`) is public and `no-store`, and react-pdf lays the
  document out **synchronously** inside the one Node process that serves everything else
  (ADR-0007) — so an oversized value is not a slow download, it is the event loop and therefore
  every other request stopped. Two layers, the same shape as the logo's byte cap plus
  `isDecodeSafe`: the write schemas bound what can be **stored** (`WOD_LIMITS` / `WOD_FIELDS`,
  `src/lib/wod-limits.ts`, plus `SPEAKER_LIMITS` for the speech title — see below), and `capFill`
  bounds what is **laid out** (`RENDER_CAPS`,
  `src/server/role-sheet-layout.ts`), so a row predating the cap — or arriving by import,
  migration, or a future write path — is truncated rather than fatal. `buildRoleSheetDoc` applies
  `capFill` at the single entry point, so a new field on `RoleSheetFill` needs a cap there; a
  consumer reading the **fill** instead of the document does NOT get one, which is why
  `renderRoleSheetPdf` separately caps the club name and date it hands back for the
  `content-disposition` filename. `cap` itself lives in `src/lib/cap.ts` (re-exported from
  `role-sheet-layout.ts` for its existing callers) because three layers now need it and two of
  them are client-safe. Two invariants hold it together, and #522 broke on the second. Its cost
  must stay bounded by its `max`, not by its input — spreading the whole string before deciding
  whether to truncate recreates the same DoS. And it must bound CODE POINTS, not UTF-16 units:
  slicing by unit cuts a surrogate pair in half and emits a lone surrogate, which react-pdf draws
  as a tombstone and which is invalid in a PDF text string. Those two pull against each other, so
  the fit check reads a bounded PREFIX **and** the raw length. Dropping the length half passes an
  all-astral value of any size straight through — a 20,000-emoji club name cost 7,848ms of blocked
  event loop on the public role-sheets GET, against 156ms for the same length in ASCII. See
  #519 / #522 / #496.
- The Word-of-the-Day write caps **reject** on the narrow paths and **truncate** on the wide one;
  reconciling them re-breaks one of the two. `createMeetingSchema` (word only — it accepts no
  definition or example) and `updateWordOfTheDaySchema` reject (`WOD_FIELDS`): those edits touch
  nothing else, so the error costs only the field being typed, and truncating there would silently
  drop the tail of a legacy definition the moment someone opened the editor and pressed Save.
  `updateMeetingSchema` truncates (`WOD_UPDATE_FIELDS`), because the whole-meeting form prefills
  and resubmits all three fields — rejecting would lock an admin out of saving the meeting's theme,
  date and location over text they cannot see. The columns are unbounded `text` and no backfill
  shipped, so such a row is possible. See #519.
- The **speaker-detail** fields (`SPEAKER_LIMITS` / `SPEAKER_FIELDS` / `SPEAKER_UPDATE_FIELDS`,
  `src/lib/speaker-limits.ts`) follow that same reject/truncate split, for the same reason.
  `claimSlot` **rejects**: nothing is prefilled there, so an error costs only what was just typed,
  and truncating would silently drop the tail. `updateSpeakerDetails` **truncates**, because
  `edit-speech-sheet.tsx` resubmits every field it renders, so one pre-cap value would block edits
  to the rest of the row — and that form is the only way to repair it. `presentationUrl` rejects on
  **both** paths: `normalizePresentationUrl` checks only scheme and hostname, so a cut link still
  validates and still looks like a link while 404ing. Two sizing constraints are not obvious from
  the speeches table: `projectName` must clear the Pathways catalog's widest project name (56),
  because `applyProjectDisplay` overwrites that field from the catalog *after* this schema runs;
  and the speech window is clamped only **after** the both-or-neither refinement, since clamping
  inside the field turns an inverted pair like `{700, 650}` into a valid-looking `{600, 600}`
  nobody typed. Every cap carries a human message — the claim sheet renders `ZodError.message`
  straight into a toast, and zod's default is a JSON dump of its issues. See #522.
- The **minutes PDF** (`/api/meetings/:id/minutes/pdf`) is the second synchronous react-pdf surface
  and is bounded the same two ways (`MINUTES_RENDER_CAPS`, `src/lib/minutes-render-caps.ts`). It
  needs a session and club membership, so it is narrower than the public role sheets, but it lays
  out in the same one process, so any club member can stall every other request. Both halves are
  load-bearing: per-string caps, **and** ROW-COUNT caps (`programRows` 60, `tableTopicsRows` 40,
  `nameRows` 100). react-pdf's cost is super-linear in row count even when every row is short
  (40 rows → 112ms, 500 → 285ms, 5,000 → 19,581ms), and the count is attacker-controlled with no
  session — `addSpeakerSlot` inserts two `role_slots` per call with no ceiling. The row caps are
  sized against ASTRAL text rather than ASCII, which is why they are tens and not hundreds. A cap
  that hides data prints `+N more` rather than stopping silently. Several of the fields it caps
  (`theme`, `topic`, `roleName`) are still unbounded on write, which is the point of a render cap:
  see #525.
- A `notifications` row is delivered **at most once**: the poller claims it with a conditional
  update (bump `attempts` / stamp `last_attempted_at` `WHERE sent_at IS NULL AND attempts = <read>`)
  before sending, then sets `sent_at` on success. Never send without claiming first (ADR-0023).
- A signed-in user may map to **several Person rows** (`people.user_id` is not unique — ADR-0008).
  Never resolve one with a bare `where(eq(people.userId, …))`: with no `ORDER BY` and no `LIMIT`
  that returns an ARBITRARY row, and two such queries in one request can disagree. Three
  resolvers in `src/server/person-identity-logic.ts` answer three different questions — pick the
  one that matches yours:
  - `resolveUserPersonId` — the ONE canonical Person (most memberships, then oldest, then id).
    For a person-level write that must land on a single record, e.g. declaring a Pathways path.
  - `userPersonIds` — EVERY linked Person. For self-checks ("is this roster row me?"), which a
    single arbitrary Person can answer "no" about the user's own record.
  - `userMemberIds` — EVERY roster membership across every linked Person and every club (#437).
    For "what have *I* got?" surfaces: the speech log, upcoming commitments.
  `userMemberIds` deliberately OMITS the `members.status = 'active'` filter that `auth-context.ts`
  applies to the club switcher, so it is a strict **superset** of the switcher, not a match for
  it: leaving a club does not un-give the speeches you gave there. Do not "reconcile" the two by
  adding a status filter — that silently re-breaks #437 for anyone whose old membership lapsed.
- A reminder email is addressed to the **account** (`notifications.user_id`), never to the Person,
  so duplicate Persons on one account mail the identical inbox. Any per-Person reminder preference
  must therefore converge across EVERY Person on the account: both writers do
  (`setReminderOptOutForUser` from the `/me` toggle, `setPersonReminderOptOut` from the no-auth
  `/unsubscribe` link), and the reader `getReminderOptOutForUser` reports opted-out only when every
  **mailable** Person is — mailable meaning one holding a roster membership, matching the join the
  #272 producer builds its recipients from. A membership-less Person is structurally unreachable by
  mail and must not vote. See #437 / #472.
- Member and guest **contact** (email, phone) reaches a payload only behind
  `requireClubViewAccess` — the club's own signed-in members, never a session-less caller. The two
  roster/profile queries that carry it live in `src/server/club-logic.ts` (`loadClubMembers`,
  `loadMemberProfile`) and gate on nothing themselves: the gate is the caller's, so a new importer
  is a new place a whole roster's contact can escape. `club-contact-gate.guard.test.ts` ENUMERATES
  `club.ts`'s server fns rather than listing the two it found, and holds that module to one
  importer. The season grid is the one surface with both an authed and a public reader over the
  same query, so it carries its own switch: `loadSeasonGrid` takes an explicit `includeContact`,
  `getSeasonGrid` sets it true behind `requireUser` + `requireClubViewAccess`, and
  `loadPublicSeasonGrid` hard-codes it false. The anonymous roster pick on `club/$clubId` is an
  identity, not a session — it must never turn contact on.
- Every **rendered** phone number opens a WhatsApp chat, never `tel:`. Surfaces render
  `WhatsAppPhoneLink`, whose href comes from the single copy of the mobile-`wa.me` /
  desktop-`web.whatsapp.com` rule in `src/lib/whatsapp.ts` (#485); the chat opens BLANK, since only
  the meeting page has the role context a prefilled draft would need (#37). A payload that DISPLAYS
  a phone coalesces it (`coalesceToE164`, `#/lib/phone`), which preserves an un-normalizable value
  ("call the office") so the component renders it as plain text instead of a dead link; a payload
  that only supplies a MESSAGE TARGET uses bare `toE164`, so "no contact on file" stays honest.
  Never bind an EDIT FORM to a coalesced value — coalescing is a country-code guess, and a form
  that round-trips it writes the guess back over what is on file (`phoneRaw` exists for that).
  `no-tel-links.guard.test.ts` sweeps `src/` for a literal `href="tel:"`; it does not, and cannot,
  see a number rendered as bare text. See
  `docs/superpowers/specs/2026-08-10-whatsapp-phone-links-design.md`.
- Every **rendered** email address goes through `mailtoHref` (`src/lib/mailto.ts`). Everything after
  the first `?` in a `mailto:` URL is HEADERS the mail client honours, so an address stored as
  `a@b.com?bcc=…` interpolated raw produces a link that silently blind-copies a third party — and on
  the VPE nudge, the one draft the user taps to SEND rather than reads first, `&subject=`/`&body=`
  can put words in their mouth. Not every writer of these columns validates the value
  (`bulkImportSchema` still does not), and rows written before a validator was added persist
  regardless, so the read-side escape is what neutralizes them. There are FOUR sinks;
  `mailto.guard.test.ts` fails on a fifth.

## Where decisions live

`docs/adr/` — read the ADR for an area before changing it. If a change contradicts an ADR,
say so explicitly rather than silently overriding.
