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
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Railway injects PORT; Nitro's node-server binds to it on 0.0.0.0.
COPY --from=build /app/.output ./.output
COPY --from=build /app/drizzle ./drizzle
EXPOSE 3000
CMD ["sh", "-c", "node .output/migrate.mjs && node .output/server/index.mjs"]
