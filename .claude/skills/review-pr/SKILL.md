---
name: review-pr
description: Review an open pull request by number from the main checkout, with nothing checked out. Fetches the PR's branch, diffs it against origin/main, finds the originating issue, and runs the code-review skill's two axes (Standards, Spec) against that diff. Prints a risk-category hint when the diff touches an authorization, archive-gate, migration or service-worker path. Use when the user says "review PR 682", "/review-pr 682", or wants a wave's PRs reviewed before merge.
---

# Review a PR

`/code-review` diffs a fixed point against `HEAD`. From the main checkout `HEAD` is `main`, so
pointing it at a PR sees nothing. This skill builds the diff the other way round, from the PR's
branch as it sits on `origin`, and hands it to the same two axes. Nothing is checked out, so the
main checkout is never touched and no worktree is needed.

## Process

### 1. Resolve the PR

```bash
gh pr view <N> --json number,title,state,headRefName,baseRefName,body,url \
  --jq '{number,title,state,head:.headRefName,base:.baseRefName,url,body}'
git fetch origin "<base>" "<head>" --quiet
git diff --stat "origin/<base>...origin/<head>"
```

Stop with a clear message if the PR does not exist, is not open, or the diff is empty. A bad
ref should fail here, not inside two parallel sub-agents.

Capture two commands once and pass them verbatim to every sub-agent. Never `HEAD`:

- diff: `git diff origin/<base>...origin/<head>`
- commits: `git log origin/<base>..origin/<head> --oneline`

### 2. Find the spec

Take the first of these that yields an issue:

1. `Closes #N` / `Fixes #N` / `Resolves #N` in the PR body. This is the convention here. A PR
   without one leaves its issue open and re-dispatchable once the branch is deleted on merge, so
   its absence is itself a finding: report it under Spec.
2. The trailing number on the branch name (`<slug>-<issue>`; two trailing numbers are two issues).
3. `#N` references in the commit messages.

Fetch each with `gh issue view <N> --comments`. If none resolves, the Spec axis reports "no spec
available" rather than guessing.

### 3. Print the risk-category hint

List the changed files. If any match, print one line before dispatching:

| Path or symbol | Category |
|---|---|
| `src/server/guards.ts`, `src/server/club-readable-logic.ts`, `src/server/meeting-authz-logic.ts` | authorization / archive gate |
| `drizzle/`, `src/db/schema.ts` | migration |
| `public/sw.js` | service worker |
| any hunk naming `applySelfAdd` | self-add |

> Risk category touched (<category>). CLAUDE.md's review table says run gstack `/review` in the
> PR's worktree as well. This skill does not replace it.

Paths cannot see an authorization change made in an unrelated file, so a silent hint is not a
clean bill. The categories and the reason each is on the list live in CLAUDE.md's skill-routing
section; this table mirrors it and changes with it.

### 4. Run the two axes

Follow `.claude/skills/code-review/SKILL.md` steps 3 to 5 exactly (the smell baseline, the two
sub-agent briefs, the side-by-side aggregation) with these substitutions:

- The diff command and commit list are the `origin/<base>...origin/<head>` forms from step 1.
- The spec is what step 2 found.
- The Standards sources are CLAUDE.md's **Conventions**, **Data layer** and **Test Coverage**
  sections. There is no `CODING_STANDARDS.md` yet; carving one out of CLAUDE.md is a
  `/session-retro` item, not a prerequisite for reviewing.

### 5. Report

The code-review skill's format: `## Standards`, `## Spec`, one summary line per axis, no
cross-axis ranking. Put the PR number and URL at the top and the risk hint, or its absence,
beneath. Post nothing to GitHub unless asked.
