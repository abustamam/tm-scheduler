# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Body conventions `batch:issues` reads

`bun run batch:issues` (see CLAUDE.md's Commands section) parses two things out of an issue
body when planning collision-free waves. Write issues so it can see them, rather than fixing
plans by hand after "NEEDS A FILE PATH" or a dependency violation comes back.

- **Files.** A `## Files` heading (any level — `## Files`, `### Files`, …) marks the section
  listing every path the issue will change; it runs to the next heading at the same level or
  higher. With no such heading, the whole body is scanned instead, which can pick up a path the
  issue only *mentions* rather than one it edits — so add the heading once an issue names more
  than one file.
- **Dependencies.** `blocked by #N`, `depends on #N`, `requires #N`, and `land #N first` all mean
  *this issue must land after #N*; `blocks #N` means the reverse. A bare `#N` elsewhere in the
  body is an ordinary cross-reference and creates no dependency — issues here cite each other
  constantly, and treating every mention as one would serialise most of the backlog.
