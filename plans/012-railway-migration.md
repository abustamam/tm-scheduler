# Plan 012: Migrate hosting to Railway (push-to-deploy + managed Postgres)

> **Note**: This is a **provisioning runbook**, not a pure code task. Most steps
> happen in the Railway dashboard / CLI under the operator's account and need
> human credentials and judgment. The only repo change is a small `railway.json`.
> Do NOT invent Railway credentials or provision infrastructure autonomously —
> the human operator drives the account steps; an agent may prepare the
> `railway.json` and verify the build locally.

## Status

- **Priority**: P2
- **Effort**: M (mostly provisioning + verification)
- **Risk**: MED (production hosting change)
- **Depends on**: none (decision recorded in ADR-0007)
- **Category**: dx / migration
- **Planned at**: commit `066e757`, 2026-06-26
- **Issue**: #11 (reframed from the Cloudflare-at-scale spike to this migration)

## Why this matters

ADR-0007 chose **Railway** (managed PaaS) over the self-hosted Hetzner VPS for
push-to-deploy and low maintenance, keeping the single Node-server architecture
intact (Nitro `node-server` output + `node-postgres` pool + the future in-process
reminder poller). This runbook performs that migration: a Railway service that
auto-deploys on push to `main`, a managed Postgres, and dashboard-managed env
vars — with migrations applied on deploy.

## Current state (facts the migration relies on)

- Build: `bun run build` → Nitro **`node-server`** output at
  `.output/server/index.mjs` (the README's old `dist/server/index.mjs` was
  stale and has been corrected). Start: `node .output/server/index.mjs`.
- Nitro's node-server listens on `PORT` (Railway injects `PORT`) — no code change
  needed for binding.
- DB client `src/db/index.ts` reads `process.env.DATABASE_URL` (a `pg` pool).
  Railway's Postgres plugin provides `DATABASE_URL`.
- `drizzle.config.ts` loads `.env.local`/`.env` via dotenv **then** reads
  `process.env.DATABASE_URL` — on Railway the dashboard-injected `DATABASE_URL`
  satisfies it (no `.env.local` needed), so `bun run db:migrate` works in a
  deploy step.
- Package manager **Bun** (`bun.lock` committed) — Railway's Nixpacks builder
  auto-detects Bun.
- Required env vars (`.env.example`): `DATABASE_URL`, `BETTER_AUTH_SECRET`,
  `BETTER_AUTH_URL`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Local prod build | `bun run build` | exit 0, `.output/server/index.mjs` exists |
| Local prod run | `PORT=3000 node .output/server/index.mjs` | server boots, serves on :3000 |
| Migrate (CI/deploy) | `bun run db:migrate` | "migrations applied" against `DATABASE_URL` |

## Steps

### Step 1 (agent, in a PR): add `railway.json` config-as-code

Create `railway.json` at the repo root so build/start/migrate are reproducible
rather than hand-set in the dashboard. **Verify field names against current
Railway docs** (config schema evolves):

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "NIXPACKS",
    "buildCommand": "bun run build"
  },
  "deploy": {
    "startCommand": "node .output/server/index.mjs",
    "preDeployCommand": "bun run db:migrate",
    "healthcheckPath": "/",
    "restartPolicyType": "ON_FAILURE"
  }
}
```

`preDeployCommand` runs `db:migrate` against the injected `DATABASE_URL` before
the new release goes live. **Verify locally first**: `bun run build` then
`PORT=3000 node .output/server/index.mjs` boots and serves. (If `preDeployCommand`
is not a current Railway field, fall back to a release-phase migration per their
docs, or run migrate at container start before the server — STOP and confirm the
approach rather than guessing.)

### Step 2 (human, Railway dashboard): provision

- Create a Railway project; **add the PostgreSQL plugin** (note its major version
  to match dev's Docker Postgres — pin both).
- Create a service **from the GitHub repo**, branch `main`, **auto-deploy on
  push** enabled. Railway picks up `railway.json`.
- Set service env vars:
  - `DATABASE_URL` → reference the plugin: `${{ Postgres.DATABASE_URL }}`
  - `BETTER_AUTH_SECRET` → generate (`bunx @better-auth/cli secret`); store as a secret
  - `BETTER_AUTH_URL` → the service's public URL (e.g. `https://<app>.up.railway.app`)
- Generate/confirm the public domain.

### Step 3 (human): first deploy + verify

- Trigger a deploy (push to `main` or redeploy). Confirm: build succeeds,
  `preDeployCommand` runs migrations, the server starts and the healthcheck
  passes.
- Visit the public URL; load the schedule. Sign-in: magic-link email is **still
  a `console.log` stub** (ADR-0004) — the link prints to **Railway logs**, copy
  it from there to finish sign-in until an email provider is wired.
- Optionally `bun run db:seed` once against the Railway DB (one-off) to create a
  starter club, or create real data.

### Step 4 (human/agent): docs + decommission

- Confirm README/CLAUDE.md (already updated in the ADR-0007 PR) match reality;
  fix the start command/URL if anything differed.
- Decommission any Hetzner box if one was stood up.

## Done criteria

- [ ] `railway.json` committed; `bun run build` + `node .output/server/index.mjs` boot locally
- [ ] Railway service auto-deploys on push to `main`
- [ ] Managed Postgres attached; `DATABASE_URL` referenced; migrations run on deploy
- [ ] `BETTER_AUTH_SECRET` + `BETTER_AUTH_URL` set; app reachable at the public URL; sign-in loop works (link via logs)
- [ ] ADR-0007 reflects the final setup; #11 closed

## STOP conditions

Stop and report (do not improvise) if:
- The Nitro build does not produce `.output/server/index.mjs` or won't boot with `node` (a preset/config issue — surface it, don't hack around it).
- `bun run db:migrate` can't see `DATABASE_URL` in the deploy step (env wiring wrong).
- The `railway.json` schema fields differ from current Railway docs — confirm the correct field before committing.
- Any step needs a credential or a billing decision — that's the operator's call.

## Maintenance notes

- This keeps the persistent-process model; the future #7 reminder poller can run
  in-process as the 010 spike designed (no cron rework needed on Railway).
- If cost ever spikes or true edge scale arrives, the deferred Cloudflare Workers
  + Neon/Hyperdrive path (old ADR-0003 context) is the documented next pivot —
  but that *would* require the serverless DB driver + cron rework noted in
  `docs/design/reminders.md`.
- Keep dev (Docker) and Railway Postgres on the same major version.
