# Worktrees, branch naming and landing, in full

Moved verbatim out of `CLAUDE.md` on 2026-10-05 so it stops riding in every session's and every subagent's context on every call (see `docs/agents/token-usage.md`). A code comment citing a CLAUDE.md paragraph by name means the same paragraph here.

## Git worktree isolation (required)

We run many issues in parallel. NEVER edit or commit directly in the main
checkout (on `main` or a local branch) — parallel sessions sharing one
checkout corrupt each other's work. Before any file edit or commit, create
and enter a dedicated git worktree (`git worktree add`). Exceptions:
read-only/inspection tasks, or when the human explicitly says to edit in place.

**Then bootstrap it — this is not optional:**

```bash
bun run worktree:setup "what you are building"
```

A worktree shares git history and nothing else. It starts with no
`node_modules`, no `.env.local`, no `ref/`, and no CodeLedger index — so
`db:*`, `dev` and the seed all fail, and CodeLedger silently returns empty
bundles reporting 0% recall rather than erroring. Four releases shipped from
worktrees on 2026-07-31 with CodeLedger contributing nothing for exactly that
reason. The script is idempotent, so re-run it whenever you are unsure. Pass a
task description to also get a task-scoped bundle; omit it for deps and env
only. Afterwards `git status` should be empty — if it is not, something in the
bootstrap wrote a tracked file and that is a bug worth chasing.

Setup also gives the worktree **its own test database** (#980), `tm_test_wt_<branch>_<hash>` in
`dev-postgres`, schema synced with `db:push --force` and its URL recorded in the gitignored
`.env.test.local`, so parallel worktrees' full suites no longer fail in each other's files.
**Do not export `TEST_DATABASE_URL` in a worktree**: an exported value wins and puts you back on
the shared `tm_test`.
When you are done, **`bun run worktree:teardown`** from inside the worktree drops that database
and removes the worktree. It refuses a dirty or locked worktree before touching anything, drops
only a `tm_test_wt_` database setup recorded, and keeps the branch. Setup likewise refuses to
adopt an existing database it has no record of creating.

### Branch naming — the issue number goes LAST (required)

**`<slug>-<issue>`.** `fix-dialog-scroll-619`, not `fix-619-dialog-scroll` and
not `fix-dialog-scroll`. One branch closing several issues appends both:
`worktree-convert-guard-617-618`.

The name is not decoration — **it is the claim**. `bun run batch:issues` reads
these numbers back off `git worktree list` and off open PRs' `headRefName`, and
holds a claimed issue out of the plan. That is the only signal that exists
during the window duplicate work actually happens in: a worktree claim exists
from the first edit, before anything is pushed, and 7 of the last 10 merged PRs
here (measured 2026-08-31) carried no closing reference in the body at all, so
GitHub's own link could not have covered them.

Three rules, each with a failure behind it:

- **The number is a SUFFIX here.** The upstream this tool was ported from uses
  `fix/<issue>-<slug>` and reads leading tokens; this repo's branches already
  put it last, so `extractIssueNumbersFromRef` reads from the end. Prefixing
  the number instead makes the branch claim NOTHING — it is not an error, the
  issue simply gets handed out again.
- **A thematic name claims nothing, and that is deliberate.** Upstream's
  motivating collision was two sessions building the same fix twelve minutes
  apart, and neither saw the other precisely because both branches were named
  thematically. Do not "fix" this by guessing a number from the slug: holding
  back an issue nobody is working is a worse failure than the one it prevents.
  `sw-prime-on-visit` and `worktree-evaluator-reorder-positional` are real
  branches here that claim nothing.
- **Nothing may follow the number.** Reading stops at the first trailing token
  that is not all digits, so `fix-dialog-scroll-619-wip`, `-619-v2` and
  `-619-retry` all claim NOTHING and the issue gets handed out again. A retry
  needs a different slug, not a suffix. (`…-622a` correctly claims nothing for
  the same reason, which is the behaviour you want there.) The mirror case:
  `…-utf-8` would claim issue #8 — rare, and it only holds back one issue, but
  avoid ending a slug in a bare number that is not an issue.

`EnterWorktree` names the branch after the worktree and prepends `worktree-`,
so `git branch -m <slug>-<issue>` right after creating one is usually the
fastest way to comply.

## Pull requests

- **Title**: conventional-commit style, `fix(agenda): …`, with no version prefix. `VERSION` is
  frozen at `1.32.0.0` and `CHANGELOG.md` stops there; do not bump either. Nothing reads them.
- **Body**: `Closes #N` whenever an issue exists, and it is mandatory then: branches are deleted
  on merge, so a merged PR without it leaves the issue open with no claim on it, and the next
  `batch:issues` hands it out again. Work the maintainer asked for directly in a session may have
  no issue; then the body says so in one line (`Asked for directly; no issue`) and the PR is the
  record. Everything else in the body is optional.
- **A wave agent never merges its own PR.** Merging happens from the main session, after
  `/review-pr`. A wave PR is green against the `main` that existed when its CI ran, and branch
  protection does NOT require it to be up to date before it merges (`strict: false` on `main`,
  required checks `check`, `extension` and `hydration`). So a PR merges on its own green CI, and
  `gh pr update-branch N` is needed only when GitHub reports a real conflict — a migration
  number collision is the usual one, and it surfaces as an ordinary git conflict. What catches a
  cross-PR clash now is **CI on `main` after the merge**: `batch:issues` waves are file-disjoint
  by construction, so the risk left is one PR's change breaking another's through an import, and
  a red `main` run is where that shows. Watch it after a wave lands.
  History, so nobody re-enables it blind: `strict` was `true` from 2026-09-05 to 2026-09-25, and
  was turned off because every landing left the other armed PRs BEHIND, each needing an
  `update-branch` and a full CI rerun, with merges roughly every half hour. A workflow holding a
  PAT to do the updating automatically (#924) was judged overkill and closed. A merge queue would
  do it unattended too, but GitHub offers one only on organization-owned repositories and this
  one is user-owned (the rulesets API returns an empty-reason 422 on a `merge_queue` rule).
  `ci.yml` keeps its `merge_group:` trigger, inert today, so the queue is one setting away if the
  repo ever moves to an org.
- **`--auto` needs the repo's "Allow auto-merge" setting, and its being OFF has no symptom
  until you try to land.** It was off here until 2026-09-07, so the Land step above did not
  work as written: `gh pr merge --squash --auto` fails with `GraphQL: Auto merge is not allowed
  for this repository (enablePullRequestAutoMerge)`, which reads like a permissions problem and
  is not one — it is `allow_auto_merge: false` on the repo, unrelated to `strict` and to
  the org-only merge queue above. Check with
  `gh api repos/abustamam/tm-scheduler --jq '.allow_auto_merge'`; turn it back on with
  `gh api -X PATCH repos/abustamam/tm-scheduler -F allow_auto_merge=true`. Keep it on: arming
  auto-merge is what makes "merges only when green" a mechanism rather than the merger's
  discipline, and `enforce_admins` is `false` here, so a manual `gh pr merge --squash` from an
  admin account can land a PR whose required checks are still pending or failing.
  With `strict` off it does not need to update a stale branch: an armed PR that is merely
  behind `main` merges on green. It still cannot resolve a conflict, which is the one case
  `gh pr update-branch` (or a local merge) is for.
- **Do not pass `--delete-branch`.** `delete_branch_on_merge` is already true on the repo, so
  the remote branch goes on merge; the flag's remaining job is deleting the LOCAL branch, which
  fails while it is checked out in a worktree. Remove the worktree, then the branch.
- **Verify a merge instead of reading `gh pr merge`'s output.** It prints its `✓` confirmation
  only to a TTY, so under an agent's tool call a successful squash-merge prints NOTHING; and per
  the reverse failure, its local-checkout step can print a `fatal` after the merge has already
  landed. Neither silence nor a fatal tells you what happened —
  `gh pr view N --json state,mergeCommit` does.
