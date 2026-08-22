# Multi-stage build for the TanStack Start (Nitro node-server) app.
# Railway's auto-detector mistakes this SSR app for a static Vite SPA and tries
# to serve /app/dist (which doesn't exist — Nitro outputs to .output/). This
# Dockerfile makes the build deterministic: build with Bun, run with Node.

# ---- build stage ----
FROM oven/bun:1 AS build
WORKDIR /app

# Install deps against the committed lockfile first (better layer caching).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Build the Nitro node-server output (.output/server/index.mjs).
# The `build` script pins NITRO_PRESET=node-server so the output is Node-runnable
# (building under Bun would otherwise target the Bun runtime, which `node` can't run).
COPY . .
RUN bun run build

# ---- runtime stage ----
# Nitro's node-server output is self-contained (deps are bundled into .output),
# so the runtime image only needs Node + the .output directory. We also copy the
# `drizzle/` migration files: `bun run build` bundles a standalone migrate runner
# (drizzle-orm + pg inlined) to `.output/migrate.mjs`, and the CMD runs it before
# the server so pending migrations apply on every deploy. Drizzle tracks applied
# migrations, so reruns are no-ops; a migration failure exits non-zero and the
# deploy fails closed instead of serving a stale schema.
#
# `.output/seed-catalog.mjs` is bundled the same way and runs between the two
# (#416). It upserts the Pathways catalog, which under #420 is product data
# rather than a mirror: the project picker reads `pathways_projects`, and on a
# club that never runs a Base Camp sync that table is empty unless seeded. It is
# idempotent and never deletes, so re-running each boot is a no-op after the
# first; like migrations, a failure fails the deploy closed.
#
# `.output/seed-templates.mjs` is the third, on the same terms. It seeds the
# global agenda templates, which reached a database only when a human remembered
# to — so production ran two releases with `meeting_templates` empty and the
# "Change meeting type" picker offering clubs nothing. Idempotent: it is keyed on
# `meeting_templates.key` and REPLACES that template's roles and beats, so a
# content change in `src/lib/contest-template.ts` lands on the next deploy.
# Materialized `role_definitions` are deliberately untouched (a club may have
# renamed them); `scripts/resync-template-roles.ts` is the escape hatch for those.
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Railway injects PORT; Nitro's node-server binds to it on 0.0.0.0.
COPY --from=build /app/.output ./.output
COPY --from=build /app/drizzle ./drizzle
EXPOSE 3000
CMD ["sh", "-c", "node .output/migrate.mjs && node .output/seed-catalog.mjs && node .output/seed-templates.mjs && node .output/server/index.mjs"]
