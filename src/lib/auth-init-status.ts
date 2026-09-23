/**
 * Whether Better Auth finished initializing — readable without touching `#/db`.
 *
 * ## The failure this exists for
 *
 * Since #842 `src/lib/auth.ts` does DATABASE I/O at import: `mcp()`'s `init`
 * seeds a row into `oauth_resource`. If that query fails, three things compound
 * into a silent, total outage:
 *
 * 1. **It is not OAuth-scoped.** `betterAuth()` keeps ONE promise for init and
 *    `auth.handler` awaits it, so a failed seed fails EVERY request — magic-link
 *    sign-in included. Probed against a database carrying `user` and `session`
 *    but no `oauth_resource`: `get-session` throws.
 * 2. **The library's own fallback does not fire.** `seedResources` catches a
 *    missing table by matching `/relation.*does not exist/i` against
 *    `err.message` — but Drizzle wraps it in a `DrizzleQueryError` whose message
 *    is `Failed query: select …` and hangs the real text on `.cause`. So the
 *    "defer the seed to first access" path is unreachable under this adapter.
 * 3. **It never recovers.** The promise is memoized, so creating the table
 *    afterwards does not help. Only a restart clears it.
 *
 * And `/api/health` answered 200 throughout, so Railway's healthcheck had no
 * reason to recycle the container.
 *
 * ## Why a flag rather than awaiting `auth.$context` in the route
 *
 * `src/routes/api/health.ts` is deliberately free of auth and of database
 * access — that is what keeps it green while migrations run and during a
 * database blip, which is the behaviour a LIVENESS probe should have. Importing
 * `#/lib/auth` there to await the promise would drag `#/db` into the one route
 * that must not need it, and would make the probe hang rather than answer when
 * init is stuck.
 *
 * So `src/lib/auth.ts` pushes its verdict here and the route reads it
 * synchronously. The route reports unhealthy ONLY for the unrecoverable case
 * above — a transient database error with a healthy process still answers 200,
 * because this flag is set from the one init promise and nothing else.
 *
 * The coupling worth knowing: this module is inert unless something imports
 * `#/lib/auth`. On the server that is guaranteed — `src/routes/api/auth/$.ts`
 * and `src/server/guards.ts` both do, and Nitro bundles every route at startup.
 */

let initFailure: unknown;

/** Called once by `src/lib/auth.ts` when Better Auth's init promise rejects. */
export function recordAuthInitFailure(error: unknown): void {
	initFailure = error;
}

/**
 * The init error, or `undefined` while init is pending OR after it succeeded.
 *
 * Pending and succeeded are deliberately indistinguishable: both mean "no
 * reason to recycle this container", and a probe that failed during the ~35ms
 * before init resolves would flap on every deploy.
 */
export function authInitFailure(): unknown {
	return initFailure;
}
