# Plan 004: Remove dead scaffold code

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0e33f82..HEAD -- src/integrations/better-auth/header-user.tsx src/lib/format.ts src/routes/__root.tsx`
> If any in-scope file changed since this plan was written, compare the "Current
> state" excerpts against the live code; on a mismatch, treat it as a STOP
> condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `0e33f82`, 2026-06-26
- **Issue**: https://github.com/abustamam/tm-scheduler/issues/14

## Why this matters

Three pieces of leftover starter scaffolding are dead and actively misleading.
`CLAUDE.md` even points to `header-user.tsx` as *the* example of the client auth
pattern — but that component is imported nowhere and is styled with raw
`neutral-*` Tailwind classes that don't match the rest of the app (which uses
the shadcn token system: `bg-background`, `text-muted-foreground`). Dead code
that the docs cite as canonical teaches the wrong pattern to the next
contributor (human or agent). Removing it is low-risk and clarifies the
codebase.

## Current state

Verified unused at commit `0e33f82`:

- `src/integrations/better-auth/header-user.tsx` — exports `BetterAuthHeader`.
  `grep -rn "BetterAuthHeader\|header-user" src` returns only the file itself:
  imported nowhere. The real header lives in `src/routes/_authed.tsx` (its own
  sign-out button, shadcn-styled).
- `src/lib/format.ts:21-23` — `formatMeetingDateTime` is exported but never
  called (`grep -rn "formatMeetingDateTime" src` returns only the definition).
- `src/routes/__root.tsx` — the document `<title>` is still the starter default
  `'TanStack Start Starter'` (in the `head()` meta array). The app is
  "tm-scheduler" / "Toastmasters".

## Commands you will need

| Purpose   | Command                                          | Expected on success |
|-----------|--------------------------------------------------|---------------------|
| Typecheck | `bunx tsc --noEmit`                               | exit 0              |
| Build     | `bun run build`                                  | exit 0              |
| Lint/fmt  | `bun run check`                                  | exit 0              |
| Grep      | `grep -rn "BetterAuthHeader\|formatMeetingDateTime" src` | no matches after removal |

## Scope

**In scope** (modify/delete):
- `src/integrations/better-auth/header-user.tsx` (delete)
- `src/lib/format.ts` (remove `formatMeetingDateTime`)
- `src/routes/__root.tsx` (fix the `<title>`)

**Out of scope** (do NOT touch):
- The `confirmed` slot-status branch in `src/routes/_authed/me.tsx:81` — it
  *looks* dead (nothing sets `confirmed`), but plan 009 (D3) decides whether to
  build the confirm action or remove it. Leave it for 009.
- The `notifications` table in `src/db/schema.ts` — intentionally unused per
  `CONTEXT.md` ("schema must not block, build no logic"). Not dead code.
- `src/integrations/better-auth/` directory — only delete the one file; if other
  files exist there, leave them.
- `CLAUDE.md` — it references `header-user.tsx` as the client-auth example. Do
  NOT edit docs in this plan (a separate docs pass owns that). Instead, record
  in the maintenance note that the CLAUDE.md reference is now stale.

## Git workflow

- Branch: `advisor/004-remove-dead-scaffold`
- Conventional commit, e.g. `chore: remove dead scaffold (BetterAuthHeader, unused formatter, starter title)`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Delete the unused component

`git rm src/integrations/better-auth/header-user.tsx` (or delete the file).

**Verify**: `grep -rn "BetterAuthHeader\|header-user" src` → no matches.

### Step 2: Remove the unused formatter

In `src/lib/format.ts`, delete the `formatMeetingDateTime` function
(lines 21–23). Leave `formatMeetingDate` and `formatMeetingTime`.

**Verify**: `grep -rn "formatMeetingDateTime" src` → no matches.

### Step 3: Fix the document title

In `src/routes/__root.tsx`, change the `title` meta entry from
`'TanStack Start Starter'` to `'Toastmasters Scheduler'` (keep the same single
quotes / surrounding formatting that file uses — note `__root.tsx` uses spaces
and single quotes, unlike the Biome-formatted `src/` files; match its existing
style).

**Verify**: `grep -n "TanStack Start Starter" src` → no matches.

### Step 4: Full verification

**Verify**: `bunx tsc --noEmit` → exit 0; `bun run build` → exit 0;
`bun run check` → exit 0. (The build catches any route-tree or import breakage
from the deletion.)

## Test plan

- No new tests; this is deletion of unreferenced code. The verification is the
  type-check + build passing with the symbols gone.

## Done criteria

ALL must hold:

- [ ] `src/integrations/better-auth/header-user.tsx` no longer exists
- [ ] `grep -rn "BetterAuthHeader\|formatMeetingDateTime\|TanStack Start Starter" src` → no matches
- [ ] `bunx tsc --noEmit` exits 0
- [ ] `bun run build` exits 0
- [ ] `bun run check` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 004 updated

## STOP conditions

Stop and report (do not improvise) if:
- `grep` shows `BetterAuthHeader` IS imported somewhere (drift since this plan —
  it is no longer dead; do not delete).
- `bun run build` fails after the deletion for any reason other than the removed
  symbols.

## Maintenance notes

- After this lands, `CLAUDE.md`'s reference to
  `src/integrations/better-auth/header-user.tsx` as the client-auth example is
  stale. A docs follow-up should repoint it to
  `src/lib/auth-client.ts` + `src/routes/_authed.tsx` (the actual pattern in use).
- **Interaction with plan 003**: plan 003 (timezone) edits `src/lib/format.ts`
  and originally threads a `timeZone` arg through `formatMeetingDateTime`. Since
  this plan removes that function, whichever plan runs second wins: if 004 runs
  first, 003 should skip the `formatMeetingDateTime` edits (the function is
  gone); if 003 runs first, this plan still removes the now-unused function.
- Reviewer should confirm nothing in the running app rendered `BetterAuthHeader`
  (it didn't — the `_authed` layout has its own header).
