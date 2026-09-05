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
4. Dispatch that stage — one worktree per issue, one agent per worktree, each handed **the
   brief** below.
5. Each agent opens its PR and **stops**: `gh pr create`, body carrying `Closes #N`, no merge.
6. Review the wave's PRs, then land them one at a time — see **Landing the wave** below.
7. Run `/qa-only` once against the deployed app. Then go to 1.

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

**Writing an issue so the tool can read it:** see `docs/agents/issue-tracker.md`'s "Body
conventions `batch:issues` reads" for the exact `## Files` heading and dependency phrasing
(`blocked by #N`, `depends on #N`, `requires #N`, `land #N first`, `blocks #N`) it recognizes.

## The line that reads as decoration and is not

**`(also cited, absent from this checkout: …)` under an issue that IS batched.** Those paths
contributed nothing to disjointness, so this issue may sit in a wave beside one it will
really collide with. Resolve before dispatching: pull, or confirm the file is one this issue
creates.

## Required per dispatched issue

- **Worktree:** `git worktree add`, then `bun run worktree:setup "<what you are building>"`.
- **Branch: `<slug>-<issue>`, number LAST — with nothing after it.**
  `fix-dcp-training-531` claims #531. `issue-531-dcp` claims **nothing**, and so does
  `fix-dcp-531-wip` or `-531-v2` or `-531-retry`: reading stops at the first non-numeric
  trailing token, so anything appended after the number silently un-claims the branch and
  the next re-run hands the same issue to a second agent. A retry branch needs a different
  slug, not a suffix.
- Then the repo's issue pipeline: `/investigate` → implement → `gh pr create` with `Closes #N`
  in the body → **stop**. Review, merge and `/qa-only` happen from the main session, per wave.

## The brief

The section above is what must be true. This is that, in the form you send. Fill the
placeholders from the issue's `batch:issues` entry and dispatch one per issue, verbatim:

```text
Issue #<N>: <title>

Files this issue cites:
  <path>
  <path>

1. From the main checkout: `git worktree add .claude/worktrees/<slug>-<N> -b <slug>-<N>`,
   then `bun run worktree:setup "<one line: what you are building>"`. Work only there.
   The issue number goes LAST in the branch name with nothing after it — see CLAUDE.md's
   "Branch naming" for the three ways a suffix silently un-claims the issue.
2. `/investigate` before you write anything.
3. Implement. Stay inside the cited files. If the real fix needs a file that is not
   listed above, STOP and report the path instead of editing it.
4. Gates, in order: `bun run typecheck`, `bun run test`, then
   `bunx biome check --diagnostic-level=error`. (`test` needs `TEST_DATABASE_URL` or
   ~630 tests skip and the run still reads green — CLAUDE.md has the value.)
5. `gh pr create` with `Closes #<N>` in the body.
6. STOP THERE. Do not merge, do not review your own PR, do not pick up another issue.
```

**Keep it this short.** The agent works in a worktree, so it reads CLAUDE.md itself — the
brief carries only what CLAUDE.md cannot know (which issue, which files, that this agent
stops at the PR). Growing it into a second copy of the conventions is how the two drift.
The branch rule is the one duplicated line, and it is duplicated because its failure is
silent: nothing errors, the issue is simply handed out twice.

## Staying inside the cited files

A wave is disjoint by the paths the issue **bodies** cite. An agent that edits a file its own
issue never cited voids that property for the whole wave, and nothing downstream catches it:
`batch:issues` planned against the bodies and has already run, and the second agent's edit to
that file looks like an ordinary conflict with no cause attached.

So when the fix genuinely lies outside the cited set, the agent stops and reports the path.
The main session then either widens the issue body and re-plans, or lands this wave first —
both are cheap. Editing it anyway and noting it in the PR body is not: by the time anyone
reads the body, the collision has already happened.

## Landing the wave

`/review-pr` checks nothing out, so the wave's reviews are independent and all run at once.
Merging is the serial half, because branch protection makes each land invalidate the rest.

1. `/review-pr N` for **every** PR in the wave, dispatched together. Where one prints a
   risk-category hint, run gstack `/review` in that PR's worktree as well.
2. Send back what the reviews found. Then **re-read the fix diff yourself before merging.**
   The review agents saw the diff as it was dispatched; the commits answering them are gated
   by nothing — no second review, and CI only proves the tests still pass. This is the one
   step in the loop with nothing watching it.
3. `gh pr merge --squash --auto` — one PR.
4. `gh pr update-branch M` on every PR still open (`strict: true` requires each branch be up
   to date with `main`). CI re-runs; auto-merge fires when green.
5. Back to 3 with the next PR, until the wave has landed.

A merge queue would run 3–5 unattended, and it was the first choice; GitHub offers it only on
organization-owned repos and this one is user-owned.

## Common mistakes

| Mistake | Consequence |
|---|---|
| Printing the plan once, then executing every wave from it | Later waves dispatched against a stale checkout and stale claims |
| Number in the middle of the branch name | Branch claims nothing; the issue is handed out twice |
| Anything appended after the number (`-wip`, `-v2`, `-retry`) | Same — reading stops at the first non-numeric trailing token |
| Skipping the absent-paths line | Two agents in one wave edit the same file |
| Treating a short trailing wave as a conflict | A serialised round for no reason |
| Dispatching a NEEDS A FILE PATH issue anyway | Disjointness was never established for it |
| An agent merging its own PR | Skips review, and lands on a `main` its CI run never saw |
| A PR body without `Closes #N` | The branch is deleted on merge, the claim vanishes, the issue is handed out again |
| An agent editing a file its issue never cited | Voids the disjointness the wave was built on; the collision arrives with no cause attached |
| Merging the round that answers the review | Those commits were reviewed by nothing — re-read the diff yourself |
| Reviewing the wave's PRs one at a time | `/review-pr` checks nothing out; only the merging has to be serial |
