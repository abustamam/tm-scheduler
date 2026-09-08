/**
 * Standalone migration runner for the production container.
 *
 * The Railway runtime image is `node:22-slim` with only `.output/` — no Bun,
 * no drizzle-kit, no `node_modules`. So we bundle this script (with its
 * drizzle-orm + pg deps inlined) to `.output/migrate.mjs` during the build, copy
 * the `drizzle/` SQL into the image, and run it before the server starts
 * (see Dockerfile `CMD`). Drizzle records applied migrations, so reruns on every
 * container boot are fast no-ops; a failed migration exits non-zero so the
 * deploy fails closed instead of serving a stale schema.
 *
 * Run locally with: `bun run scripts/migrate.ts` (uses `.env.local`).
 *
 * ## Why this bounds the lock wait (#684)
 *
 * Migrations apply while the PREVIOUS container is still serving traffic, so
 * every `ALTER TABLE` here competes with live queries. Postgres defaults
 * `lock_timeout` to 0 — wait forever — and a queued `ACCESS EXCLUSIVE` request
 * is granted ahead of the readers that arrive behind it, so one in-flight
 * transaction holding a conflicting lock on a central table (`clubs`, say) is
 * enough to stall every subsequent reader of that table for as long as it
 * lives. Ordinary traffic triggers it, not anything in the migration, and it is
 * invisible in staging where nothing else is connected and the lock is always
 * free. Measured on the pre-fix runner: with `drizzle.__drizzle_migrations`
 * held `ACCESS EXCLUSIVE`, it waited indefinitely and printed nothing.
 *
 * So: bound the WAIT, retry a few times with backoff for the case where the
 * blocker is a short transaction that has since finished, and exit non-zero if
 * the lock still is not free. The Dockerfile `CMD` chains on `&&`, so a
 * non-zero exit aborts the deploy — failing closed on a busy database costs a
 * redeploy instead of an outage.
 *
 * ### The timeout has to be on the migrator's OWN session
 *
 * This uses a single `pg.Client`, not a `Pool`, and that is load-bearing.
 * Drizzle's `NodePgSession.transaction()` calls `pool.connect()` and runs every
 * migration statement on THAT checked-out connection
 * (`node_modules/drizzle-orm/node-postgres/session.js`), while `session.execute()`
 * goes through `pool.query()`. A `SET` issued through the pool can therefore
 * land on a different session than the DDL and silently do nothing — the one
 * way to implement this that looks right and is not. One client is one session,
 * so there is nothing to get wrong. `scripts/migrate.test.ts` locks a table the
 * migration transaction has to touch and proves the wait is bounded.
 *
 * ### `statement_timeout` is deliberately off
 *
 * The bug is unbounded lock WAITING, not long statements. A blanket
 * `statement_timeout` would kill a legitimately slow migration (a large index
 * build, a table rewrite) mid-flight, turning a slow deploy into a failed one.
 * It is available via `MIGRATE_STATEMENT_TIMEOUT_MS` for an operator who wants
 * one — tuned independently of the lock timeout, and it should be generous
 * (minutes, not seconds).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

/**
 * 5s is far longer than any lock this schema's DDL actually needs — the
 * validation scan for an `ADD CONSTRAINT` on `clubs` measures ~10ms per 100k
 * rows — so a wait this long means something else is holding the table, not
 * that the migration is slow. Three attempts with a doubling delay spans ~18s
 * worst case, which covers a request or two finishing without holding a deploy
 * open long enough to matter. Override per deploy for a known-heavy migration.
 */
const DEFAULTS = {
	/** `MIGRATE_LOCK_TIMEOUT_MS` — how long one statement may wait for a lock. */
	lockTimeoutMs: 5_000,
	/** `MIGRATE_LOCK_ATTEMPTS` — total tries, not retries. 1 disables retrying. */
	attempts: 3,
	/** `MIGRATE_LOCK_RETRY_DELAY_MS` — first backoff; doubles each retry. */
	retryDelayMs: 1_000,
	/** `MIGRATE_STATEMENT_TIMEOUT_MS` — 0 leaves the server's own setting alone. */
	statementTimeoutMs: 0,
} as const;

/**
 * Only a transient failure to ACQUIRE a lock is worth retrying. `55P03` is
 * `lock_not_available` (our `lock_timeout` firing) and `40P01` is
 * `deadlock_detected`; both mean "someone else had it", and the next attempt
 * may well succeed. Anything else — a syntax error, a failed constraint — will
 * fail identically every time, so retrying it only delays the failure.
 */
const RETRYABLE_SQLSTATES = new Set(["55P03", "40P01"]);

function envInt(name: string, fallback: number, min: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < min) {
		console.error(`[migrate] ${name}="${raw}" must be an integer >= ${min}`);
		process.exit(1);
	}
	return parsed;
}

/**
 * Drizzle wraps every failed statement in a `DrizzleQueryError` and hangs the
 * pg error off `cause` (`node_modules/drizzle-orm/errors.js`), so the SQLSTATE
 * is NOT on the object you catch. Reading `err.code` directly finds nothing,
 * which makes the retry below dead code that never fires and never says so —
 * measured on the first cut of this fix. Walk the chain.
 */
function sqlState(err: unknown): string | undefined {
	let cursor: unknown = err;
	for (let depth = 0; depth < 5; depth++) {
		if (typeof cursor !== "object" || cursor === null) return undefined;
		const code = (cursor as { code?: unknown }).code;
		if (typeof code === "string") return code;
		cursor = (cursor as { cause?: unknown }).cause;
	}
	return undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const url = process.env.DATABASE_URL;
if (!url) {
	console.error("[migrate] DATABASE_URL is not set");
	process.exit(1);
}

const lockTimeoutMs = envInt("MIGRATE_LOCK_TIMEOUT_MS", DEFAULTS.lockTimeoutMs, 1);
const attempts = envInt("MIGRATE_LOCK_ATTEMPTS", DEFAULTS.attempts, 1);
const retryDelayMs = envInt("MIGRATE_LOCK_RETRY_DELAY_MS", DEFAULTS.retryDelayMs, 0);
const statementTimeoutMs = envInt(
	"MIGRATE_STATEMENT_TIMEOUT_MS",
	DEFAULTS.statementTimeoutMs,
	0,
);

// Printed on every boot: when a deploy does fail closed on a busy database, the
// window it waited is the first thing you need and the last thing you can
// reconstruct afterwards.
console.log(
	`[migrate] lock_timeout=${lockTimeoutMs}ms attempts=${attempts} retry_delay=${retryDelayMs}ms statement_timeout=${
		statementTimeoutMs === 0 ? "server default" : `${statementTimeoutMs}ms`
	}`,
);

let failure: unknown;

for (let attempt = 1; attempt <= attempts; attempt++) {
	// A fresh client per attempt: the previous one's transaction was rolled
	// back by drizzle, but a new session is the cheap way to be sure nothing
	// (an aborted transaction, a changed GUC) survives into the retry.
	const client = new Client({ connectionString: url });
	try {
		await client.connect();
		// `set_config(..., is_local => false)` is session-scoped, so it still
		// applies inside the transaction drizzle opens for the migrations. It
		// takes parameters, which `SET` does not — no interpolation into SQL.
		await client.query("select set_config('lock_timeout', $1, false)", [`${lockTimeoutMs}ms`]);
		if (statementTimeoutMs > 0) {
			await client.query("select set_config('statement_timeout', $1, false)", [
				`${statementTimeoutMs}ms`,
			]);
		}
		await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
		console.log("[migrate] migrations applied");
		failure = undefined;
		break;
	} catch (err) {
		failure = err;
		const code = sqlState(err);
		if (!code || !RETRYABLE_SQLSTATES.has(code) || attempt === attempts) break;
		const delay = retryDelayMs * 2 ** (attempt - 1);
		console.warn(
			`[migrate] attempt ${attempt}/${attempts} could not acquire a lock (SQLSTATE ${code}); retrying in ${delay}ms`,
		);
		await sleep(delay);
	} finally {
		await client.end().catch(() => {});
	}
}

if (failure) {
	const code = sqlState(failure);
	if (code && RETRYABLE_SQLSTATES.has(code)) {
		console.error(
			`[migrate] gave up after ${attempts} attempt(s): no lock within ${lockTimeoutMs}ms (SQLSTATE ${code}). Something else is holding it. Failing the deploy closed beats queueing an ACCESS EXCLUSIVE lock ahead of every reader.`,
		);
	}
	console.error("[migrate] failed:", failure);
	process.exitCode = 1;
}
