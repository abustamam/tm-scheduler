# ADR-0007: Deploy on Railway (managed PaaS) instead of a self-hosted Hetzner VPS

Status: Accepted (supersedes ADR-0003)

## Context

ADR-0003 chose a single Hetzner VPS running Node + Postgres for the MVP, keeping
"Cloudflare Workers (edge) + Neon via Hyperdrive" in reserve as a scale-justified
future option. In practice the deciding factor turned out not to be scale but
**operational cost and maintenance**: the team wants to *push to `main` and have
the app auto-deploy*, set environment variables through a dashboard, and not
babysit a server or a Postgres install. A prior stint on Render worked but got
expensive as always-on web + managed Postgres tiers stacked up.

Three properties of the codebase constrain the choice (see also the reframed #11):

- **Build target** — the app builds a Nitro **Node server** (`node-server` preset,
  output at `.output/server/index.mjs`). Re-targeting a host is a preset/config
  change, not a rewrite — *unless* we go serverless/edge, which changes the model.
- **Database driver** — `src/db/index.ts` uses `drizzle-orm/node-postgres` with a
  long-lived `pg` pool, which wants a **persistent process** (a container), not a
  serverless function (which would need a pooled/HTTP driver).
- **Future reminders poller** — the planned notification poller (#7 / the 010
  design spike) is an **in-process interval**, which needs a long-running process.

A **container PaaS** preserves all three; serverless/edge would force a pooled DB
driver and a cron-based reminder rework. Options weighed: Railway (container PaaS,
native GitHub deploy, managed Postgres), Fly.io + Neon (cheapest, more setup),
Vercel + Neon (best DX/lowest cost but serverless rework).

## Decision

Deploy on **Railway**: the app as a service built from the GitHub repo with
**auto-deploy on push to `main`**, plus Railway's **managed Postgres** plugin.
Environment variables are set in the Railway dashboard / via config. Keep the
**Nitro `node-server` output** and the **`node-postgres` pool** unchanged — no
application-architecture change. Do **not** adopt edge/Workers adapters or a
serverless runtime; the persistent-process model is a deliberate requirement
(it keeps the `pg` pool and the future in-process reminder poller working).

## Consequences

- Push-to-deploy and dashboard-managed env vars; no VPS or Postgres install to
  maintain. Rough cost ~\$5/mo at this app's scale (verify current pricing).
- The single-Node-server model from ADR-0003 is preserved — `src/db/index.ts`,
  the Nitro build, and the #7 poller design are unaffected.
- Required env vars on Railway: `DATABASE_URL` (from the Postgres plugin),
  `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (the Railway public URL). See
  `.env.example`.
- Migrations run on deploy via a Railway pre-deploy/release command
  (`bun run db:migrate`), not `db:push`.
- **Supersedes ADR-0003.** The Cloudflare Workers + Neon/Hyperdrive path remains
  a *documented, deferred* option for a future edge/scale pivot — not chosen now.
- Migration runbook: `plans/012-railway-migration.md`; tracked in issue #11.
- Pin the same Postgres major across dev (Docker) and Railway to avoid drift.
