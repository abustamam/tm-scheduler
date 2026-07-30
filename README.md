# tm-scheduler

A mobile-first web app for scheduling Toastmasters club meetings. Members claim meeting
roles from their phone in one tap; a VP Education / admin creates meetings, which auto-
generate the roles to be filled. It replaces a shared spreadsheet — the wins over the sheet
are at-a-glance "what's still open," one-tap claiming, and automatic role reminders.

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
bun run db:migrate
bun run db:seed

# 4. Run it:
bun run dev          # http://localhost:3000
```

### Signing in

Auth is **magic-link only** (ADR-0004).

**In development**, no email provider is configured — when you request a sign-in
link the URL is **printed to the server console**. Copy it from the terminal
running `bun run dev` and open it.

**In production**, magic links are delivered by **Resend**. Set these env vars
(in the Railway dashboard, per ADR-0007):

| Var | Purpose |
| --- | --- |
| `RESEND_API_KEY` | Resend API key. Its presence switches on real sending. |
| `EMAIL_FROM` | Sender identity. Defaults to `GavelUp <noreply@gavelup.app>`. |

The sending domain (`gavelup.app`) must be verified in Resend (SPF/DKIM DNS
records) before delivery works. Before the domain is verified you can smoke-test
by setting `EMAIL_FROM="onboarding@resend.dev"` (Resend then only delivers to
your own account email).

## Scripts

| Command | What it does |
| --- | --- |
| `bun run dev` | Dev server on port 3000 |
| `bun run build` | Production build (self-contained Node server via Nitro) |
| `bun run check` | Biome lint + format (also `lint` / `format` individually) |
| `bun run test` | Vitest |
| `bun run typecheck` | `tsc --noEmit` — the only thing that type-checks |
| `bun run db:generate` / `db:migrate` | Generate / apply SQL migrations |
| `bun run db:seed` | Seed a sample club, roles, meetings, and members |
| `bun run db:studio` | Browse the DB in Drizzle Studio |
| `bun run db:push` | Sync schema without a migration. For throwaway DBs only — see below |

Run `bun run typecheck` before claiming a change is green. `bun run build` and `bun run test`
both transpile without type-checking, so both pass on type-broken code. CI runs `typecheck` in
the `check` job.

Use `db:migrate`, not `db:push`, on your dev database. It runs automatically as a `predev` step
and via the `.githooks/post-merge` hook, so the dev DB mirrors the migration path production
takes. Mixing in `db:push` diverges the migration-tracking table and breaks replay. Reserve
`db:push` for throwaway or test databases such as `tm_test`.

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
