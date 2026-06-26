# Plan 006: Enable rate limiting on the auth endpoints

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0e33f82..HEAD -- src/lib/auth.ts`
> If `src/lib/auth.ts` changed since this plan was written, compare the "Current
> state" excerpt against the live code; on a mismatch, treat it as a STOP
> condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `0e33f82`, 2026-06-26
- **Issue**: not filed — security finding withheld from the public tracker until fixed (operator decision)

## Why this matters

The magic-link sign-in is the only auth path, and the Better-Auth handler
(`src/routes/api/auth/$.ts`) is mounted with **no rate limiting configured**.
Today the magic-link sender is a stub that only `console.log`s (so abuse is
low-impact), but the moment a real email provider is wired (the tracked
pre-launch task, ADR-0004), an unthrottled `POST /api/auth/sign-in/magic-link`
becomes an email-bomb and account-enumeration vector: anyone can trigger
unlimited sign-in emails to arbitrary addresses. Turning on Better-Auth's
built-in rate limiter now — before email goes live — closes that window as a
one-line config change. This is defensive hardening, framed as configuration.

## Current state

`src/lib/auth.ts` (entire file):

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { db } from "#/db";

export const auth = betterAuth({
	database: drizzleAdapter(db, { provider: "pg" }),
	plugins: [
		magicLink({
			sendMagicLink: async ({ email, url }) => {
				console.log(`\n[magic-link] sign-in link for ${email}:\n${url}\n`);
			},
		}),
		tanstackStartCookies(),
	],
});
```

`better-auth` is at `^1.5.3` (`package.json`). Better-Auth ships a built-in rate
limiter configured via a top-level `rateLimit` option on `betterAuth({...})`.
The deployment is a single Node server (ADR-0003), so the default in-memory
limiter store is appropriate (no distributed coordination needed).

Conventions: tabs + double quotes (Biome), strict TS.

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Typecheck | `bunx tsc --noEmit`  | exit 0              |
| Build     | `bun run build`      | exit 0              |
| Lint/fmt  | `bun run check`      | exit 0              |

## Suggested executor toolkit

- **Verify the exact `rateLimit` option shape against the installed Better-Auth
  version before writing it** — read `node_modules/better-auth` types or the
  Better-Auth docs for v1.5.x (search "better-auth rate limit"). The option name
  and sub-fields below are the expected v1.x shape; confirm them. If the API
  differs, follow the installed version's API and note it.

## Scope

**In scope** (modify):
- `src/lib/auth.ts`

**Out of scope** (do NOT touch):
- `src/routes/api/auth/$.ts` — the mount point is fine; rate limiting is
  configured on the `auth` instance, not the route.
- The `sendMagicLink` stub — wiring a real email provider is a *separate*
  pre-launch task (ADR-0004); do not implement email here.
- Any other security hardening (CSP, CORS) — out of scope for this focused change.

## Git workflow

- Branch: `advisor/006-auth-rate-limiting`
- Conventional commit, e.g. `feat: enable Better-Auth rate limiting on auth endpoints`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Confirm the option shape

Read the installed Better-Auth types to confirm the `rateLimit` option and its
fields (`enabled`, `window`, `max`, and per-path `customRules` or equivalent).

### Step 2: Enable rate limiting

Add a `rateLimit` block to the `betterAuth({...})` config. Target shape (adjust
field names to match the verified API):

```ts
export const auth = betterAuth({
	database: drizzleAdapter(db, { provider: "pg" }),
	rateLimit: {
		enabled: true,
		// Sensible global default; tighten the magic-link path specifically.
		window: 60, // seconds
		max: 20,
		customRules: {
			"/sign-in/magic-link": { window: 60, max: 5 },
		},
	},
	plugins: [
		magicLink({
			sendMagicLink: async ({ email, url }) => {
				console.log(`\n[magic-link] sign-in link for ${email}:\n${url}\n`);
			},
		}),
		tanstackStartCookies(),
	],
});
```

The intent: cap magic-link requests to ~5 per minute per client, with a looser
global default for other auth routes. Keep the exact numbers conservative but
functional (a real user requests one link).

Note: Better-Auth's rate limiting is enabled by default only in production in
some versions — set `enabled: true` explicitly so it's on in all environments,
and confirm the limiter store is in-memory (fine for a single Node host).

**Verify**: `bunx tsc --noEmit` → exit 0; `bun run build` → exit 0;
`bun run check` → exit 0.

### Step 3: Smoke-check (manual, optional)

If a dev server + DB are available, run `bun run dev` and POST the magic-link
endpoint more than the configured `max` times in the window; confirm later
requests get a `429`. Document the result; do not commit anything from this step.

## Test plan

- No unit test (this is framework config; the limiter is Better-Auth's own,
  already tested upstream). Verification is type-check + build passing and the
  optional manual 429 smoke check.

## Done criteria

ALL must hold:

- [ ] `src/lib/auth.ts` contains a `rateLimit` config with `enabled: true` and a
      tightened rule for the magic-link path
- [ ] The option shape matches the installed Better-Auth version (verified in Step 1)
- [ ] `bunx tsc --noEmit` exits 0; `bun run build` exits 0; `bun run check` exits 0
- [ ] No files outside `src/lib/auth.ts` are modified (`git status`)
- [ ] `plans/README.md` status row for 006 updated

## STOP conditions

Stop and report (do not improvise) if:
- The installed Better-Auth version has no `rateLimit` option or a materially
  different API than Step 1 expects — report the actual API so the plan can be
  corrected rather than guessing.
- Enabling rate limiting breaks the build or the existing sign-in flow in dev.

## Maintenance notes

- When the real email provider is wired (ADR-0004 pre-launch task), revisit the
  magic-link `max` — too low frustrates legitimate retries, too high re-opens the
  email-bomb risk. 5/min is a starting point.
- The in-memory limiter resets on server restart and isn't shared across
  processes; that's acceptable on the single-host Hetzner target but must be
  reconsidered if the app ever scales horizontally (move to a DB/Redis store).
- Reviewer should confirm `enabled: true` is set explicitly (not relying on the
  prod-only default) so the protection exists in every environment.
