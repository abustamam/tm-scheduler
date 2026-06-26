# Plan 007: Add a `.env.example` documenting required environment variables

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `ls .env.example 2>/dev/null` — if it already
> exists, read it and reconcile rather than overwriting.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `0e33f82`, 2026-06-26
- **Issue**: https://github.com/abustamam/tm-scheduler/issues/16

## Why this matters

The required environment variables are documented prose-style inside the README
setup block, but there is no committed `.env.example` to copy. A checked-in
example file is the standard, lowest-friction onboarding artifact: `cp .env.example
.env.local` and fill in the blanks. It also serves as the single authoritative
list of env vars for both humans and agents. This is a tiny, zero-risk addition.

## Current state

- No `.env.example` file exists. `.gitignore` ignores `.env` and `*.local`, so a
  committed `.env.example` is safe (it is neither).
- Required/used env vars, gathered from the codebase:
  - `DATABASE_URL` — Postgres connection string. Used in `src/db/index.ts:5` and
    `drizzle.config.ts:11`. **Required.**
  - `BETTER_AUTH_SECRET` — Better-Auth signing secret. Required by Better-Auth
    (`README.md:37` generates it via `bunx @better-auth/cli secret`). **Required.**
  - `BETTER_AUTH_URL` — base URL of the app, e.g. `http://localhost:3000`
    (`README.md:35`). **Required.**
  - `SEED_ADMIN_EMAIL` — optional override for the seed admin email; defaults to
    a hardcoded address in `src/db/seed.ts:17-18`. **Optional** (seed only).
- Local env lives in `.env.local` (loaded by `drizzle.config.ts` via dotenv and
  by the dev/seed scripts). `CLAUDE.md` "Environment" section names the three
  required vars.

**Do NOT put any real secret values in the example file** — placeholders only.

## Commands you will need

| Purpose | Command                  | Expected on success |
|---------|--------------------------|---------------------|
| Verify  | `cat .env.example`       | shows placeholders  |
| Tracked | `git check-ignore .env.example` | no output (NOT ignored) |

## Scope

**In scope** (create):
- `.env.example`

**Optionally in scope** (only if trivial and accurate):
- `README.md` — add a one-line "copy `.env.example` to `.env.local`" note in the
  Setup section. Skip if it risks duplicating the existing block confusingly.

**Out of scope** (do NOT touch):
- `.env.local` (real secrets, gitignored — never read its values into the example).
- Any source/config code.

## Git workflow

- Branch: `advisor/007-env-example`
- Conventional commit, e.g. `docs: add .env.example`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Create `.env.example`

```bash
# Postgres connection string (see README for a Docker quickstart).
DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_scheduler

# Base URL the app is served from.
BETTER_AUTH_URL=http://localhost:3000

# Better-Auth signing secret. Generate one with: bunx @better-auth/cli secret
BETTER_AUTH_SECRET=

# Optional: override the seed admin email (defaults to the project owner in src/db/seed.ts).
# SEED_ADMIN_EMAIL=you@example.com
```

Use placeholders only — `BETTER_AUTH_SECRET` is intentionally blank with a
comment on how to generate it.

**Verify**: `git check-ignore .env.example` produces **no output** (meaning it is
NOT ignored and will be committed); `cat .env.example` shows the four vars.

## Test plan

- No code tests. Verify the file is not gitignored and contains no real secrets.

## Done criteria

ALL must hold:

- [ ] `.env.example` exists with `DATABASE_URL`, `BETTER_AUTH_URL`,
      `BETTER_AUTH_SECRET` (blank), and `SEED_ADMIN_EMAIL` (commented)
- [ ] `git check-ignore .env.example` returns no output (file is trackable)
- [ ] No real secret values appear in the file (`BETTER_AUTH_SECRET` is blank)
- [ ] No other files modified except optionally `README.md` (`git status`)
- [ ] `plans/README.md` status row for 007 updated

## STOP conditions

Stop and report (do not improvise) if:
- `git check-ignore .env.example` returns the filename (it would be ignored —
  the `.gitignore` rules changed; report before forcing it).
- You find any env var referenced in code (`grep -rn "process.env" src drizzle.config.ts vite.config.ts`)
  that is not represented in the example.

## Maintenance notes

- Keep `.env.example` in sync when new env vars are introduced — it's the
  canonical list. A reviewer adding a `process.env.X` read should update this file.
- If a real email provider is wired (ADR-0004), its API key env var must be added
  here as a blank placeholder.
