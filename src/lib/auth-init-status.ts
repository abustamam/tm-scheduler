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
 * `#/lib/auth`. At server start that is guaranteed by the nitro startup plugin
 * rather than by route bundling — `src/server/reminder-poller.nitro.ts` →
 * `reminder-poller.ts` → `mcp-pending-logic.ts` → `#/server/guards` →
 * `#/lib/auth` — so init has run, and the flag is settled, before the platform
 * polls the healthcheck.
 */

/**
 * Whether a rejection happened, tracked SEPARATELY from what it carried.
 *
 * Testing the value for truthiness would reintroduce the silent 200 this
 * module exists to remove: `auth.$context` can reject with a falsy reason —
 * `undefined`, `""`, `0`, anything a `throw` of a non-Error produces — and a
 * flag that is just the value would then report healthy on a dead process.
 */
let initFailed = false;
let initFailure: unknown;

/** Called once by `src/lib/auth.ts` when Better Auth's init promise rejects. */
export function recordAuthInitFailure(error: unknown): void {
	initFailed = true;
	initFailure = error;
}

/**
 * Did init fail? `false` while pending OR after success.
 *
 * Pending and succeeded are deliberately indistinguishable: both mean "no
 * reason to recycle this container", and a probe that failed during the ~35ms
 * before init resolves would flap on every deploy.
 */
export function authInitFailed(): boolean {
	return initFailed;
}

/** What it rejected with, for logging. Never the basis of the health decision. */
export function authInitFailure(): unknown {
	return initFailure;
}

/**
 * The healthcheck's answer, decided HERE rather than in the route.
 *
 * `src/routes/api/health.ts` is a `createFileRoute` handler, and a handler body
 * cannot be reached from a test (#544) — so a decision left inline is gated
 * only by source greps, and inverting the ternary satisfies every grep anyone
 * would write while making a healthy container answer 503 on the path
 * `railway.json` names as `healthcheckPath`. No deploy would go live. Putting
 * it here makes both branches executable, and this module still imports
 * nothing, so the route keeps its no-auth, no-DB properties.
 */
export function authHealthResponse(): Response {
	return authInitFailed()
		? new Response("auth init failed", { status: 503 })
		: new Response("ok", { status: 200 });
}

/** Test-only reset. Production has no path that clears the flag. */
export function resetAuthInitStatusForTest(): void {
	initFailed = false;
	initFailure = undefined;
}
