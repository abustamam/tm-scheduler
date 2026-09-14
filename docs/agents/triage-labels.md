# Triage Labels

Ten labels, and no others.

Every one names a consumer below — a skill, a script, or a documented rule that reads it. That
column is the point of this file. On 2026-09-08 the tracker carried 21 labels and 12 of them were
read by nothing; four had never been applied to any issue at all. They were deleted, which strips
them from the closed issues that carried them and cannot be undone. **Before adding an eleventh
label, name what will read it.** A label nothing reads is a label the maintainer cannot steer by,
and it costs a triage decision every time an issue passes through.

`/triage` expects every triaged issue to carry exactly one STATE label and one CATEGORY label. The
two SCHEDULING labels are neither, and the "exactly one of each kind" rule does not apply to them:
each sits alongside whatever state and category the issue already carries.

| Label             | Kind       | Meaning                                          | Consumer                                                                                  |
| ----------------- | ---------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `needs-triage`    | state      | Maintainer needs to evaluate this issue          | `/triage`; the default state for an agent-filed issue (CLAUDE.md, "What earns an issue")    |
| `needs-info`      | state      | Waiting on reporter for more information         | `/triage`                                                                                   |
| `ready-for-agent` | state      | Fully specified, ready for an AFK agent          | `/spec` output; `bun run batch:issues` — it is the default `--label`, so the plan IS this set |
| `ready-for-human` | state      | Requires human implementation                    | `/triage`; the `/grilling` → `/spec` path in CLAUDE.md's Pipelines                          |
| `wontfix`         | state      | Will not be actioned                             | `/triage`                                                                                   |
| `tracking`        | state      | Umbrella issue; no implementation state applies   | The maintainer's convention. Counts as a state in the health grep below, so an umbrella issue is not reported as untriaged |
| `bug`             | category   | Something is broken                              | `/triage`                                                                                   |
| `enhancement`     | category   | New feature or improvement                       | `/triage`                                                                                   |
| `migration`       | scheduling | Landing this issue writes a Drizzle migration    | `MIGRATION_LABEL` / `isMigrationBearing`, `src/lib/issue-batching.ts`                        |
| `priority`        | scheduling | Blocks the next meeting, or sits on the revenue path | `PRIORITY_LABEL` / `isPriority`, `src/lib/issue-batching.ts`                             |

The label strings here are also the vocabulary the ported skills speak — the seven state and
category names match `mattpocock/skills` one for one. When a skill mentions a role (e.g. "apply the
AFK-ready triage label"), use the corresponding label string from this table.

## Scheduling labels

Both are read by `bun run batch:issues`, and they answer different questions. `migration` says an
issue must run **alone**; `priority` says it must run **first**. An issue can carry both, and the
plan prints both tags on its line.

### `migration` — run alone

A labelled issue is placed serially rather than in a wave: a migration writes to the one `tm_test`
database every parallel vitest run shares, so a concurrent agent fails in files it never touched.
`isMigrationBearing` (`src/lib/issue-batching.ts`) also treats a cited `drizzle/` path as a signal,
but that only fires once the migration is written — an issue *proposing* one has no path to cite,
which is why the label carries the weight. Apply it at spec time, not after the fact.

### `priority` — run first

The planner orders labelled issues ahead of their arrival slot, in the serial section and in the
wave packing alike. It is a **tie-break on order only**: a priority issue that touches a
widely-imported file is still serial, a priority migration still runs alone, and a priority issue
blocked by a non-priority one still lands after its blocker. Going first and going alone are
different questions.

Urgency is not a property of the diff — two issues can cite identical files and one of them be the
only thing standing between the club and its next meeting — so nothing the planner computes can
infer this. It is applied only at the maintainer's direction: `/triage`, `/spec` output, or "mark
#N priority", exactly like `ready-for-agent`. An agent does not apply it to an issue it filed.

There is deliberately no P0-P3 ladder. One boolean is the smallest thing that fixes the measured
failure (on 2026-09-08 arrival order put the one revenue-path issue in wave 2 behind four polish
items); a ladder buys precision the backlog has not asked for and makes every triage a judgement
call about rungs.

## Who applies what

`ready-for-agent` and `priority` are the maintainer's labels. An agent applies either only when
directed (`/spec` output, `/triage`, "move #N to ready-for-agent"), never to an issue it filed from
its own observation; those arrive as `needs-triage` plus a category and stay there until the
maintainer moves them. See "Who files" in `docs/agents/issue-tracker.md`.
