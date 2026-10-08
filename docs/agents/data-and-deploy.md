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

## A migration that changes data carries a `## Prod check`

Added 2026-10-08 (#1130); not part of the move above. Migrations apply to prod at container start
(see Deployment target), and nothing afterwards asks what a data-changing one did there. #1109's
migration `0112` rewrote stored `+1` phone rows and its PR body said "NOT checked on prod". The
maintainer read prod a week after the deploy: `phone_extension_backup` existed, so `0112` had
applied, and held 0 rows, so nothing had been rewritten. That was the good outcome, found by luck.
The week 2026-09-30..10-07 shipped ten migrations (`0105` to `0114`); this is the rule that stops
the answer depending on luck.

**When it applies.** A file under `drizzle/` with a statement that writes rows: `UPDATE`,
`DELETE FROM`, `INSERT INTO` or `TRUNCATE`, case-insensitive, comment lines ignored. A migration
that only changes the schema needs no section. The test is a line-based `grep` in `/review-pr`
step 3 (`.claude/skills/review-pr/SKILL.md`), which is the one place that says exactly which
shapes it catches and why it matches a statement rather than the bare words. In short: it is wide
on purpose, so it sees a statement inside a `WITH`, `DO` or `IF ... THEN` body and one inside an
`EXECUTE '...'` string. A foreign key's `ON DELETE` / `ON UPDATE`, a `FOR UPDATE` lock and a
`BEFORE INSERT` trigger event are DDL and do not count. It can still fire on DDL (a foreign key
whose `ON` and `UPDATE no action` sit on different lines is read as an `UPDATE`); that false alarm
is accepted, because a silent hint reads as "DDL only" and a wrong one costs a line. It is a
grep, not a SQL parser: when the hint is silent on SQL that is anything but plain DDL, read it.
`src/test/prod-check-contract.guard.test.ts` runs that command over fixtures and real migrations.

**What the PR carries.** A section headed exactly `## Prod check`. That heading is the contract
between the PR body, this doc and `/review-pr`, so do not reword it. It holds:

- the read-only SQL to run after the deploy is live. Write it to return a count or a boolean, not
  rows: the result is posted on a public repo, so there should be nothing to scrub;
- the result that means "as intended", for example `0 rows`, or `count = N` where N is what the
  dev dry run counted.

**Who runs it, when and how.** The main session runs it once the deploy carrying the migration is
live, alongside its CI-on-`main` watch (`docs/agents/worktrees-and-landing.md`). "Live" is
Railway's deployment status for the merge commit, not a green run on `main`: the migration runs
before the server serves traffic, and a check run before it has applied reads exactly like one
that found nothing to change. The read goes inside the Postgres service, which is the one working
read path (no public TCP proxy, and the Railway MCP returns variable names only):

```bash
railway ssh --service Postgres -- psql -X -c "select count(*) from ..."
```

`psql` there reads its credentials from the service environment, so none are typed or printed.
SELECT only. The auto-mode classifier may refuse the command for an agent; then give the
maintainer the exact line to type instead of working around it.

**Where the result goes.** A comment on the PR, counts and pass/fail only, never row values:

```markdown
**Prod check** (migration 0NNN): pass, count = 0 (expected 0)
```

A result that is not the one the section named is not repaired by hand on prod. Say so on the PR
and put it in the handoff for the maintainer.
