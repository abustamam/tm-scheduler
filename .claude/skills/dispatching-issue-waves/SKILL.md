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
4. Dispatch that stage — one agent per issue, each handed **the brief** below. The brief has
   each agent create and bootstrap its own worktree.
5. Each agent opens its PR and **stops**: `gh pr create`, body carrying `Closes #N`, no merge.
6. **From the main session**: review the wave's PRs, then land them one at a time — see
   **Landing the wave** below. The merge decision is the maintainer's, not an agent's.
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

- **Worktree:** `git worktree add`, then `bun run worktree:setup "<what you are building>"`
  **from inside it** — run from the main checkout it exits 0 without bootstrapping anything.
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

1. Make your own worktree, from the main checkout:
   `git worktree add .claude/worktrees/<slug>-<N> -b <slug>-<N>`
   The issue number goes LAST in the branch name with nothing after it — CLAUDE.md's
   "Branch naming" has the rules and what a suffix costs.
2. `cd` into that worktree, then `bun run worktree:setup "<what you are building>"`.
   Run it FROM THE WORKTREE: from the main checkout it exits 0 having done nothing, and
   the missing bootstrap does not surface until something silently returns empty.
3. `/investigate` before you write anything.
4. Implement. Stay inside the cited files. A NEW file you create — a test beside the code
   you changed, most often — is yours and needs no citation. An EXISTING file that is not
   listed above is not yours: STOP and report the path instead of editing it.
5. Green gates before you open the PR: everything CI's `check` job runs
   (`.github/workflows/ci.yml`). `bun run test` needs `TEST_DATABASE_URL` or the
   database-backed tests skip and the run still reads green — CLAUDE.md has the value.
6. `gh pr create` with `Closes #<N>` in the body.
7. STOP THERE. Do not merge, do not review your own PR, do not pick up another issue.
```

**Keep it this short.** The agent works in a worktree, so it reads CLAUDE.md itself — the
brief carries only what CLAUDE.md cannot know: which issue, which files, and that this agent
stops at the PR. Where the two must overlap, copy a **command name or a one-line rule** and
cite CLAUDE.md for the reasoning. Never copy the reasoning, and never copy a number: a figure
restated here is a figure that goes stale somewhere else first. Step 5 is the shape to
imitate — it points at `ci.yml` rather than listing the gates, because an earlier draft
listed three of them and CI ran five.

Step 4 is the one rule with no home in CLAUDE.md, so here is why it is there: a wave is
disjoint by the paths the issue **bodies** cite. An agent that edits an existing file its own
issue never cited voids that property for the whole wave, and nothing downstream catches it —
`batch:issues` planned against the bodies and has already run, so the collision surfaces as an
ordinary conflict with no cause attached.

## Landing the wave

**From the main session, and the merge is the maintainer's.** A wave agent stops at
`gh pr create`; nothing below is on its path.

`/review-pr` checks nothing out, so the wave's reviews are independent and all run at once.
Merging is the serial half.

1. `/review-pr N` for **every** PR in the wave, dispatched together. Where one prints a
   risk-category hint, run gstack `/review` in that PR's worktree as well.
2. Send back what the reviews found.
3. **Read the fix diff before merging it — you, not an agent.** The reviewers saw the diff as
   it was dispatched; the commits answering them are gated by nothing, and CI only proves the
   tests still pass. Every other step here can be delegated, and this is why the merge button
   is not on the agent path at all.
4. `gh pr merge --squash --auto`, then `gh pr update-branch` on each PR still open —
   CLAUDE.md's "Land" row has why branch protection forces that order. Back to 3 with the
   next PR, until the wave has landed.

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
| An agent editing an **existing** file its issue never cited | Voids the disjointness the wave was built on; the collision arrives with no cause attached |
| Running `worktree:setup` from the main checkout | It exits 0 having done nothing; the worktree stays unbootstrapped and fails silently later |
| Merging the round that answers the review | Those commits were reviewed by nothing; the maintainer reading that diff is the only gate |
| Reviewing the wave's PRs one at a time | `/review-pr` checks nothing out; only the merging has to be serial |
