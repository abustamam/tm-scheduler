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
- **Upsert by email** (lowercased) within the target club: update existing rows,
  insert missing ones.
- Field mapping:
  - `name` ← Name
  - `email` ← Email
  - `phone` ← Mobile Phone || Home Phone || Additional Phone
  - `office` ← Current Position
  - `joinedAt` ← Member of Club Since (M/D/YYYY)
  - `originalJoinDate` ← Original Join Date (M/D/YYYY)
- Idempotent; prints inserted/updated counts.
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
  - Status reduces to the one real signal: a **"New"** pill derived from join date.
  - Segments trim to **All members** / **New members**.
  - Keep Member, tenure, Speeches, Open roles, merge dialog, Add member.
  - Update `RosterRow` and `TABLE_COLS` accordingly.
- **`src/routes/_authed/members.$id.tsx`:**
  - Remove the **Current Pathway + level stepper** card and the **Awards earned** card.
  - Keep header (real tenure + joined date), Speech log, Roles served.
  - Status pill → "New" only.
- **`src/routes/_authed/dashboard.tsx`:**
  - Remove the hero **ProgressRing / "My Pathway"** card and the **"Next up"** project
    card.
  - Keep greeting, My speech log, My upcoming roles, Quick actions.
- **`src/data/club.ts`:** delete `mockPathway`, `hash`, `PATHS`, `PROJECTS`,
  `levelSteps`, `mockAwards`, and now-unused types (`MockPathway`, `LevelStep`,
  `LevelState`, `Award`). Keep `avatarGradient`, `statusMeta`, `MemberStatus`, and a
  trimmed `rosterSegments`.
- **`src/components/club/progress-ring.tsx`:** now unused → remove.

### 5. GitHub issues (`abustamam/tm-scheduler`)
- **Data-driven Pathways progress model** — real persisted level/percent/path/awards
  sourced from Base Camp exports (attach the "Paths Currently in Progress" + "Member
  Overview" screenshots as the target data). Restores the progress UI properly.
- **CSV member-import upload feature** — VPE-facing repeatable upload of the TM
  membership export, building on the one-off seed script.

## Verification

- `bun run check`, `bun run build`, `bun run test` all pass.
- `server-modules.guard.test.ts` still passes (script touches db but is never client-imported).
- New unit tests for the CSV parser + field/date mapping.
- Run the seed against **local dev** `dev-postgres` only; confirm tenure + joined dates
  render correctly on the roster and member detail. **Prod is not touched.**

## Out of scope (tabled)

- Real Pathways progress persistence (its own issue).
- CSV upload UI (its own issue).
- Credential / highest-achievement / completed-paths / last-speech persistence.
- Paid-vs-unpaid membership status modeling.
