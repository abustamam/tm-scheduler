# TODOS/

Deferred debt, one file per branch, deleted when done.

GitHub issues are the canonical tracker (`abustamam/tm-scheduler`, via `gh`; see
`docs/agents/issue-tracker.md`). This directory is for what is not worth an issue yet: a
follow-up noticed mid-branch, a piece deliberately deferred from the thing being built.

## The file

`TODOS/<branch-name>.md`, named for the branch you noticed it on, so
`TODOS/table-topics-limits-679.md`. The branch name already carries the issue number when there is
one, both numbers when one branch closes two, and a meaningful slug when there is none. Several
items per file is normal. One bullet per item; a `**Priority:**` (P0 to P4) line helps the sweep
and costs a few words.

Why per branch rather than one file: two wave agents appending under the same heading of a single
`TODOS.md` conflict at merge, and for 25 releases in a row that file was in every diff.

## The lifecycle

A file lives until the sweep says otherwise. The sweep runs at two moments:

- the weekly `/retro`;
- whenever `bun run batch:issues` comes back with nothing to plan.

For each file: **promote** an item to an issue if it is a bug a user can hit or work you would
schedule (`gh issue create`, with a `## Files` section so `batch:issues` can plan it); **drop** it
if it is not; **leave** it with a date if it is neither yet. When a file has nothing left, `git rm`
it. There is no completed log. Git history and the closed issue are the record.

## `legacy-2026-09.md`

The single `TODOS.md` this directory replaced, frozen on 2026-09-04 with 69 open items. It is swept
on the same schedule as everything else until it is empty, then deleted. Anything that still says
`TODOS.md`, whether a code comment, `CONTEXT.md`, an ADR or the Dockerfile, means this file.
