# Data layer and deployment, in full

Moved verbatim out of `CLAUDE.md` on 2026-10-05 so it stops riding in every session's and every subagent's context on every call (see `docs/agents/token-usage.md`). A code comment citing a CLAUDE.md paragraph by name means the same paragraph here.

## Data layer

Schema is `src/db/schema.ts` — the full domain model (~39 tables): clubs,
people/members (Person vs Membership, ADR-0008), officer_terms, meetings,
role_definitions/role_slots (ADR-0005), meeting_attendance_plan and
meeting_attendance (the PLAN and the RECORD — two tables, never one, see
`CODING_STANDARDS.md`), speeches (ADR-0009), the Pathways model (pathways_paths, path_enrollments,
path_level_progress, pathways_projects, pathways_path_levels,
bcm_project_progress — ADR-0011), sync_tokens, activity_log, club_logos (a
club's own uploaded logo, bytea, ADR-0024 — rendered on the four print
layouts, the projected deck, the `.pptx` export, the Word of the Day poster
and the club role sheets, HTML and PDF), digital voting (`meeting_vote_sessions`
/ `meeting_votes` / `meeting_ballot_guests`, #510, plus
`meeting_candidate_disqualifications`, #723 — see `CONTEXT.md`'s
**Digital vote** and **Disqualification** entries), Club Officer Training (`officer_training_periods` /
`officer_training_records`, #531 — the record behind DCP goal 9; the periods
table is a SPARSE override of TI's own window dates, so **row absent = the
default**, see `CONTEXT.md`'s **Club Officer Training (COT)** entry),
and access requests
(`access_requests` / `access_request_alerts`, #866 — the public request-access form's rows and
its per-reason daily alerts; club-less, delivered to the maintainer by the in-process poller,
ADR-0023, and deleted after 180 days by its sweep). Nothing queues mail to a member: the
`notifications` table and role reminders were removed under ADR-0028, **humans send every
message** (#902). Better-Auth's tables
live in `src/db/auth-schema.ts` — hand-maintained, and since #842 that file also carries the
eight OAuth tables (`jwks` + seven from `@better-auth/mcp`). **Adding a Better Auth plugin
means adding its tables there AND re-exporting them from `schema.ts`**: the Drizzle adapter
resolves a model by export NAME in that namespace, so a missing one is a 500 on a user's
first request with every build gate green. `auth-schema-oauth-tables.guard.test.ts` reads the
expected set off the plugins, not off a list — it caught #842's own issue body naming five
tables where 1.7.5 declares seven. See `CONTEXT.md` for the glossary.
The `db` client (`src/db/index.ts`) is `drizzle(process.env.DATABASE_URL!, { schema })`.
Migrations are generated to `./drizzle` (`drizzle.config.ts`); edit the schema, then
`bun run db:generate` + `bun run db:migrate` (do NOT `db:push` the dev DB — see the `db:migrate`
note above). CI fails if
`schema.ts` drifts from the committed migrations (a generate that produces a diff) and applies
migrations (not `push`) so the migration files are exercised the same way prod runs them.
`drizzle-orm` 0.45.1 has no built-in `bytea` type; `schema.ts` defines one once via `customType`
(`export const bytea`, used by `club_logos.bytes`) — reuse that export, don't redefine it.

The invariants that make this schema safe to touch live in `CODING_STANDARDS.md` ("Data layer"),
which `/review-pr` reads: planned attendance is one table read through one seam, with two exact
floors on what a caller may overwrite or clear; the plan and the record are two tables and roll
mode is the record's only writer; server-fn modules export only `createServerFn`s and types so
`pg` stays out of the client bundle; and the archive gate has four read-side enforcement points
plus a write-side assert, none of which is the route guard. Each has a guard test that fails you
first; the standards file is where the reason lives, and CONTEXT.md holds the glossary entries
they cite.

## Deployment target

**Railway** (managed container PaaS) — see `docs/adr/0007-railway-managed-paas.md` (supersedes
ADR-0003). Push to `main` auto-deploys; env vars are set in the Railway dashboard; Postgres is
Railway's managed plugin (provides `DATABASE_URL`). This keeps the **single Node-server model**:
the Nitro `node-server` build (`.output/server/index.mjs`) and the `node-postgres` pool in
`src/db/index.ts` are unchanged. **Migrations apply at container startup**: `bun run build`
bundles a standalone runner (`scripts/migrate.ts` → `.output/migrate.mjs`, drizzle-orm + pg
inlined), the `drizzle/` SQL is copied into the runtime image, and the Dockerfile `CMD` runs
`node .output/migrate.mjs && node .output/server/index.mjs` so pending migrations apply before
the server serves traffic (drizzle tracks applied migrations, so reruns are no-ops; a migration
failure exits non-zero and the deploy fails closed). The runtime image is `node:22-slim` with no
Bun/drizzle-kit, which is why the runner is bundled rather than invoked via `drizzle-kit migrate`.
Do NOT adopt edge/serverless adapters (Cloudflare Workers / Convex) — the persistent process is
required for the `pg` pool and the in-process poller (ADR-0023), which now delivers request-access
mail and runs the retention sweeps; it sends no reminders (ADR-0028). The Workers + Neon
path stays a deferred future option only.

**Changing a `createServerFn`'s `method` is a BREAKING change for tabs already open**, and
auto-deploy on push is what makes that reachable. A server fn's URL is derived from its file and
export name, not from its body, so the URL is byte-identical across the deploy while the server
now enforces the new verb strictly (405 with an `Allow` header). A client loaded before the
deploy keeps calling the old method against the new server and gets a 405 the router surfaces as
a failed loader — a blank page, not a stale one. #504 flipped `getClubLogoMeta` POST → GET and
handled it by making the last call site `.catch(() => null)` like the other five, so a stale
client degrades to "no logo" instead of blanking club settings. The rule generalises: when you
flip a method, every caller needs a fallback in the SAME change, and a guard test is the only
thing that can hold it — a `createServerFn` cannot be invoked from vitest and call sites
`vi.mock` the module wholesale, so the transport is invisible to the whole suite
(`club-logo-method.guard.test.ts`).
