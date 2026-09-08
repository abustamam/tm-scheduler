# Triage Labels

The skills speak in terms of five canonical state roles and two category roles. This file maps those roles to the actual label strings used in this repo's issue tracker. `/triage` expects every triaged issue to carry exactly one of each kind.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |
| `bug`                      | `bug`                | Category: something is broken            |
| `enhancement`              | `enhancement`        | Category: new feature or improvement     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## Scheduling labels

One label is neither a state nor a category, and the "exactly one of each kind" rule above does not apply to it. It sits alongside whatever state and category the issue already carries.

| Label       | Meaning                                       |
| ----------- | --------------------------------------------- |
| `migration` | Landing this issue writes a Drizzle migration |

`migration` is read by `bun run batch:issues`, which runs a labelled issue **alone** rather than in a wave: a migration writes to the one `tm_test` database every parallel vitest run shares, so a concurrent agent fails in files it never touched. `isMigrationBearing` (`src/lib/issue-batching.ts`) also treats a cited `drizzle/` path as a signal, but that only fires once the migration is written — an issue *proposing* one has no path to cite, which is why the label carries the weight. Apply it at spec time, not after the fact.

Edit the right-hand column to match whatever vocabulary you actually use.

`ready-for-agent` is the maintainer's label. An agent applies it only when directed (`/spec` output, `/triage`, "move #N to ready-for-agent"), never to an issue it filed from its own observation; those arrive as `needs-triage` plus a category and stay there until the maintainer moves them. See "Who files" in `docs/agents/issue-tracker.md`.
