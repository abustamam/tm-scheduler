# TODOS/

Closed to new entries on 2026-09-07. Nothing is added here any more, by anyone.

What replaced it is the three-way rule under "What earns an issue" in `CLAUDE.md`: a finding
inside the files a PR touches is fixed in that PR; a user-visible bug, data loss or security hole
outside the diff is one `needs-triage` issue whose first line says an agent found it; anything else
is one sentence in the PR body and no record. A staging file was the path by which agent
observations became queue items without the maintainer deciding to want them, and the tracker's
own numbers said the sweep never declined anything: 63 issues closed COMPLETED against 2
NOT_PLANNED in the 30 days to 2026-09-07.

## What happens to the files still here

They are the maintainer's to read, once, with one test per item: **would a user notice it, does it
lose data, or is it a hole?** Yes means `gh issue create` with `needs-triage`; no means the line
goes. An agent may draft that list if asked, but files nothing from it on its own. When a file is
empty, `git rm` it; when only this README is left, delete the directory.

`legacy-2026-09.md` is the single `TODOS.md` this directory replaced, frozen on 2026-09-04 with 69
open items. Anything that still says `TODOS.md`, whether a code comment, `CONTEXT.md`, an ADR or
the Dockerfile, means that file.
