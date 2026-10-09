---
name: review-pr
description: Review an open pull request by number from the main checkout, with nothing checked out. Fetches the PR's branch, diffs it against origin/main, finds the originating issue, and runs the code-review skill's two axes (Standards, Spec) against that diff. Prints a risk-category hint when the diff touches an authorization, archive-gate, migration or service-worker path, and for a migration that changes data, whether the PR body carries a `## Prod check`. Use when the user says "review PR 682", "/review-pr 682", or wants a wave's PRs reviewed before merge.
---

# Review a PR

`/code-review` diffs a fixed point against `HEAD`. From the main checkout `HEAD` is `main`, so
pointing it at a PR sees nothing. This skill builds the diff the other way round, from the PR's
branch as it sits on `origin`, and hands it to the same two axes. Nothing is checked out, so the
main checkout is never touched and no worktree is needed.

## Process

### 1. Resolve the PR

```bash
gh pr view <N> --json number,title,state,isCrossRepository,headRefName,baseRefName,body,url \
  --jq '{number,title,state,fork:.isCrossRepository,head:.headRefName,base:.baseRefName,url,body}'
git fetch origin "<base>" "<head>" --quiet
git diff --stat "origin/<base>...origin/<head>"
```

Stop with a clear message if the PR does not exist, is not open, comes from a fork
(`isCrossRepository: true`, so its branch is not on `origin` and the fetch above cannot see it;
external PRs are not a review surface here), or the diff is empty. A bad ref should fail here,
not inside two parallel sub-agents.

Capture two commands once and pass them verbatim to every sub-agent. Never `HEAD`:

- diff: `git diff origin/<base>...origin/<head>`
- commits: `git log origin/<base>..origin/<head> --oneline`

### 2. Find the spec

Take the first of these that yields an issue:

1. `Closes #N` / `Fixes #N` / `Resolves #N` in the PR body. This is the convention here. A PR
   without one leaves its issue open and re-dispatchable once the branch is deleted on merge, so
   its absence is itself a finding: report it under Spec. The one exception is a body that says
   the maintainer asked for the work directly with no issue (CLAUDE.md's "Pull requests" allows
   it); then the body's own statement of intent is the spec, and list items 2 and 3 below (the
   issue lookup) are skipped. Step 3, the hint, still runs.
2. The trailing number on the branch name (`<slug>-<issue>`; two trailing numbers are two issues).
3. `#N` references in the commit messages.

Fetch each with `gh issue view <N> --comments`. If none resolves, the Spec axis reports "no spec
available" rather than guessing.

### 3. Print the risk-category hint

List the changed files. If any match, print one line before dispatching:

| Path or symbol | Category |
|---|---|
| `src/lib/auth.ts`, `src/lib/auth-client.ts`, `src/routes/api/auth/` | authentication |
| `src/server/guards.ts`, `src/server/club-readable-logic.ts`, `src/server/meeting-authz-logic.ts` | authorization / archive gate |
| `drizzle/`, `src/db/schema.ts` | migration |
| `public/sw.js` | service worker |
| any hunk under `src/` naming `captureGuestVisit` (documentation that names it does not count) | public PII-minting write |

> Risk category touched (<category>). CLAUDE.md's review table says run gstack `/review` in the
> PR's worktree as well. This skill does not replace it.

Two of CLAUDE.md's six categories have no path: an authorization change can live in any server
module, and a cascading delete is a shape, not a file. So a silent hint is not a clean bill; read
the Spec axis's summary of what the diff does with that in mind. The categories and the reason
each is on the list live in CLAUDE.md's skill-routing section; this table mirrors the ones that
have paths and changes with it.

**A migration that changes data.** When the `drizzle/` row matched, the same hint also says
whether the PR needs a `## Prod check` and has one. A migration applies to prod at container start
and nothing afterwards asks what a data-changing one did there; the contract (what the section
carries, who runs it after the deploy, where the result goes) is in
`docs/agents/data-and-deploy.md`. List the migration SQL the PR adds or changes that contains a
statement writing rows:

```bash
lead="(^|[(),;']|\b(begin|then|else|loop)[[:space:]])[[:space:]]*"
stmt="update([[:space:]]+[^[:space:]]+|[[:space:]]*$)"
stmt="$stmt|delete([[:space:]]+from\b|[[:space:]]*$)"
stmt="$stmt|insert([[:space:]]+into\b|[[:space:]]*$)"
stmt="$stmt|truncate([[:space:]]+[^[:space:]]+|[[:space:]]*$)"
git diff --name-only --diff-filter=AM "origin/<base>...origin/<head>" -- 'drizzle/*.sql' |
  while read -r f; do
    git show "origin/<head>:$f" | grep -v '^[[:space:]]*--' | grep -i -E -q "$lead($stmt)"
    case $? in 0) echo "$f";; 2) echo "grep error: $f";; esac
  done
```

The match is by line, and wide on purpose: a false alarm costs one line, while silence reads as
"DDL only". A statement keyword counts at the start of a line, after `(`, `)`, `,`, `;` or a quote
(so a `WITH` body, a `DO` block and an `EXECUTE '...'` string are seen), or after `BEGIN`, `THEN`,
`ELSE` or `LOOP` (so `DO $$ BEGIN UPDATE ...` on one line is). `UPDATE`, `DELETE` and `INSERT` also
count at the end of a line, for a table name or `FROM` / `INTO` on the next one, and `TRUNCATE`
counts. It can fire on DDL: a foreign key whose `ON` and `UPDATE no action` sit on different lines
is read as an `UPDATE` statement. That false alarm is accepted. A grep is not a SQL parser, so a
statement after any other keyword on its line, or one built by concatenation, is not seen.

It matches a statement, not the bare words, because the words are everywhere. On 2026-10-08 they
appeared in 70 of the repo's 116 migrations, and in 40 of those the only occurrence was a foreign
key's `ON DELETE` / `ON UPDATE`; a statement that writes rows was in 29. A `FOR UPDATE` lock and a
`BEFORE INSERT` trigger event are DDL too, and a comment line never counts.

`case` is there because `grep` exits 2 on a pattern it cannot parse, and that must not read as "no
match": the loop prints `grep error: <file>`. A DDL-only result prints nothing and exits 0.

- **Nothing printed** (DDL only): add no line.
- **A file printed and `body` from step 1 has no line that is exactly `## Prod check`** (trailing
  whitespace allowed; the heading text is the contract, so other wording or another level does
  not count): print one line.

  > Data-changing migration (`<file>`) and the PR body has no `## Prod check` section.
  > `docs/agents/data-and-deploy.md` says what it carries: the read-only SQL to run after the
  > deploy and the result that means "as intended".

- **A file printed and the body has the heading:** print one line saying so, as the reminder that
  the check is owed after the deploy.

  > Data-changing migration (`<file>`); the PR body carries a `## Prod check`. Once the deploy is
  > live the main session runs it and comments the counts on the PR
  > (`docs/agents/data-and-deploy.md`).

`src/test/prod-check-contract.guard.test.ts` runs the command above over fixtures and real
migrations, and holds the heading to the three documents that name it.

### 4. Run the two axes

Follow `.claude/skills/code-review/SKILL.md` steps 3 to 5 exactly (the smell baseline, the two
sub-agent briefs, the side-by-side aggregation) with these substitutions:

- The diff command and commit list are the `origin/<base>...origin/<head>` forms from step 1.
- The spec is what step 2 found. If the PR body lists deviations from that spec, hand them to the
  Spec sub-agent as acknowledged: it checks that the diff is coherent with them, and does not
  report them again as scope creep.
- The Standards source is `CODING_STANDARDS.md` at the repo root, plus the short bullets under
  CLAUDE.md's `## Conventions` (import alias, Biome style, strict TS). Everything longer was moved
  into the standards file on 2026-09-05 so it stops riding in every agent's context.

### 5. Report

The code-review skill's format: `## Standards`, `## Spec`, one summary line per axis, no
cross-axis ranking. Put the PR number and URL at the top and the risk hint (with its
`## Prod check` line, if step 3 printed one), or its absence, beneath. Post nothing to GitHub
unless asked.
