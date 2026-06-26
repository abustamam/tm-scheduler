Guidance for Claude Code working in this repository. This file describes the ACTUAL
stack — follow it over any generic defaults.

## Stack

- **TanStack Start** (React 19, SSR via Nitro), file-based routing under `src/routes/`.
- **Vite** is the bundler/dev server. Use it. Do NOT replace it with Bun.serve or HTML imports.
- **Drizzle ORM** on **PostgreSQL** via `drizzle-orm/node-postgres` (the `pg` driver).
  The db client is exported from `src/db/index.ts`; schema lives in `src/db/schema.ts`.
  Keep using `pg` / node-postgres — do NOT switch to Bun.sql or postgres.js.
- **Better-Auth** for authentication, mounted at `src/routes/api/auth/$.ts`. Magic-link only.
- **TanStack Query** for client data, SSR-integrated (`src/integrations/tanstack-query/`,
  wired as router context in `src/router.tsx`).
- **shadcn/ui** + **Tailwind CSS v4** (config-less, via `@tailwindcss/vite`; styles in
  `src/styles.css`). Add components with `bunx shadcn@latest add <name>` → `src/components/ui`.
  Icons from `lucide-react`.
- **Biome** for lint/format. **Vitest** for tests. **TypeScript strict.**

## Commands

Package manager is **Bun** (use `bun install`, `bun run <script>`).

- `bun run dev` — dev server on port 3000.
- `bun run check` — Biome lint + format gate. (`bun run lint` / `bun run format` individually.)
- `bun run test` — Vitest (uses Vitest, NOT `bun test`).
- `bun run db:generate` — generate Drizzle migrations from `src/db/schema.ts`.
- `bun run db:migrate` — apply migrations. `db:push` for dev sync, `db:studio` to inspect.
- `bun run generate-routes` — regenerate `src/routeTree.gen.ts` (also runs during dev/build).
- `bun run build` — Vite build (Node server output via Nitro).

## Environment

Local env goes in `.env.local` (loaded by `drizzle.config.ts` via dotenv and by the dev script).
Required: `DATABASE_URL` (Postgres connection string), `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`.

## Conventions

- **Import alias:** `#/*` maps to `src/*` (e.g. `import { db } from "#/db"`).
- `src/routeTree.gen.ts` is generated — never edit by hand.
- `src/routes/__root.tsx` is the app shell (providers, devtools).
- API routes use the `server.handlers` pattern (see `src/routes/api/auth/$.ts`).
- Strict TS includes no-unused-locals/params — unused symbols fail the build.

## Deployment target

Single Node server on a Hetzner VPS with Postgres on the same box. Do NOT add Cloudflare
Workers / wrangler, edge adapters, or Convex.
