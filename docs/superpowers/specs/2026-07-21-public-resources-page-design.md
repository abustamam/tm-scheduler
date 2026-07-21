# Public Resources Page — Design

**Date:** 2026-07-21
**Status:** Approved (brainstorm)
**Issue:** TBD (create on plan hand-off)

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

- Public, shareable, SEO-friendly resource articles.
- Give members printable, blank role sheets for the five hands-on roles.
- One source of truth (no separate authed vs. public content in v1).
- No Toastmasters International copyrighted material or logos (GavelUp is
  explicitly unaffiliated — see `TOASTMASTERS_DISCLAIMER`).

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
    href: string;              // "/resources/timer.pdf"
  }
  ```

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
  Writes Letter-size PDFs to `public/resources/`. The generated PDFs are
  committed to the repo (static assets at serve time).
- `package.json` script: `"build:role-sheets": "bun run scripts/build-role-sheets.ts"`.
  Run manually when a sheet changes; not part of the normal build. (The script
  is under `scripts/` and is never imported by a client route.)
- Five sheets (all original, blank forms with a GavelUp header and the
  `TOASTMASTERS_DISCLAIMER` in the footer):

  | File                        | Sheet                    | Contents (blank to fill by hand)                                             |
  | --------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
  | `public/resources/timer.pdf`        | Timer's log        | Rows: Speaker/Role · qualifying (green) · warning (amber) · overtime (red) · actual time. Timing-window reference. |
  | `public/resources/ah-counter.pdf`   | Ah-Counter's log   | Speaker columns; tally rows for filler words (um, ah, so, like, and, well, you know) + crutch phrases. |
  | `public/resources/grammarian.pdf`   | Grammarian's log   | Word of the Day box; "good use of language" notes; "language to improve" notes. |
  | `public/resources/ballot-counter.pdf` | Ballot / Vote Counter | Tally grid for Best Speaker / Best Evaluator / Best Table Topics with vote counts. |
  | `public/resources/general-evaluator.pdf` | General Evaluator notes | Sections: meeting flow, timing, evaluators evaluated, environment/sergeant, overall recommendations. |

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
    `public/resources/`.
  This catches drift between registry, markdown, and PDFs.
- A light render smoke test: `resources.$slug` renders a known article's heading
  from markdown (optional; keep minimal).

## Rollout / follow-ups (create as tickets)

- Dynamic, club-pre-filled role sheets (name/date header) — reuse the
  `@react-pdf/renderer` path server-side, like minutes PDFs.
- Additional resources (officer handbook, contest rules, timing color-card
  reference, glossary of TM terms).
- Resource search / index page filtering (the current placeholder had a
  category filter; port it if the list grows).
- Member-gated resources, if any material shouldn't be public.

## Open questions

None blocking. Metadata-in-registry (vs. markdown frontmatter) chosen for type
safety and to avoid a client-bundle Buffer dependency; revisit if non-devs need
to edit metadata without touching TS.
