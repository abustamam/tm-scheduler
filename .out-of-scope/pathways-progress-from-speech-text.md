# Deriving Pathways progress from the free-text path/project on a speech

We do not build a Pathways progress view by rolling up the `pathway_path` and
`project_name` strings already recorded against each speech. Pathways progress
comes from **explicitly declared enrollments** and **explicit progress marks**,
never from inference over delivered speeches.

This one is worth reading before it gets proposed again, because the data really
is sitting right there and the idea looks free.

## Why this is out of scope

**One delivered speech is not one completed project.** That is the whole
argument, and it is not an edge case.

Base Camp's Level 1 project `Evaluation and Feedback` takes **three**
assignments: give a speech, evaluate another member's speech, then give the same
speech again applying the feedback. Two of the three are speaker slots. Later
levels contain projects that are not speeches at all — leadership projects, and
the mentoring and service work that never appears in a speech log.

The catalog cannot tell you any of this. `CatalogProject` is:

```ts
type CatalogProject = { name: string; level: number; isRequired: boolean };
```

No assignment count, no assignment kinds. So the obvious implementation — match
each speech's free-text project name to a catalog project, mark it complete —
credits a three-assignment project as done after the first speech. `upNext`
filters on a `Set` of win names, so the project then *drops off* the member's
"what's next" list with two assignments still outstanding. The view is wrong in
the direction that hides work, at exactly the moment a member most wants to trust
it.

**It also cannot express a member working ahead.** Delivering Level 2 speeches
while Level 1 awaits approval is ordinary Toastmasters behaviour, and a
derivation that reads completions off speeches has no way to represent "delivered
but not approved."

**And the inputs are free text.** `speeches.pathwayPath` / `speeches.projectName`
are typed into the agenda editor at the moment a speech is scheduled. Three
speeches naming "Presentation Mastery" strongly suggest an enrollment; one typo
mints a phantom path. `resolveSpeechProjects` links them to catalog projects when
both names resolve unambiguously, which is the right amount of trust to place in
them — enough to show on a speech list, not enough to key a progress model.

Two further things the synced view model needs that speeches structurally cannot
supply, which is why "just render the normal view with holes" is not the fallback
either:

- `ringPercent` / `levels` / `currentLevel` come from `path_level_progress` —
  Base Camp's per-level completed/total/approved. Speeches give completions with
  no denominator and no approval, so a ring would be inventing a percentage.
- `upNextElectives` needs `min_req_electives` from `pathways_path_levels`,
  written only by `reconcileCatalog`. Without it there is no "choose N more."

## What we do instead

Explicit declaration, both halves:

- **Manual path enrollment** (#417) — a member or admin declares which path they
  are on, so nothing has to be guessed from strings.
- **Explicit progress marks** (#419) — a member marks a project done, so a
  multi-assignment project is complete when the member says all its assignments
  are, not when one speech named it.

Both are consolidated under **#420**, the live umbrella for Pathways without Base
Camp, which carries these constraints.

This gives a correct answer where derivation gives a plausible one. That trade is
the point: for a progress tracker, a confident wrong number is worse than an
honest gap, because the member cannot tell the two apart.

## What is still fine

Nothing here argues against *showing* the per-speech data. It already reaches the
member's speech list and the dashboard, and that is honest — it says "you gave
this speech and labelled it this project," which is exactly what was recorded.
The line is between displaying a recorded fact and deriving a completion claim
from it.

`PR #401` also stands: it fixed the empty state's copy so it stops implying a
Base Camp sync is pending, and pointed at where the per-speech data does show.
That was the right response to the reporting problem, and it is not what this
file rejects.

## A related bug, already fixed

The same over-credit shipped once, in `buildPathViewModel`'s inference fallback,
live for any club that never synced. It was spun out as **#456** and closed as
completed on 2026-07-30. If a future change reintroduces an inference path, that
is the failure it will reproduce.

## Prior requests

- #402 — "Pathways view for never-synced clubs: roll up the path/project already
  recorded per speech" (split out of #383 / PR #401; closed wontfix 2026-08-31,
  superseded in premise by #419 → #420)
