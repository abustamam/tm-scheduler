# Pathways progression model — design

Date: 2026-07-06
Issues: closes #101 (catalog modeling) and #61 (data-driven progress UI).
ADRs referenced: ADR-0008 (person identity), ADR-0009 (speeches first-class). Extends CONTEXT.md "Pathways".

## Summary

Model the Toastmasters Pathways curriculum as first-class reference data (the 11 paths, their
5 levels, and the projects in each), let a **Person** enrol in one or more paths, track
per-project completion (derived from delivered speeches **plus** manual ticks for non-speech
projects), and surface a visual "here's what you need to do to reach your next level" view for
members — plus VPE-facing editing, a roster glance, and a dashboard tile.

The canonical catalog is the "progression path" backbone; the member view is the visual
next-level tracker.

## ⚠️ Prerequisites (hard dependencies)

This feature **cannot be implemented** until both of these land — enrolment is Person-level and
completion derives from Person-owned speeches:

- **#64 — `people` table** (ADR-0008). Nothing to hang an enrolment on until Person identity exists.
- **#79 — `speeches` table** (ADR-0009). Today speech data is free-text `speaker_details` bound
  1:1 to a slot; there is no `person_id` and no durable speech to derive completion from.

The design below assumes `people` and `speeches` exist as ADR-0008/0009 describe. The dependency
chain is: **#64 → #79 → this feature**.

## Decisions locked during brainstorming

- **Catalog depth:** full project catalog — every path → level → named project, including
  required-vs-elective and the per-level "pick N electives" rule.
- **Completion source:** derived from speeches **+** manual. A delivered speech linked to a
  catalog project auto-completes it; non-speech projects (Base Camp activities, surveys,
  evaluations) are ticked manually.
- **Enrolment:** in-app pick (member/VPE selects a path from the catalog) **and** import
  backfill from the Base Camp "Paths Currently in Progress" export.
- **Multi-path in the UI:** tabs / switcher (one path block at a time; no switcher shown when a
  person has a single path).
- **Member view layout:** Option B — a glanceable progress ring for the whole path **plus** a
  focused "Next up → Level N" card that spells out exactly what remains. Contrast: all colors map
  to the app's shadcn/Tailwind design tokens (`primary`, `muted-foreground`, `border`, …), which
  are contrast-tuned for light and dark; no grey-on-grey, no meaning carried by opacity. Targets:
  body/label text ≥ 4.5:1, pills/ring/track ≥ 3:1, verified in both themes.
- **Club-credit:** minimal-but-present (see §Club-credit).
- **Surfaces:** all four — member "my progress" view, member-detail Pathways tab, roster column,
  dashboard hero tile.

## Data model

### Catalog (static reference data — three tables)

The "pick N electives" rule and award-in-order are *level* concepts, so a `levels` row owns them
and `projects` stays a clean leaf.

```
pathways_paths     { id, slug, name, status: 'current' | 'legacy', sort_order }
pathways_levels    { id, path_id → pathways_paths, level int (1–5), title,
                     electives_required int }        -- how many electives this level needs
pathways_projects  { id, level_id → pathways_levels, name,
                     is_required boolean, sort_order }
```

`is_required = false` projects are electives; the owning level's `electives_required` says how
many of them a member must complete.

### Per-member state

```
path_enrollments    { id, person_id → people, path_id → pathways_paths,
                      enrolled_at, archived_at? }     -- Person-level, club-independent
project_completions { id, enrollment_id → path_enrollments, project_id → pathways_projects,
                      completed_at, source: 'speech' | 'manual', speech_id → speeches? (nullable) }
level_completions   { id, enrollment_id → path_enrollments, level int (1–5),
                      completed_at, credited_club_id → clubs }
```

### Speech link (this is #101's payload)

```
speeches.project_id → pathways_projects   -- nullable FK; replaces free-text pathway_path/project_name/project_level
```

Migration off the free-text fields: on the #79 speeches migration (or a follow-up), attempt to
resolve existing `pathway_path`/`project_name`/`project_level` to a catalog project by name;
unmatched values are left null and logged for manual cleanup. The free-text columns are dropped
once the FK is in place.

## Completion logic (all derived — no stored progress status)

Consistent with ADR-0009's "derive, don't store" philosophy:

- A project is **complete** iff a `project_completions` row exists for it under the enrolment.
  - `source = 'speech'`: auto-created when a speech with a non-null `project_id` is **delivered**
    (a past slot references it). Removing/reassigning the speech link removes the derived row.
  - `source = 'manual'`: created by a VPE or the member ticking a non-speech project.
- A level is **completable** when all its `is_required` projects are complete **and**
  `electives_required` electives are complete.
- A level is **awardable** only when every lower level is already awarded (Toastmasters' rule:
  levels award in order even if projects are finished out of order). Awarding writes a
  `level_completions` row (which also captures club credit).
- **"Next up"** for the current level = remaining required projects **+**
  `max(0, electives_required − electives completed)`. Future levels render locked.
- **Path percent** (the ring) = completed projects ÷ total projects in the path (simple, honest;
  refine later if needed).

## Enrolment

- **In-app pick:** member or VPE picks a path from the catalog; creates a `path_enrollments` row.
  A member may hold multiple active enrolments (multi-path).
- **Import backfill:** a Base Camp "Paths Currently in Progress" export bulk-creates enrolments,
  seeds completed levels (`level_completions`) and per-level project counts for existing members,
  mirroring `scripts/import-members.ts`. Person resolution follows ADR-0008 dedupe precedence
  (Customer ID, then email).

## Club-credit (the one club-scoped Pathways concept)

Per CONTEXT.md, a completed **level** is credited to exactly one of the person's clubs. We capture
it minimally: `level_completions.credited_club_id`, defaulting to the current club. A club chooser
is surfaced **only** when the person belongs to 2+ clubs; otherwise it is invisible and auto-set.

## Catalog seeding

No Toastmasters API or machine-readable catalog exists; the official page is HTML-only and the
complete project-by-level breakdowns live in community PDFs. So the catalog is **hand-curated
once**: a checked-in reference file (TS/JSON) of paths → levels → projects, applied by a
`scripts/seed-pathways.ts` runner (idempotent upsert by slug/name). It changes only when
Toastmasters revises Pathways (rare). Source: the community "Pathways Paths and Projects Catalog"
PDF, transcribed and reviewed.

## Surfaces & phasing

Delivered in order, all off the same data:

- **Phase 1 — foundation (closes the modeling half of #101):** catalog tables + seed +
  `speeches.project_id` FK + free-text migration + completion derivation logic. Testable without UI.
- **Phase 2 — core UI (the heart of #61):** enrolment (in-app pick + importer) + the member
  "my progress" view (Option B, with the multi-path tab switcher) + the member-detail Pathways tab
  (level stepper + per-project checkboxes; VPE ticks manual projects, sees the whole path).
- **Phase 3 — glances:** roster Pathway + level-progress column, and the dashboard hero tile
  (ring + "Next up"). Thin reads off Phase 2 data.

## Testing

- **Catalog + completion logic** is plain, DB-touching, and lives in a `*-logic.ts` sibling
  (never imported by client code) so it is unit/integration-testable with the `tm_test` DB — per
  the server-modules bundle-leak guard (`server-modules.guard.test.ts`). Cover: level
  completable/awardable rules, award-in-order enforcement, "next up" computation, electives
  counting, speech-derived vs. manual completion, and the free-text→FK migration resolver.
- **Importer** tested against sample Base Camp export fixtures with the ADR-0008 dedupe rules.

## Out of scope

- Reminders/nudges toward the next project.
- Editing the catalog in-app (it's seeded/committed data).
- Cross-club Pathways analytics.
- Automated Base Camp sync (no API exists; import stays a manual export upload).

## What this closes

- **#101** — resolved by Phase 1: paths/projects become first-class, a speech links by FK, the
  free-text fields are migrated and dropped. The spike becomes a build.
- **#61** — resolved by Phases 2–3: a real data-driven progress model with the progress UI restored.
- Both gated behind **#64** and **#79**.
