---
name: shipping-batches
description: Use when deciding how many `/ship` runs a set of issues needs, or when a ship feels expensive for the size of the fix — covers which issues may share one PR and when a second review pass is worth paying for.
---

# Shipping Batches

## Overview

`/ship` costs roughly the same whether the fix is one line or one thousand. Before it reads any
of your code it reads **~33.4k tokens** of its own instructions (`ship/SKILL.md` 77KB +
`review-army.md` 24KB + `adversarial.md` 18KB + `pr-body.md` 15KB, at a rough chars÷4 — markdown
tables tokenize worse than that, so it is an under-estimate). Then 5–6 specialist subagents each
re-read the diff, and the adversarial subagent reads it again.

That fixed cost is **per run**. The only real levers are the number of runs, and whether you pay
for a second review army on top of the one `/ship` always runs. Never the reviewers themselves —
see **Do not disable reviewers**.

This skill is about ship-time cost. `dispatching-issue-waves` is about the `batch:issues` plan;
they answer different questions and the overlap is a trap — see the next two sections.

## `/ship` always reviews. `/review` is a SECOND army, not a substitute

The tempting belief is that running `/review` first "moves" the review out of `/ship`. It does
not, and this is worth checking yourself rather than believing:

- `/ship` invokes Step 9 (specialist dispatch) **unconditionally** — `ship/SKILL.md:683`.
- The readiness dashboard is informational and gates nothing. The NOT-CLEAR branch says so
  outright: *"Ship runs its own review in Step 9"* (`ship/SKILL.md:628`).
- A CLEARED verdict changes only what the dashboard PRINTS. (It is tempting to add that CLEARED
  needs zero findings — do not: `"clean"` means zero *unresolved* findings after Fix-First
  (`review/SKILL.md:900`), so clean entries are common here. The conclusion does not need that
  support and is wrong with it.)

So `/review` + `/ship` is two specialist armies and two adversarial passes. What `/review` buys is
**ordering**, not a discount: it puts the harshest reader first, so a late finding does not force
re-running the gates behind it. On #519 that ordering was worth four rounds.

| Situation | Do this |
|---|---|
| Large, cross-surface, several seams | `/review` first, then `/ship`. Pay for the second army; the ordering earns it. |
| 50+ changed lines, otherwise ordinary | `/ship` alone. It still runs a full specialist army and the adversarial pass. |
| Under 50 changed lines | `/ship` alone — but know that it dispatches **no specialists** (`ship/sections/review-army.md:178`). You get the adversarial pass only. `/review` has the same 50-line gate, so it would not help. |
| Risk category (below), any size | `/review` first regardless of how small the diff is. |

Read "cross-surface" as REACH, not file count: #646 touched four source files and every anchor in
the app.

**"Skip `/review`" rarely means "skip review."** Above 50 lines `/ship` reviewed it. Below 50, say
plainly that only the adversarial pass ran — do not report specialist review that did not happen.

## Sizing, and what counts as source

`/ship` gates on `DIFF_LINES` — the whole diff. On this repo guard tests and browser harnesses
carry most of it, so the built-in 50-line skip effectively never fires (2 of the last 25 PRs).
`CHANGELOG.md` and `VERSION` are NOT the inflators people assume: they are written in Step 12,
after the Step 9 review, so they are not in the diff at gating time.

```bash
git diff <base>...HEAD --stat -- src public scripts drizzle ':!*.test.*' ':!src/test' | tail -1
```

**`src/` alone is the wrong pathspec.** `public/sw.js` is the service worker (#639, #640 — where
it is the *only* non-test file), `scripts/` carries `batch-issues.ts`, and `drizzle/` carries every
migration. A migration PR measured with `-- src` under-counts precisely the change
`data-migration` exists to catch.

The command prints **nothing, not `0`**, when no file matches — 5 of the last 25 PRs. Treat empty
as zero, not as an error.

**Do not use file count as a gate.** Median source files per PR here is **2** (5 at zero, 4 at one,
4 at two), so a "≤4 files" bar covers 21 of 25 — the 84th percentile — and excludes almost nothing:
applied to that window it would skip `/review` on 17, including #629 (a security fix closing
self-add to a club roster) at 133 source lines and exactly 4 files.

**Risk category overrides size, always.** Authentication AND authorization — anything changing who
may write or delete another person's record — plus the archive gate, migrations, the service
worker, cascading deletes, anything touching `applySelfAdd`: `/review` first, at any size. #573 is
why authorization is named separately: 2 files, 81 source lines, none of the other categories, and
an officer's one-tap "No answer" silently deleted members' declined-attendance replies.

**Never state a smaller number to `/ship` to suppress specialists.** `DIFF_LINES` gates more than
the specialist list: red-team activates only above 200 **or on any CRITICAL finding**
(`ship/sections/review-army.md:338`), simplification above 100, and security whenever `SCOPE_AUTH`
is true at ANY size, else backend above 100 (`:181`). Everything is skipped below 50. Understating
it switches off red-team, the highest-yield lens in the repo. Force a lens ON instead when size
under-sells risk:
`--security`, `--performance`, `--testing`, `--maintainability`, `--data-migration`,
`--api-contract`, `--design`, `--simplification`, `--all-specialists`.

## A wave is not a batch

`batch:issues` groups issues that are **file-disjoint** so they can run in parallel worktrees
without colliding. A wave of four is four worktrees, four branches, four `/ship` runs. It buys
wall-clock and nothing else.

Collapsing issues into ONE ship saves a run only when they **share a surface** — the property a
wave deliberately splits apart:

| | `batch:issues` wave | One shared ship |
|---|---|---|
| Selects for | file-DISJOINT | file-OVERLAPPING or same surface |
| Worktrees | one per issue | one total |
| `/ship` runs | one per issue | one |
| Buys | wall-clock | tokens, version bumps, PRs |

Never collapse issues just because they landed in the same wave.

**Where this meets the plan.** Do NOT assume file-overlapping issues land in SERIAL — they do not.
SERIAL is **high fan-in OR migration** (`src/lib/issue-batching.ts:700-706`), matching
`dispatching-issue-waves`' own table ("touches a widely-imported file, or writes a migration").
File-overlapping issues go to `batchable` and are packed by first-fit into **separate WAVES**
(`:757-773`, "the earliest wave that shares none of its files").

So the candidates for one shared ship are spread across consecutive waves, not queued in SERIAL,
and `dispatching-issue-waves` has you take one wave per iteration. Pick deliberately:

- **Combine into one ship** when the issues are one coherent change to one surface. Saves a run.
- **Leave them in their waves** when they are independent changes that merely touch a shared file,
  or when one depends on another landing first. `dispatching-issue-waves` governs the order; do not
  combine to save a run at the cost of an unreviewable diff.

## May these issues share a ship?

All four must hold:

1. **Same surface.** Overlapping files, or the same component / route / seam.
2. **Neither is `ready-for-human`.** Those have an open question about the *shape* of the fix.
3. **Combined source diff stays reviewable.** Past a few hundred source lines the review gate stops
   converging and you have recreated the multi-round loop, having saved nothing. This bound is
   judgment, not a measured constant — no cost curve has been run for it.
4. **No migration in the set unless it is alone.**

Then: one worktree, one branch, one bump, one PR.

**Branch name carries every issue number, each last, nothing after it:** `fix-guest-convert-617-618`.
See CLAUDE.md's branch-naming rule for why a number anywhere but the end claims nothing.

**Bump once for the whole set.** `/ship` sizes the bump off the combined diff, so three MICRO fixes
together read PATCH. That is correct — do not split a PR to preserve a smaller bump.

## Do not disable reviewers

`gstack-config set skip_eng_review true` is the obvious-looking saving and it is the wrong one.
Findings per dispatch, **n=15 as of 2026-09-02**:

| Specialist | Findings per dispatch |
|---|---|
| red-team | 525% |
| data-migration | 500% (**one dispatch** — treat as noise) |
| maintainability | 444% |
| testing | 389% |
| design | 271% |
| api-contract | 250% |
| security | 211% |
| performance | 200% |
| simplification | 67% |

gstack auto-gates a specialist at **0 findings in 10+ dispatches**. Nothing is close, so the
adaptive gating never fires. `security` and `data-migration` carry `[NEVER_GATE]` and can never be
auto-gated regardless of rate.

**These numbers move every ship.** Re-run
`~/.claude/skills/gstack/bin/gstack-specialist-stats` rather than quoting this table — it was
n=14 one run before this was written.

Note `skip_eng_review` only changes the dashboard verdict; it does not suppress Step 9 either.

## Keep the fixed cost out of the main session

That 33.4k is re-read per run **and accumulates in whatever context runs it**. Shipping several
issues from one long session pays it repeatedly into a context that never resets. Dispatch each
ship into its own worktree session so the overhead lands in a throwaway context.

## Common mistakes

| Mistake | Consequence |
|---|---|
| Believing `/review` replaces `/ship`'s specialist pass | It stacks. Two armies, two adversarial passes. |
| Reporting a change as unreviewed because `/review` was skipped | `/ship` reviewed it — Step 9 is unconditional |
| Measuring source with `-- src` alone | `public/sw.js`, `scripts/`, `drizzle/` invisible; migration PRs under-count |
| Reading empty command output as an error | It means zero matching files — 5 of the last 25 PRs |
| Assuming file-overlapping issues land in SERIAL | SERIAL is fan-in or migration; overlapping issues go to separate WAVES |
| Reporting specialist review on a sub-50-line diff | Below 50 lines `/ship` dispatches none — adversarial only |
| Using ≤4 files as the gate | ~84th percentile here; would skip `/review` on a security fix (#629) |
| Telling `/ship` a smaller line count | Deactivates red-team (>200) and security/simplification (>100) |
| Collapsing a wave into one PR | Selected for disjointness; large unfocused diff, no token saving |
| `skip_eng_review` to save tokens | Turns off the highest-yield half; does not even skip Step 9 |
| Splitting a combined PR to keep a MICRO bump | Pays ~33.4k twice to avoid a version digit |
