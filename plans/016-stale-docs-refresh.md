# Plan 016: Correct the agent-facing docs that are actively wrong

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 6a37548..HEAD -- CLAUDE.md docs/adr/0008-person-identity-vs-membership.md docs/persistence-todo.md docs/design/reminders.md docs/design/magic-link-email.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live files before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `6a37548`, 2026-07-08
- **Issue**: https://github.com/abustamam/tm-scheduler/issues/127

## Why this matters

This repo is developed largely by agents, and agents act on CLAUDE.md, the
ADRs, and the design docs as ground truth. Five statements in those docs are
now factually wrong — worse than missing, because an agent will confidently
mis-model the domain (CLAUDE.md says the schema is one `todos` table; it has
19 tables), search for a table that no longer exists **on the auth path**
(ADR-0008), attempt an already-completed migration (`persistence-todo.md`), or
believe the reminders feature is blocked by a task that shipped
(`docs/design/reminders.md`).

This plan is text-only: no source code changes.

## Current state

Each wrong statement, verified against the code at `6a37548`:

1. **`CLAUDE.md:72`** says:
   > Schema is `src/db/schema.ts` (a single `todos` table so far — this is an early scaffold).
   Reality: `src/db/schema.ts` defines 19 `pgTable`s (clubs, people, members,
   officer_terms, meetings, role_definitions, role_slots, member_availability,
   speeches, pathways_paths, path_enrollments, path_level_progress,
   pathways_projects, pathways_path_levels, bcm_project_progress, sync_tokens,
   activity_log, notifications, plus the Better-Auth tables in
   `src/db/auth-schema.ts`). There is no `todos` table.

2. **`docs/adr/0008-person-identity-vs-membership.md`** (lines ~50–80)
   describes Phase B as a future follow-up and ends its Consequences with:
   > Until Phase B, `club_role` still resolves via `club_memberships`; …
   Reality: Phase B shipped (PR #110, commit `ced162c`; migration
   `drizzle/0014_spicy_rattler.sql` dropped `club_memberships`).
   `src/server/guards.ts:54` reads `members.clubRole` directly; `grep -rn
   "club_memberships\|clubMemberships" src/` returns nothing. The ADR's
   *decision* is correct — only its status framing is stale.

3. **`docs/persistence-todo.md`** — two stale sections:
   - "## Roster cutover (post-PR #39)" says `role_slots.assigned_user_id`
     still keys to a Better-Auth user and cites a `TODO(cutover)` in
     `src/server/club.ts`. Reality: the column is `assigned_member_id`
     (FK → members) in `src/db/schema.ts`, `club.ts` uses `assignedMemberId`
     throughout, and no `TODO(cutover)` exists.
   - "### 1. Pathways enrollment + progress ← highest value", "### 2. Member
     status", "### 3. Awards / completions" describe Pathways as unmodeled and
     mocked by `mockPathway(seed)`/`mockAwards`. Reality: the Pathways model
     shipped (path_enrollments, path_level_progress, pathways_projects,
     bcm_project_progress + the sync extension); `grep -rn "mockPathway\|mockAwards" src/`
     returns nothing.

4. **`docs/design/reminders.md:4-5`** says:
   > **Status**: Design spike only — no code ships from this doc.
   > **Gate**: The entire build is blocked on wiring a real email provider (ADR-0004 pre-launch task). The `sendMagicLink` callback in `src/lib/auth.ts:21-24` is still a `console.log` stub. …
   Reality: `src/lib/email.ts` is a real Resend transport and
   `src/lib/auth.ts:30-38`'s `sendMagicLink` calls
   `buildMagicLinkEmail` + `sendEmail`. The gate is cleared. The doc also
   predates the Person/Membership model: §2c/§3 reference
   `club_memberships`, `clubRole = 'vpe'`, and `role_slots.assignedUserId`,
   all gone from the schema.

5. **`docs/design/magic-link-email.md:7-9`** says:
   > `sendMagicLink` in `src/lib/auth.ts` currently only `console.log`s the URL — … This is the hard launch blocker …
   Reality: shipped (same evidence as #4).

Also note (do NOT edit for this): issue #120 on the tracker is still open but
its work shipped in PRs #122/#123 — the operator will close it; not an
executor task.

Conventions: docs in this repo are plain Markdown, wrapped near 90–100 cols,
using the CONTEXT.md glossary vocabulary (Person, Membership, `club_role`,
Officer term, Role slot). Match that voice — factual, present-tense, with
issue/PR references.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Verify stale strings gone | (greps in Done criteria) | zero matches |
| Repo gates untouched | `bun run check` | exit 0 (docs aren't linted, but run it to prove no source drift) |

## Scope

**In scope** (the only files you should modify):

- `CLAUDE.md`
- `docs/adr/0008-person-identity-vs-membership.md`
- `docs/persistence-todo.md`
- `docs/design/reminders.md`
- `docs/design/magic-link-email.md`

**Out of scope** (do NOT touch):

- Any file under `src/`, `drizzle/`, `extension/`, `scripts/`.
- `CONTEXT.md` (already accurate).
- Other ADRs (0001–0007, 0009–0011) — verified accurate or already carry
  supersession notes.
- GitHub issues (closing #120 is the operator's call).

## Git workflow

- Branch: `advisor/016-stale-docs-refresh` (dedicated git worktree — repo rule).
- Commit style: `docs: correct stale schema/ADR-0008/persistence/reminders statements`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fix CLAUDE.md's data-layer paragraph

Replace the sentence at `CLAUDE.md:72` ("Schema is `src/db/schema.ts` (a
single `todos` table so far — this is an early scaffold).") with an accurate
one-paragraph description. Target text (adapt formatting to the surrounding
"## Data layer" section):

> Schema is `src/db/schema.ts` — the full domain model (~19 tables): clubs,
> people/members (Person vs Membership, ADR-0008), officer_terms, meetings,
> role_definitions/role_slots (ADR-0005), member_availability, speeches
> (ADR-0009), the Pathways model (pathways_paths, path_enrollments,
> path_level_progress, pathways_projects, pathways_path_levels,
> bcm_project_progress — ADR-0011), sync_tokens, activity_log, and a
> notifications table (schema only). Better-Auth's tables live in
> `src/db/auth-schema.ts`. See `CONTEXT.md` for the glossary.

Keep the rest of the section (db client, migrations workflow, CI drift check,
server-modules rule) — it is accurate.

**Verify**: `grep -n "todos" CLAUDE.md` → no matches.

### Step 2: Add a status note to ADR-0008

Immediately under the ADR's `Status: Accepted` line (or equivalent header
area), add:

> **Status update (2026-07-08):** Phase B shipped in #99/#110 (migration
> `drizzle/0014_spicy_rattler.sql`). `club_role` now lives on `members`,
> `user_id` on `people`, `guards.ts`/`auth-context.ts` resolve roles via the
> membership row, `club_memberships` is dropped, and `vpe` collapsed into
> `admin`. Statements below that describe Phase B as pending are historical.

Do not rewrite the body — ADRs are records; the note is the correction.

**Verify**: `grep -n "Status update (2026-07-08)" docs/adr/0008-person-identity-vs-membership.md` → 1 match.

### Step 3: Refresh docs/persistence-todo.md

- Move the "Roster cutover" section's content into the "Wired to real data
  (done)" list as a single line: "**Roster cutover** — `role_slots` keys to
  `assigned_member_id` (FK → members); the user bridge is gone." Delete the
  stale prose (the `TODO(cutover)` reference and the "To finish the cutover"
  bullet).
- Rewrite items 1–3 ("Pathways enrollment + progress", "Member status",
  "Awards / completions") to reflect reality: Pathways enrollment/progress is
  MODELED and synced from Base Camp (tables above; extension + `/api/pathways/ingest`);
  mark item 1 done. Items 2–3: the *derived member status* and *awards* views
  remain unbuilt — keep them as todo but reword so they reference the real
  Pathways tables instead of `mockPathway`/`mockAwards` (which no longer
  exist).
- Leave items 4–6 (resources, RSVPs, reminders) as-is except: in item 6, note
  the email gate is cleared and point at `plans/020-reminders-build.md`.

**Verify**: `grep -n "mockPathway\|TODO(cutover)\|assigned_user_id" docs/persistence-todo.md` → no matches.

### Step 4: Correct the reminders design doc's gate + schema references

In `docs/design/reminders.md`:

- Replace the `**Gate**:` line (line 5) with:
  > **Gate — CLEARED (2026-07-08)**: the shared email transport shipped
  > (`src/lib/email.ts`, Resend; `sendMagicLink` in `src/lib/auth.ts` now
  > sends real email). The build is unblocked.
- Directly below the header block, add a short "**Drift note (2026-07-08)**"
  paragraph stating: the schema references in §2c/§3/§6 predate the
  Person/Membership model — `club_memberships` and `clubRole='vpe'` no longer
  exist (roles live on `members.club_role`, values `admin|member`), and
  `role_slots.assignedUserId` is now `assigned_member_id` (FK → members, who
  may have no sign-in account). The reconciled build spec is
  `plans/020-reminders-build.md`, which supersedes this doc's §6 recipient
  details.

Do not rewrite §2–§8 bodies.

**Verify**: `grep -n "still a \`console.log\` stub" docs/design/reminders.md` → no matches; `grep -n "Gate — CLEARED" docs/design/reminders.md` → 1 match.

### Step 5: Status-banner the magic-link design doc

In `docs/design/magic-link-email.md`, change the Status in the blockquote at
the top from "**design approved**, plan to follow…" to
"**implemented** (shipped to `main`; `src/lib/email.ts` +
`src/lib/magic-link-email.ts`). Historical design record." and past-tense the
"currently only `console.log`s the URL" sentence in the Problem section
(e.g. "At the time of writing, `sendMagicLink` only `console.log`ged the URL…").

**Verify**: `grep -n "currently only \`console.log\`" docs/design/magic-link-email.md` → no matches.

### Step 6: Full gate

**Verify**: `git status` shows only the five in-scope files modified;
`bun run check` → exit 0.

## Test plan

No code tests — the Done criteria greps are the verification. Do not add
tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -rn "todos" CLAUDE.md` → 0 matches
- [ ] `grep -c "Status update (2026-07-08)" docs/adr/0008-person-identity-vs-membership.md` → 1
- [ ] `grep -rn "mockPathway\|mockAwards\|TODO(cutover)\|assigned_user_id" docs/persistence-todo.md` → 0 matches
- [ ] `grep -rn "console.log\` stub" docs/design/reminders.md` → 0 matches
- [ ] `grep -rn "currently only" docs/design/magic-link-email.md` → 0 matches
- [ ] `git status` — only the five in-scope files changed
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- Any "Current state" excerpt no longer matches the live doc (someone else
  refreshed it first) — reconcile, don't duplicate.
- You find a doc statement you believe is wrong but that this plan doesn't
  cover — note it in your report; do NOT expand scope.
- Correcting a statement would require changing *code* to match the doc
  instead — that inverts the plan; report it.

## Maintenance notes

- The deeper fix is habit: when a phase/gate recorded in an ADR or design doc
  ships, append a status note in the same PR. Reviewers should ask "does this
  PR complete something a doc says is pending?"
- `docs/design/vpe-dashboard.md` was checked and is accurate (its build,
  issues #8/#9, genuinely hasn't happened).
- Issue #120 (open on the tracker, work shipped in #122/#123) is for the
  operator to close manually.
