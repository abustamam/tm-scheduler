# tm-scheduler

A mobile-first web app for scheduling Toastmasters club meetings. Members claim meeting
roles from their phone in one tap; a VP Education / admin creates meetings, which auto-
generate the roles to be filled. It replaces a shared spreadsheet — the wins over the sheet
are at-a-glance "what's still open," one-tap claiming, and (soon) automatic reminders.

For the domain model and the reasoning behind the architecture, read `CONTEXT.md` and
`docs/adr/`. Agent/contributor guidance is in `CLAUDE.md`.

## Stack

TanStack Start (React 19, SSR via Nitro) · Drizzle ORM on PostgreSQL · Better-Auth
(magic-link only) · TanStack Query · shadcn/ui + Tailwind v4 · Biome · Vitest. Package
manager: Bun.

## Prerequisites

- [Bun](https://bun.sh)
- A PostgreSQL instance for development (Docker is easiest — see below)

## Setup

```bash
bun install

# 1. Start a dev Postgres (any instance works; Docker example):
docker run -d --name tm-pg -p 5432:5432 \
  -e POSTGRES_USER=dev -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=tm_scheduler \
  postgres:17

# 2. Create .env.local:
cat > .env.local <<'EOF'
DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_scheduler
BETTER_AUTH_URL=http://localhost:3000
EOF
echo "BETTER_AUTH_SECRET=$(bunx @better-auth/cli secret)" >> .env.local

# 3. Apply schema and seed sample data:
bun run db:push
bun run db:seed

# 4. Run it:
bun run dev          # http://localhost:3000
```

### Signing in (dev)

Auth is **magic-link only**. There's no email provider wired in development — when you
request a sign-in link, the URL is **printed to the server console**. Copy it from the
terminal running `bun run dev` and open it. (Wiring a real provider for production is a
tracked pre-launch task; see `docs/adr/0004-magic-link-auth.md`.)

## Scripts

| Command | What it does |
| --- | --- |
| `bun run dev` | Dev server on port 3000 |
| `bun run build` | Production build (self-contained Node server via Nitro) |
| `bun run check` | Biome lint + format (also `lint` / `format` individually) |
| `bun run test` | Vitest |
| `bun run db:push` | Sync schema to the DB (quick dev path) |
| `bun run db:generate` / `db:migrate` | Generate / apply SQL migrations |
| `bun run db:seed` | Seed a sample club, roles, meetings, and members |
| `bun run db:studio` | Browse the DB in Drizzle Studio |

There's no dedicated typecheck script; `bun run build` (or `bunx tsc --noEmit`) surfaces type
errors.

## Project layout

```
src/
├── db/        schema (Drizzle) + client + seed
├── lib/       auth (Better-Auth) + helpers
├── server/    server functions (db access; never imported client-side)
├── routes/    file-based routes; _authed/* require sign-in
└── components/ shadcn/ui
docs/adr/      architecture decision records
CONTEXT.md     domain overview + glossary
```

## Deployment

`bun run build` produces a self-contained Nitro Node server at `.output/server/index.mjs`.

Hosting is **Railway** (managed PaaS) — see `docs/adr/0007-railway-managed-paas.md`. Pushing to
`main` auto-deploys; environment variables (`DATABASE_URL` from the Postgres plugin,
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`) are set in the Railway dashboard; migrations run on
deploy via `bun run db:migrate`. The migration runbook is `plans/012-railway-migration.md`.
Pin the same Postgres major in dev (Docker) and on Railway.

To run the production build locally:

```bash
bun run build
node .output/server/index.mjs
```
