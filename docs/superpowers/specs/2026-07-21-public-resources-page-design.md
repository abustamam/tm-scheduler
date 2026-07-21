# Public Resources Page — Design

**Date:** 2026-07-21
**Status:** Approved (brainstorm)
**Issue:** [#310](https://github.com/abustamam/tm-scheduler/issues/310)

## Summary

A public-facing (no-auth) resources area at `/resources` that helps guests,
prospective members, and members understand Toastmasters meetings and run their
roles. Content is authored as markdown; printable role sheets are static,
GavelUp-branded PDFs generated once by a build script and committed to
`public/`.

This replaces the current placeholder resources page at `/_authed/resources`
(mock cards from `src/data/resources.ts` whose "Open" buttons link nowhere) with
a single public page that both guests and signed-in users share.

## Goals

- Public, shareable resource articles covering **generic Toastmasters
  International convention** (not any single club's practice — see #318 for
  per-club content).
- Give members printable, blank role sheets for the five hands-on roles.
- One source of truth (no separate authed vs. public content in v1).
- No Toastmasters International copyrighted material or logos (GavelUp is
  explicitly unaffiliated — see `TOASTMASTERS_DISCLAIMER`).

**Not a goal:** SEO / search ranking. The pages are public and may get indexed,
but we do no sitemap or SEO tuning in v1. Article `<head>` carries only a basic
`title` + `description` (good hygiene for shared links), nothing more.

### Content authorship & accuracy

Claude drafts all six articles' prose against **generic Toastmasters
International convention**; the maintainer **fact-checks every article before
merge**. Because these are public assertions about Toastmasters (timing windows,
the CRC method, what Pathways is), accuracy review is a required gate, not
optional polish.

## Non-Goals (v1)

- Dynamic or pre-filled PDFs (blank forms only).
- Member-gated / role-gated resource content.
- A markdown editing UI / CMS.
- Search over resources.

## v1 Content

Six resources, each its own article:

| Slug                | Title                          | Category | Notes                                        |
| ------------------- | ------------------------------ | -------- | -------------------------------------------- |
| `what-to-expect`    | What to expect at a meeting    | Meeting  | Core. Agenda flow, guest-friendly tone.      |
| `meeting-roles`     | Meeting roles                  | Roles    | Core. Explains each role; hosts the 5 PDFs.  |
| `evaluation-crc`    | How to give a great evaluation | Roles    | Commend–Recommend–Commend method.            |
| `table-topics`      | Table Topics guide             | Meeting  | Impromptu speaking; guest-facing.            |
| `guest-faq`         | First-time guest FAQ           | Meeting  | "Do I have to speak? What do I wear? Cost?"  |
| `what-is-pathways`  | What is Pathways               | Pathways | Short intro to the education program.        |

`meeting-roles` is **one long article** for v1: it enumerates the common
meeting roles (Toastmaster of the Day, General Evaluator, individual Evaluators,
Table Topics Master, Timer, Ah-Counter, Grammarian, Ballot/Vote Counter,
Sergeant at Arms) and provides downloadable sheets for the five hands-on
functionary roles (Timer, Ah-Counter, Grammarian, Ballot/Vote Counter, General
Evaluator). Splitting each role into its own article is a later option, not v1.

## Architecture

### Routes (public — not under `_authed`)

- `src/routes/resources.index.tsx` → `/resources`
  Branded card grid of the six resources (reuses the card visual language from
  the current placeholder page). Each card links to its article. Page footer
  carries `TOASTMASTERS_DISCLAIMER`.
- `src/routes/resources.$slug.tsx` → `/resources/<slug>`
  Renders one article from markdown. Unknown slug → `notFound()` (404).

Both are public. Neither touches `#/db`, so there is no `pg`-in-client-bundle
concern (the guard test in `server-modules.guard.test.ts` is about
`src/server/*` modules and does not apply here).

**Signed-in UX (known v1 limitation).** These public routes render *without* the
`_authed` sidebar shell. A signed-in officer who clicks "Resources" in the app
nav therefore lands on a bare public page. v1 accepts this and gives the public
resources pages their own **lightweight header** (a `BrandMark` linking home) as
the escape hatch. Wrapping public routes in the app shell for authenticated
visitors is an overarching concern tracked separately in
[#317](https://github.com/abustamam/tm-scheduler/issues/317).

### Content model

Metadata in a **typed registry**; prose in **markdown files**. This keeps the
card grid strongly typed and avoids a frontmatter parser (and its Buffer/Node
dependency risk in the client bundle).

- Registry: repurpose `src/data/resources.ts`. Replace the mock array with the
  real six entries. Each entry:

  ```ts
  interface Resource {
    slug: string;              // maps to content/resources/<slug>.md
    title: string;
    desc: string;              // card blurb
    cat: ResourceCategory;     // "Pathways" | "Roles" | "Meeting" | "Officer"
    icon: ResourceIcon;
    tone: ResourceTone;
    downloads?: RoleSheet[];   // present only on meeting-roles
  }

  interface RoleSheet {
    label: string;             // "Timer's log"
    href: string;              // "/role-sheets/timer.pdf" (NOT /resources/* — see below)
  }
  ```

  **Download path is deliberately `/role-sheets/…`, not `/resources/…`.** Serving
  the PDFs from `public/resources/` would put them at `/resources/timer.pdf`,
  which overlaps the dynamic `/resources/$slug` route and risks the SSR route
  swallowing the request (slug `"timer.pdf"` → 404) depending on static-vs-route
  precedence. Serving from `public/role-sheets/` sidesteps the namespace entirely.

- Prose: `content/resources/<slug>.md` (six files). Loaded via Vite:

  ```ts
  const files = import.meta.glob("/content/resources/*.md", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  ```

  This bundles the markdown at build time (SSR + client), so there is no runtime
  `fs` access. A small helper maps `slug → markdown` and is the single lookup
  used by `resources.$slug.tsx`.

### Markdown rendering

- Add dependencies: **`react-markdown`** + **`remark-gfm`** (tables, lists,
  strikethrough). No raw HTML passthrough (default-safe; content is trusted
  repo-authored markdown, but we keep the safe default anyway).
- Styling: a scoped `.prose-gavelup` block in `src/styles.css` — a lean set of
  rules for `h2`/`h3`/`p`/`ul`/`ol`/`li`/`strong`/`a`/`table`/`blockquote`
  using existing brand tokens (`--sea-ink`, `--sea-ink-soft`, `--lagoon-deep`,
  `--line`, …). We do **not** add `@tailwindcss/typography` — the hand-rolled
  block is small and matches the brand exactly.

### Role-sheet PDFs (static, generated once)

- Script: `scripts/build-role-sheets.ts`, using `@react-pdf/renderer`
  (`renderToBuffer` + `createElement as h`, mirroring the pattern in
  `src/server/minutes-pdf-logic.ts` — a `.ts` file, so `createElement` not JSX).
  Writes Letter-size PDFs to `public/role-sheets/`. The generated PDFs are
  committed to the repo (static assets at serve time).
- `package.json` script: `"build:role-sheets": "bun run scripts/build-role-sheets.ts"`.
  Run manually when a sheet changes; not part of the normal build. (The script
  is under `scripts/` and is never imported by a client route.)
- **Regeneration is a documented manual step.** Editing the script means
  re-running `bun run build:role-sheets` and committing the regenerated PDFs.
  There is intentionally **no** CI check that regenerates-and-diffs in v1, so a
  stale committed PDF would not be caught automatically — accepted trade-off.
- Five sheets (all original, blank forms with a GavelUp header and the
  `TOASTMASTERS_DISCLAIMER` in the footer):

  | File                        | Sheet                    | Contents (blank to fill by hand)                                             |
  | --------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
  | `public/role-sheets/timer.pdf`        | Timer's log        | **Standard-windows reference table** printed at top (Ice Breaker 4–6, most speeches 5–7, evaluations 2–3, Table Topics 1–2 min, with green/amber/red = min/mid/max), then **blank** log rows: Speaker/Role · assigned time · actual time · color. The timer fills the windows per assignment rather than one hardcoded row. |
  | `public/role-sheets/ah-counter.pdf`   | Ah-Counter's log   | Speaker columns; tally rows for filler words (um, ah, so, like, and, well, you know) + crutch phrases. |
  | `public/role-sheets/grammarian.pdf`   | Grammarian's log   | Word of the Day box; "good use of language" notes; "language to improve" notes. |
  | `public/role-sheets/ballot-counter.pdf` | Ballot / Vote Counter | Tally grid for Best Speaker / Best Evaluator / Best Table Topics with vote counts. |
  | `public/role-sheets/general-evaluator.pdf` | General Evaluator notes | Sections: meeting flow, timing, evaluators evaluated, environment/sergeant, overall recommendations. |

- Download buttons are rendered by the **route component** (`resources.$slug.tsx`),
  not embedded in the markdown. When the current resource has a `downloads`
  array (only `meeting-roles` does in v1), the component renders a "Printable
  role sheets" block of **Download** buttons after the markdown body. The
  markdown prose can mention the sheets in text, but the actual links come from
  the typed registry so they can't drift from the files on disk.

### Entry points & retiring the mock

- Public landing (`src/routes/index.tsx`): add a **Resources** link in the
  header and/or footer.
- Public club page (`src/routes/club.$clubId.index.tsx`): add a link to
  `/resources`.
- Signed-in app (`src/routes/_authed.tsx`): repoint the existing **Resources**
  nav item to `/resources`.
- Delete `src/routes/_authed/resources.tsx`. Repurpose (not delete)
  `src/data/resources.ts` as the real registry.

### Legal / trademark

- `TOASTMASTERS_DISCLAIMER` (from `src/lib/brand.ts`) appears in the
  `/resources` footer and in every generated PDF footer.
- No TI logos, no TI official documents reproduced. All sheet content is
  original GavelUp wording.

## Testing

- `src/data/resources.guard.test.ts` (or `content/resources.guard.test.ts`):
  - every registry `slug` has a matching `content/resources/<slug>.md` (via the
    same glob);
  - every `downloads[].href` points at a file that exists in
    `public/role-sheets/`.
  This catches drift between registry, markdown, and PDF *existence*. It does
  **not** verify a committed PDF matches current script output (see the manual
  regeneration note above) — that staleness gap is an accepted v1 trade-off.
- A light render smoke test: `resources.$slug` renders a known article's heading
  from markdown (optional; keep minimal).

## Rollout / follow-ups (tracked)

- [#311](https://github.com/abustamam/tm-scheduler/issues/311) — Dynamic,
  club-pre-filled role sheets (name/date header), server-side like minutes PDFs.
- [#312](https://github.com/abustamam/tm-scheduler/issues/312) — Additional
  resources (officer handbook, contest rules, timing color-card reference,
  glossary of TM terms).
- [#313](https://github.com/abustamam/tm-scheduler/issues/313) — Resource
  search / index filtering (port the placeholder's category filter when the
  list grows).
- [#314](https://github.com/abustamam/tm-scheduler/issues/314) — Member-gated
  resources, if any material shouldn't be public.
- [#317](https://github.com/abustamam/tm-scheduler/issues/317) — Keep the app
  shell around public routes for signed-in users (the v1 bare-page limitation).
- [#318](https://github.com/abustamam/tm-scheduler/issues/318) — Per-club
  resources (club-specific agenda order & role set); v1 is generic-only.
- [#319](https://github.com/abustamam/tm-scheduler/issues/319) — Visit/join
  call-to-action on the guest-facing articles.
- Splitting `meeting-roles` into per-role articles if the single page grows
  unwieldy (no ticket yet; noted under v1 Content).

## Open questions

None blocking. Metadata-in-registry (vs. markdown frontmatter) chosen for type
safety and to avoid a client-bundle Buffer dependency; revisit if non-devs need
to edit metadata without touching TS.
