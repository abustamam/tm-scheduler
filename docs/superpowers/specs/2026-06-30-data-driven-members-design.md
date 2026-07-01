# Data-driven member data from CSV + hide fabricated progress

**Date:** 2026-06-30
**Branch:** `feat/data-driven-members`

## Problem

In production, imported members show **random** Pathways progress (level / percent /
path). The cause: there is **no DB model** for Pathways progress — every member's
level/percent/path/awards is fabricated by `mockPathway(seed)` in `src/data/club.ts`
(a hash of the member id). Separately, "member since" / tenure is rendered from
`members.createdAt` (the row-import timestamp), not the member's real join date, so
tenure is also wrong.

We have an authoritative Toastmasters membership export
(`ref/Club-Membership20260630.csv`) with real join dates, offices, and contact info.

## Decisions

- **Progress is tabled to its own issue.** We do NOT hardcode real progress into the
  app. Instead we **remove** the fabricated progress UI now and open a separate issue
  to build a real, data-driven Pathways model later.
- **Member data becomes data-driven** from the CSV via a one-off seed script (upsert by
  email). A repeatable upload feature is deferred to its own issue.
- **Two join dates** are stored on the member row: club join date (`joinedAt`, "Member
  of Club Since") and first-ever TM join (`originalJoinDate`, "Original Join Date").
  `members` is already club-scoped, so both live on the member row.

## Scope

### 1. Schema (`src/db/schema.ts` → `members`)
Add two nullable columns:
- `joinedAt timestamp("joined_at")` — club join date.
- `originalJoinDate timestamp("original_join_date")` — first-ever TM join.

`bun run db:generate` + `db:migrate`.

### 2. CSV seed script (`scripts/import-members.ts`)
- Invocation: `bun run scripts/import-members.ts --club <clubId> [--file <path>]`
  (default file `ref/Club-Membership20260630.csv`). Add a `package.json` script.
  Bun auto-loads `.env.local` for `DATABASE_URL`.
- Minimal quote-aware CSV parser (no new dependency).
- **Row filter:** import only rows where `Status (*)` == `PaidMember`. Skip unpaid
  members (Jamal, Gulnaz, Nancy). Not-yet-enrolled paid members (e.g. Farhanaaz) ARE
  imported. (This leaves the 14 paid members.)
- **Two-pass matching, scoped to the club** (dup-safe — a mismatched email must not
  silently duplicate a member):
  1. exact **email** match (lowercased);
  2. else exact **normalized name** match (trim + case-fold);
  3. else **insert**.
  If a name matches **more than one** existing member, **skip and warn** (never guess).
- **Overwrite policy on a match:**
  - `joinedAt` / `originalJoinDate`: **always** written (currently empty/wrong).
  - `name` / `email` / `phone`: **fill-only** — written only when the stored value is
    null/empty; never overwrite a non-empty value (protects in-app edits; e.g. the DB's
    "Rasheed Bustamam" is NOT replaced by the CSV's "Abdul-Rasheed Bustamam").
- Field mapping:
  - `name` ← Name (fill-only)
  - `email` ← Email (fill-only)
  - `phone` ← Mobile Phone only; Home/Additional ignored (fill-only)
  - `joinedAt` ← Member of Club Since (M/D/YYYY, parsed as y/m-1/d)
  - `originalJoinDate` ← Original Join Date (M/D/YYYY) — **stored, no UI** (feeds #64)
  - **`office` is NOT touched** — officer positions modeled in #63.
  - **No `customerId`** — the CSV's `PN-…` ID is not persisted this pass.
- Idempotent; logs each row's outcome (`inserted` / `updated-by-email` /
  `updated-by-name` / `skipped-ambiguous` / `skipped-unpaid`) + a summary count.
- **Known limitation:** unpaid members already present in the DB are skipped, so they
  retain their `createdAt`-based (wrong) tenure until a later pass includes them. (Not
  present in local dev; prod may vary.)
- The directly-testable parse + map logic lives in a sibling `*-logic` style module (or
  exported pure functions in the script) so the CSV parser and date/field mapping are
  unit-tested without a DB. The DB-writing portion stays in the script.

### 3. Server selects (`src/server/club.ts`)
`listClubMembers` and `getMemberProfile` add `joinedAt` and `originalJoinDate` to their
selects so views can read the real dates.

### 4. Display changes
- **Tenure source:** everywhere tenure/join is shown, switch `m.createdAt` →
  `m.joinedAt ?? m.createdAt`, feeding `formatTenure` / `isNewMember` / `joinedLabel`.
- **`src/routes/_authed/index.tsx` (roster):**
  - Remove the **Pathway** column and the **Level progress** column (and the progress
    bar).
  - Remove the **Level completions** and **Needs attention** stat cards.
  - **Remove the Status column and the segment filters entirely** — with real join
    dates ~nobody is "new" (earliest is 2026-04-01, just outside the 90-day window), so
    a status pill / New segment would be dead UI. Roster columns become Member · tenure ·
    Speeches · chevron.
  - Keep Member, tenure, Speeches, Open roles, merge dialog, Add member.
  - Update `RosterRow` and `TABLE_COLS` accordingly.
- **`src/routes/_authed/members.$id.tsx`:**
  - Remove the **Current Pathway + level stepper** card and the **Awards earned** card.
  - Keep header (real tenure + joined date), Speech log, Roles served.
  - **Remove the header status pill** (no real status signal).
- **`src/routes/_authed/dashboard.tsx`:**
  - Remove the hero **ProgressRing / "My Pathway"** card and the **"Next up"** project
    card.
  - Keep greeting, My speech log, My upcoming roles, Quick actions.
- **`src/data/club.ts`:** delete `mockPathway`, `hash`, `PATHS`, `PROJECTS`,
  `levelSteps`, `mockAwards`, `rosterSegments`/`RosterSegment` (segments removed), and
  now-unused types (`MockPathway`, `LevelStep`, `LevelState`, `Award`). Keep
  `avatarGradient`, `statusMeta`, `MemberStatus`, `StatusMeta` as exports for the future
  progress issue (#61) even though nothing renders them now (unused exports don't fail
  strict TS/Biome).
- **`src/components/club/progress-ring.tsx`** (dashboard-only) and
  **`src/components/club/status-pill.tsx`** (roster/detail-only) are now unused → remove
  both. Grep-confirm no other importers before deleting.

### 5. GitHub issues (`abustamam/tm-scheduler`) — CREATED
- **#61** Data-driven Pathways progress model (`ready-for-agent`) — real persisted
  level/percent/path/awards from Base Camp exports; restores the removed progress UI.
- **#62** CSV member-import upload feature (`ready-for-agent`) — VPE-facing repeatable
  upload, reusing this script's parse/match/overwrite logic.
- **#63** Model club officer positions (`needs-triage`) — replace free-text
  `members.office`.
- **#64** Model multi-club membership (`needs-triage`) — person identity vs per-club
  membership; home for `originalJoinDate`; CSV `Customer ID` (`PN-…`) as person key.

## Verification

- `bun run check`, `bun run build`, `bun run test` all pass.
- `server-modules.guard.test.ts` still passes (script touches db but is never client-imported).
- New unit tests for the CSV parser + field/date mapping.
- Run the seed against **local dev** `dev-postgres` only; confirm tenure + joined dates
  render correctly on the roster and member detail. **Prod is not touched.**

## Out of scope (tabled)

- Real Pathways progress persistence (its own issue).
- CSV upload UI (its own issue).
- Officer position modeling — `members.office` left as-is (#63).
- Multi-club person model / persisting the CSV `Customer ID` (`PN-…`) (#64).
- Credential / highest-achievement / completed-paths / last-speech persistence.
- Paid-vs-unpaid membership status modeling.
