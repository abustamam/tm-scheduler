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
# so the runtime image only needs Node + the .output directory.
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Railway injects PORT; Nitro's node-server binds to it on 0.0.0.0.
COPY --from=build /app/.output ./.output
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
