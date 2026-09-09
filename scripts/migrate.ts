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
 * ### `lock_timeout` is PER STATEMENT, which is why there is also a budget
 *
 * This is the part that is easy to get wrong, and stating it wrongly in a
 * comment is worse than not stating it: `lock_timeout` bounds ONE statement's
 * wait, not the run. `readMigrationFiles` splits the migration files on
 * `--> statement-breakpoint` and hands drizzle every statement separately —
 * 366 of them today, from 73 files — plus two `CREATE … IF NOT EXISTS` and a
 * `select` before the transaction opens. Every one of those may wait 4999ms and
 * then SUCCEED; only the first to actually time out ends the attempt. So the
 * per-attempt ceiling is not 5s, it is ~366 x 5s ≈ 30 minutes, and three
 * attempts is ~91 minutes. Even ten contended statements is ~123s. The
 * regression suite cannot observe this — a test folder has one pending
 * statement, so its ceiling and its per-statement timeout are the same number.
 *
 * `MIGRATE_BUDGET_MS` is what actually bounds that multiplication: one
 * wall-clock deadline over the entire run, retry sleeps included. When it
 * fires the process exits non-zero immediately, and because drizzle applies all
 * pending migrations inside ONE transaction, the connection dying rolls that
 * transaction back whole — abandoned, never half-applied. That is the
 * difference between this and the `statement_timeout` the issue warns off:
 * this ceiling is measured in minutes and only fires when something is wrong,
 * where a short blanket statement timeout fires on a healthy big index build.
 *
 * Every knob is range-checked (see `LIMITS`) rather than merely parsed, because
 * an unbounded override reinstates exactly the stall this file exists to
 * remove: `MIGRATE_LOCK_ATTEMPTS=20` with an uncapped backoff is 6 days of
 * sleep, and past attempt 23 the delay exceeds 2^31-1 and `setTimeout` fires
 * instantly instead. An out-of-range value is refused loudly, never silently
 * replaced by the default.
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
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

const MIGRATIONS_FOLDER = "./drizzle";

/**
 * Every knob, with the range it is allowed to take. A value outside its range
 * is refused (exit 1) rather than clamped or ignored, so a typo in a Railway
 * variable fails the deploy instead of quietly running with a window nobody
 * chose.
 *
 * `lockTimeoutMs` 5s: far longer than any lock this schema's DDL actually
 * needs — the validation scan for an `ADD CONSTRAINT` on `clubs` measures
 * ~10ms per 100k rows — so a wait that long means something else is holding
 * the table, not that the migration is slow.
 *
 * `budgetMs` 10 minutes: three orders of magnitude above this repo's entire
 * migration history (73 migrations apply to an empty database in ~0.4s), so it
 * can only fire on contention, and its 60-minute ceiling is the most a
 * misconfigured deploy can stall for. Raising it beyond that is a code change,
 * deliberately.
 */
const LIMITS = {
	/** `MIGRATE_LOCK_TIMEOUT_MS` — how long ONE statement may wait for a lock. */
	lockTimeoutMs: { min: 1, max: 60_000, fallback: 5_000 },
	/** `MIGRATE_LOCK_ATTEMPTS` — total tries, not retries. 1 disables retrying. */
	attempts: { min: 1, max: 10, fallback: 3 },
	/** `MIGRATE_LOCK_RETRY_DELAY_MS` — first backoff; doubles, capped below. */
	retryDelayMs: { min: 0, max: 60_000, fallback: 1_000 },
	/** `MIGRATE_STATEMENT_TIMEOUT_MS` — 0 leaves the server's own setting alone. */
	statementTimeoutMs: { min: 0, max: 3_600_000, fallback: 0 },
	/** `MIGRATE_BUDGET_MS` — wall clock for the whole run, sleeps included. */
	budgetMs: { min: 1_000, max: 3_600_000, fallback: 600_000 },
} as const;

/**
 * Ceiling on any single backoff sleep. With `attempts` capped at 10 this holds
 * total sleeping under 4.5 minutes no matter what `retryDelayMs` is set to, and
 * keeps the doubling from ever reaching the 2^31-1 millisecond value where
 * `setTimeout` gives up and fires immediately.
 */
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Only a transient failure to ACQUIRE a lock is worth retrying. `55P03` is
 * `lock_not_available` (our `lock_timeout` firing) and `40P01` is
 * `deadlock_detected`; both mean "someone else had it", and the next attempt
 * may well succeed.
 *
 * `57014` (`query_canceled`, which is what a `statement_timeout` raises) is
 * deliberately NOT here. A statement slow enough to be cancelled will be just
 * as slow on the retry, so retrying it burns the deploy window two more times
 * and fails anyway. Same for everything else — a syntax error, a violated
 * constraint. Only a lock wait is transient.
 */
const RETRYABLE_SQLSTATES = new Set(["55P03", "40P01"]);

function envInt(
	name: string,
	spec: { min: number; max: number; fallback: number },
): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return spec.fallback;
	const parsed = Number(raw);
	// `Number.isInteger` alone accepts "1e21", which is an integer and also
	// 10^21 milliseconds. The range check is what makes the parse safe.
	if (!Number.isSafeInteger(parsed) || parsed < spec.min || parsed > spec.max) {
		console.error(
			`[migrate] ${name}="${raw}" must be an integer between ${spec.min} and ${spec.max}`,
		);
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

/**
 * An empty `_journal.entries` is the one input drizzle accepts and reports
 * SUCCESS for: `readMigrationFiles` returns `[]`, the transaction body iterates
 * nothing, and this script prints "migrations applied" having applied none —
 * a zero exit on a deploy whose schema never moved, which is the failure mode
 * everything else here is arranged to prevent. It is reachable in production
 * without anyone writing bad code: the Dockerfile COPYs `drizzle/` into the
 * runtime image, so a truncated or half-copied journal looks exactly like a
 * healthy no-op boot. A missing folder already throws inside drizzle; an empty
 * one has to be caught here.
 */
function assertMigrationsDeclared(folder: string): void {
	const journalPath = `${folder}/meta/_journal.json`;
	let entries: unknown;
	try {
		const parsed = JSON.parse(readFileSync(journalPath, "utf8")) as {
			entries?: unknown;
		};
		entries = parsed.entries;
	} catch (err) {
		console.error(`[migrate] cannot read ${journalPath}:`, err);
		process.exit(1);
	}
	if (!Array.isArray(entries) || entries.length === 0) {
		console.error(
			`[migrate] ${journalPath} declares no migrations. Refusing to report success on a schema that never moved — check that the image copied ${folder}/.`,
		);
		process.exit(1);
	}
}

const url = process.env.DATABASE_URL;
if (!url) {
	console.error("[migrate] DATABASE_URL is not set");
	process.exit(1);
}

const lockTimeoutMs = envInt("MIGRATE_LOCK_TIMEOUT_MS", LIMITS.lockTimeoutMs);
const attempts = envInt("MIGRATE_LOCK_ATTEMPTS", LIMITS.attempts);
const retryDelayMs = envInt("MIGRATE_LOCK_RETRY_DELAY_MS", LIMITS.retryDelayMs);
const statementTimeoutMs = envInt(
	"MIGRATE_STATEMENT_TIMEOUT_MS",
	LIMITS.statementTimeoutMs,
);
const budgetMs = envInt("MIGRATE_BUDGET_MS", LIMITS.budgetMs);

assertMigrationsDeclared(MIGRATIONS_FOLDER);

// Printed on every boot: when a deploy does fail closed on a busy database, the
// window it waited is the first thing you need and the last thing you can
// reconstruct afterwards.
console.log(
	`[migrate] lock_timeout=${lockTimeoutMs}ms/statement attempts=${attempts} retry_delay=${retryDelayMs}ms budget=${budgetMs}ms statement_timeout=${
		statementTimeoutMs === 0 ? "server default" : `${statementTimeoutMs}ms`
	}`,
);

// The only bound on the per-statement multiplication described above. Exiting
// from the timer is deliberate: it kills the connection, which rolls the
// migration transaction back whole, and it works from inside a query this
// process has no other way to interrupt. Cleared on every exit path below, so
// a healthy run does not sit waiting for it.
const budgetTimer = setTimeout(() => {
	console.error(
		`[migrate] gave up: the ${budgetMs}ms budget (MIGRATE_BUDGET_MS) ran out before migrations finished. lock_timeout is per statement, so a contended run can wait it once per statement — this is the ceiling that stops that becoming an outage. The open transaction rolls back as this process exits.`,
	);
	process.exit(1);
}, budgetMs);

let failure: unknown;

try {
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
			await client.query("select set_config('lock_timeout', $1, false)", [
				`${lockTimeoutMs}ms`,
			]);
			if (statementTimeoutMs > 0) {
				await client.query("select set_config('statement_timeout', $1, false)", [
					`${statementTimeoutMs}ms`,
				]);
			}
			await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
			console.log("[migrate] migrations applied");
			failure = undefined;
			break;
		} catch (err) {
			failure = err;
			const code = sqlState(err);
			if (!code || !RETRYABLE_SQLSTATES.has(code) || attempt === attempts) break;
			const delay = Math.min(
				retryDelayMs * 2 ** (attempt - 1),
				MAX_RETRY_DELAY_MS,
			);
			console.warn(
				`[migrate] attempt ${attempt}/${attempts} could not acquire a lock (SQLSTATE ${code}); retrying in ${delay}ms`,
			);
			await sleep(delay);
		} finally {
			await client.end().catch(() => {});
		}
	}
} finally {
	clearTimeout(budgetTimer);
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
