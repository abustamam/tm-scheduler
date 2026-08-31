---
name: dispatching-issue-waves
description: Use when acting on `bun run batch:issues` output, or when handing several ready-for-agent issues to parallel agents in one sitting.
---

# Dispatching Issue Waves

## Overview

`batch:issues` prints a **snapshot of one moment** — the backlog, the checkout, and the
claims that existed when it ran. It is not a schedule. Landing anything invalidates it.

## The loop

One stage per iteration, re-planned at the top of every iteration:

1. `bun run batch:issues` — **every iteration**, not once at the start.
2. Take **only the first stage printed**: SERIAL's first issue, or the first WAVE.
3. **If you took a WAVE and another WAVE follows it, widen before dispatching.** Re-run with
   `--max` set to the total of both. If they collapse into one wave, they never conflicted —
   the cap split them — and that merged wave is the stage to dispatch. Do this every time a
   trailing wave is smaller than `--max`; it is the only free throughput in the loop.
4. Dispatch that stage. One worktree per issue.
5. Land it — merged, not just green.
6. Go to 1.

Step 1 is not a formality. Between stages the plan genuinely changes: a merge makes cited
paths exist (an issue leaves CITED PATHS ARE MISSING), someone's worktree or PR claims an
issue, `/triage` adds new `ready-for-agent` issues, and fan-in shifts as imports move.
Executing waves 1→2→3 from one printout dispatches work against a checkout that no longer
exists.

## What each section requires

| Section | Means | Required action |
|---|---|---|
| SERIAL | Touches a widely-imported file, or writes a migration | One at a time, merge between. The **order is meaningful** — it is dependency-sorted. |
| WAVE n | Mutually file-disjoint | Dispatch together |
| ALREADY BEING WORKED | A PR or live worktree names it | Do not dispatch. Re-run after it lands. |
| NEEDS A FILE PATH | Body cites no file | Edit the issue body to name its files, then re-run. Do not guess and dispatch. |
| CITED PATHS ARE MISSING HERE | Cites files this checkout lacks | `git pull --ff-only`, re-run. Still missing ⇒ the issue proposes a new file and needs one *existing* path too. |
| ⚠️ DEPENDENCY VIOLATIONS | Could not be reordered | Sequence those by hand before dispatching |
| ⚠️ Could not read PRs/worktrees | A claim source was unreachable | The plan may contain work someone else is on. Verify by hand. |

## The line that reads as decoration and is not

**`(also cited, absent from this checkout: …)` under an issue that IS batched.** Those paths
contributed nothing to disjointness, so this issue may sit in a wave beside one it will
really collide with. Resolve before dispatching: pull, or confirm the file is one this issue
creates.

## Required per dispatched issue

- **Worktree:** `git worktree add`, then `bun run worktree:setup "<what you are building>"`.
- **Branch: `<slug>-<issue>`, number LAST.** `fix-dcp-training-531` claims #531.
  `issue-531-dcp` claims **nothing** — reading stops at the first non-numeric trailing token —
  so the next re-run hands the same issue to a second agent.
- Then the repo's issue pipeline: `/investigate` → implement → `/qa` → `/ship`.

## Common mistakes

| Mistake | Consequence |
|---|---|
| Printing the plan once, then executing every wave from it | Later waves dispatched against a stale checkout and stale claims |
| Number in the middle of the branch name | Branch claims nothing; the issue is handed out twice |
| Skipping the absent-paths line | Two agents in one wave edit the same file |
| Treating a short trailing wave as a conflict | A serialised round for no reason |
| Dispatching a NEEDS A FILE PATH issue anyway | Disjointness was never established for it |
