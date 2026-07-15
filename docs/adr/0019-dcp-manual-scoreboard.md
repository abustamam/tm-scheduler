# ADR-0019: Distinguished Club Program — a manual scoreboard, catalog in code

Status: Accepted

## Context

The President office (`officer_terms` position `president`, resolving to club `admin` via
effective-admin) had no dedicated feature — it maps mostly to existing surfaces (club settings,
roster). The one genuinely President-owned job with nothing like it is tracking the club's
**Distinguished Club Program (DCP)** progress: 10 standardized Toastmasters goals across a program
year (Jul 1 – Jun 30), driving recognition as Distinguished / Select / President's Distinguished.

Issue #207 asks for a DCP goal tracker. The load-bearing question raised in triage was the
**auto-derive vs. manual-scoreboard boundary**: which of the 10 goals GavelUp computes from
existing data vs. which the President enters by hand.

Investigation settled it. The six **education** goals (levels completed) cannot be reliably
auto-derived from the Pathways model today: `path_level_progress` stores only current-state counts
(`level`, `completed`, `total`, `approved`) with **no completion date** and **no club
attribution**, so an approved level can't be scoped to a program year or credited to a club — the
two facts DCP education goals require. Pathways data also only exists for clubs that run the Base
Camp sync extension. By contrast the two **membership** goals (new members) are cleanly derivable
from `members.joined_at`.

## Decision

### 1. v1 is a manual scoreboard, with a roster-derived assist only on the membership goals

The President enters/toggles every goal by hand. The **only** auto-derivation is a roster-based
pre-fill of the two new-member goals (7 & 8) plus the membership-base number. Education-goal
auto-derivation is deferred to #245, gated on a Pathways sync/schema change to date-stamp and
club-attribute level completions. This ships the President-owned value now without a speculative
schema commitment, and degrades gracefully for clubs that never sync Base Camp.

### 2. The goal catalog is static code; only progress is stored

The 10 DCP goals (labels, categories, targets) are standardized by Toastmasters International and
stable year-to-year, so they live as a static catalog in `src/lib/dcp.ts` — not a table. Only
per-club **progress** is persisted:

- **`dcp_scoreboards`** — parent, one row per `(club_id, program_year)` (unique). Holds
  `base_member_count`, **auto-snapshotted** to the current active-member count when the scoreboard
  is first started and **President-editable** thereafter (so a club adopting mid-year can correct
  it). `program_year` is the starting calendar year.
- **`dcp_goal_progress`** — one row per `(scoreboard_id, goal_key)` (unique), storing an integer
  `achieved` and an audit `updated_by` / `updated_at`. `goal_key` is plain text matching a
  `DCP_GOALS[].key`, keeping the code catalog the single source of truth (no goal enum).

### 3. Uniform per-goal model; tier and base are derived, never stored

Every goal has a catalog `target`; `met = achieved ≥ target`. Count goals (1–8) store the count;
composite goals (9 training, 10 administration) are scored by TI as a single met/not, so they are
`target = 1` with a 0/1 toggle. The **recognition tier** and **membership base** are computed at
read time (`src/lib/dcp.ts`), never stored:

- Base met = `current_active ≥ 20` **OR** (`base_member_count` set AND
  `current_active − base_member_count ≥ 5`). The net-+5 baseline must be stored because roster
  history can't reconstruct "who was active on Jul 1" (`members.status` is current-only).
- Tier (only if base met): ≥9 → President's Distinguished · ≥7 → Select · ≥5 → Distinguished.

### 4. Admin-gated surface, reusing existing authz

The scoreboard lives at an admin-gated route (`_authed/admin/dcp`), mirroring the Treasurer's
`_authed/admin/dues`. View + edit are gated on club `admin` (`requireClubRole(["admin"])`); the
President defaults to admin, so no officer-position-based authz is introduced. Admin-only in v1 —
a read-only/motivational member view can come later. The DB logic lives in `dcp-logic.ts` (the
server-fn module `dcp.ts` exports only `createServerFn`s + types, per the server-module bundle
rule) and the tier/base/catalog math is the pure, client-safe `#/lib/dcp`.

## Consequences

- Ships the President's DCP tracker with no dependency on the Pathways model or a background job.
- Education goals are hand-entered until #245 lands the completion-dating/attribution change.
- New tables `dcp_scoreboards` / `dcp_goal_progress`; the catalog stays in code, so a future TI
  rule change is a code edit, not a migration.
- The membership base's net-+5 path depends on the snapshotted baseline; a club that starts its
  scoreboard well after Jul 1 must correct `base_member_count` by hand.
