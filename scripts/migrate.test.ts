/**
 * The startup migration runner's lock behaviour (#684).
 *
 * `scripts/migrate.ts` runs at container boot while the PREVIOUS container is
 * still serving traffic, so its DDL competes with live queries. Before this
 * gate existed the runner set no `lock_timeout`: measured against a database
 * with `drizzle.__drizzle_migrations` held `ACCESS EXCLUSIVE`, it waited
 * indefinitely and printed nothing, and in production a queued `ACCESS
 * EXCLUSIVE` request stalls every reader that arrives behind it.
 *
 * Two things make this testable at all:
 *
 * 1. **The runner is spawned, not imported.** It is a script with top-level
 *    side effects and no entrypoint guard — deliberately, since a guard that
 *    misfires would silently skip migrations on deploy and CI could not tell.
 *    So the tests exercise the real process, and "exits non-zero" is the actual
 *    exit code rather than a stand-in for it.
 *
 * 2. **`migrationsFolder: "./drizzle"` is relative to `cwd`.** Spawning the
 *    runner with `cwd` set to a temp directory containing a two-file `drizzle/`
 *    folder lets a test put an `ALTER TABLE` on a table it controls INSIDE the
 *    migration transaction, which is the only place the contention test is
 *    decisive: drizzle's `NodePgSession.transaction()` runs migration
 *    statements on a connection it checks out itself, so a `lock_timeout` set
 *    on the wrong session would still let this hang. That is the implementation
 *    that looks right and does nothing.
 *
 * Each test gets its own scratch DATABASE, named with a per-run suffix and
 * dropped afterwards, so parallel test files and parallel agents sharing one
 * Postgres never see each other's rows or schema.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasTestDb } from "#/test/db";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUNNER = join(REPO_ROOT, "scripts", "migrate.ts");
const TEST_URL = process.env.TEST_DATABASE_URL ?? "";

/** Per-run so two suites (or two agents) never collide on a database name. */
const SUFFIX = randomBytes(4).toString("hex");

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	/** Wall-clock ms. The whole point of the fix is that this stays bounded. */
	ms: number;
}

function runMigrate(opts: {
	url: string;
	cwd?: string;
	env?: Record<string, string>;
}): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		// Strip any MIGRATE_* the developer happens to have exported, so the
		// defaults this suite pins are the ones in the source.
		const inherited = Object.fromEntries(
			Object.entries(process.env).filter(([k]) => !k.startsWith("MIGRATE_")),
		);
		const started = Date.now();
		// No explicit `stdio`: the default pipes all three, and that overload is
		// the one typed with non-null `stdout`/`stderr`.
		const child = spawn("bun", [RUNNER], {
			cwd: opts.cwd ?? REPO_ROOT,
			env: { ...inherited, DATABASE_URL: opts.url, ...opts.env },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({ code: code ?? -1, stdout, stderr, ms: Date.now() - started });
		});
	});
}

function urlForDatabase(name: string): string {
	const parsed = new URL(TEST_URL);
	parsed.pathname = `/${name}`;
	return parsed.toString();
}

/** One `drizzle/` folder, written where the runner's relative path will find it. */
function writeMigrations(
	dir: string,
	entries: readonly { tag: string; sql: string }[],
): void {
	const folder = join(dir, "drizzle");
	mkdirSync(join(folder, "meta"), { recursive: true });
	writeFileSync(
		join(folder, "meta", "_journal.json"),
		JSON.stringify({
			version: "7",
			dialect: "postgresql",
			entries: entries.map((entry, idx) => ({
				idx,
				version: "7",
				when: 1_700_000_000_000 + idx,
				tag: entry.tag,
				breakpoints: true,
			})),
		}),
	);
	for (const entry of entries) {
		writeFileSync(join(folder, `${entry.tag}.sql`), entry.sql);
	}
}

describe.skipIf(!hasTestDb)("startup migration runner (#684)", () => {
	let admin: Client;
	const scratchDatabases: string[] = [];
	const tempDirs: string[] = [];

	async function createScratchDatabase(label: string): Promise<string> {
		const name = `tm_migrate684_${label}_${SUFFIX}`;
		// Identifier, so it cannot be a bind parameter. It is built from a
		// literal label and a hex suffix, never from anything external.
		await admin.query(`create database "${name}"`);
		scratchDatabases.push(name);
		return urlForDatabase(name);
	}

	function createTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "migrate684-"));
		tempDirs.push(dir);
		return dir;
	}

	beforeAll(async () => {
		admin = new Client({ connectionString: urlForDatabase("postgres") });
		await admin.connect();

		// Reap orphans before creating this run's. The suffix is fresh every run,
		// so a run killed mid-flight (a vitest timeout, a Ctrl-C) leaves its
		// scratch databases behind forever with nothing that would ever name them
		// again. Skipping any database with a live backend keeps this from taking
		// a concurrent run's databases out from under it; an orphan by definition
		// has none. Each drop is independently guarded so losing that race
		// degrades to a leak rather than a failed suite.
		const stale = await admin.query<{ datname: string }>(
			`select d.datname from pg_database d
			 where d.datname like 'tm_migrate684_%'
			   and not exists (select 1 from pg_stat_activity a where a.datname = d.datname)`,
		);
		for (const row of stale.rows) {
			try {
				await admin.query(`drop database if exists "${row.datname}" with (force)`);
			} catch {
				// Raced with another run that just connected. Leave it.
			}
		}
	});

	afterAll(async () => {
		for (const name of scratchDatabases) {
			// FORCE: a test that timed out mid-run can leave the spawned runner
			// or a blocker session still connected.
			await admin.query(`drop database if exists "${name}" with (force)`);
		}
		await admin.end();
		for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	});

	it(
		"applies the committed migrations to a fresh database and reruns as a no-op",
		async () => {
			const url = await createScratchDatabase("fresh");

			const first = await runMigrate({ url });
			expect(first.stderr).not.toContain("[migrate] failed");
			expect(first.code).toBe(0);
			expect(first.stdout).toContain("[migrate] migrations applied");
			// The defaults live in the line every deploy log prints, so pin them
			// here: they are the window a stalled deploy actually gets.
			expect(first.stdout).toContain(
				"[migrate] lock_timeout=5000ms/statement attempts=3 retry_delay=1000ms budget=600000ms statement_timeout=server default",
			);

			const client = new Client({ connectionString: url });
			await client.connect();
			try {
				const applied = await client.query<{ count: number }>(
					"select count(*)::int as count from drizzle.__drizzle_migrations",
				);
				expect(applied.rows[0]?.count).toBeGreaterThan(0);
				const table = await client.query<{ name: string | null }>(
					"select to_regclass('public.clubs')::text as name",
				);
				expect(table.rows[0]?.name).toBe("clubs");
			} finally {
				await client.end();
			}

			const second = await runMigrate({ url });
			expect(second.code).toBe(0);
			expect(second.stdout).toContain("[migrate] migrations applied");
			// "Fast" is half of what the rerun has to be, and an exit code cannot
			// see it. One default lock_timeout is 5s, so a rerun that waited on a
			// lock at all, or re-applied the 73 files, lands outside this.
			expect(second.ms).toBeLessThan(10_000);
			expect(second.stderr).not.toContain("retrying in");
		},
		45_000,
	);

	it(
		"fails fast and non-zero when the migration transaction cannot get its lock",
		async () => {
			const url = await createScratchDatabase("locked");
			const dir = createTempDir();
			writeMigrations(dir, [
				{ tag: "0000_probe", sql: "create table probe (id integer primary key);" },
			]);

			const setup = await runMigrate({ url, cwd: dir });
			expect(setup.code).toBe(0);

			// The pending migration now needs ACCESS EXCLUSIVE on `probe`, and it
			// takes it INSIDE drizzle's migration transaction.
			writeMigrations(dir, [
				{ tag: "0000_probe", sql: "create table probe (id integer primary key);" },
				{ tag: "0001_probe_alter", sql: "alter table probe add column extra integer;" },
			]);

			const blocker = new Client({ connectionString: url });
			await blocker.connect();
			await blocker.query("begin");
			await blocker.query("lock table probe in access exclusive mode");

			let contended: RunResult;
			try {
				contended = await runMigrate({
					url,
					cwd: dir,
					env: {
						MIGRATE_LOCK_TIMEOUT_MS: "400",
						MIGRATE_LOCK_ATTEMPTS: "3",
						MIGRATE_LOCK_RETRY_DELAY_MS: "100",
					},
				});
			} finally {
				await blocker.query("rollback");
				await blocker.end();
			}

			expect(contended.code).toBe(1);
			// 400 + 100 + 400 + 200 + 400 = 1.5s of bounded waiting plus process
			// start-up. Without a lock_timeout this waits forever, so the ceiling
			// is the assertion that matters.
			expect(contended.ms).toBeLessThan(8_000);
			expect(contended.stderr).toContain(
				"[migrate] attempt 1/3 could not acquire a lock (SQLSTATE 55P03)",
			);
			expect(contended.stderr).toContain("[migrate] gave up after 3 attempt(s)");

			// Once the blocker is gone the same pending migration applies, so the
			// failed attempts rolled back cleanly and left nothing half-written.
			const recovered = await runMigrate({ url, cwd: dir });
			expect(recovered.code).toBe(0);

			const client = new Client({ connectionString: url });
			await client.connect();
			try {
				const column = await client.query<{ count: number }>(
					"select count(*)::int as count from information_schema.columns where table_name = 'probe' and column_name = 'extra'",
				);
				expect(column.rows[0]?.count).toBe(1);
			} finally {
				await client.end();
			}
		},
		45_000,
	);

	it(
		"does not retry a failure that is not a lock wait",
		async () => {
			const url = await createScratchDatabase("broken");
			const dir = createTempDir();
			writeMigrations(dir, [
				{ tag: "0000_bad", sql: "create table probe (id integer primary key, oops not_a_real_type);" },
			]);

			const result = await runMigrate({
				url,
				cwd: dir,
				// A retry would sleep 5s and then 10s. If either happens, the
				// elapsed assertion below catches it.
				env: {
					MIGRATE_LOCK_TIMEOUT_MS: "400",
					MIGRATE_LOCK_ATTEMPTS: "3",
					MIGRATE_LOCK_RETRY_DELAY_MS: "5000",
				},
			});

			expect(result.code).toBe(1);
			expect(result.stderr).not.toContain("retrying in");
			expect(result.ms).toBeLessThan(5_000);
		},
		45_000,
	);

	it(
		"stops at the total budget, which is the only bound on a per-statement timeout",
		async () => {
			const url = await createScratchDatabase("budget");
			const dir = createTempDir();
			writeMigrations(dir, [
				{ tag: "0000_probe", sql: "create table probe (id integer primary key);" },
			]);
			expect((await runMigrate({ url, cwd: dir })).code).toBe(0);

			writeMigrations(dir, [
				{ tag: "0000_probe", sql: "create table probe (id integer primary key);" },
				{ tag: "0001_probe_alter", sql: "alter table probe add column extra integer;" },
			]);

			const blocker = new Client({ connectionString: url });
			await blocker.connect();
			await blocker.query("begin");
			await blocker.query("lock table probe in access exclusive mode");

			let result: RunResult;
			try {
				// One attempt, a 60s per-statement window, a 1s budget. Nothing
				// but the budget can end this run: the single statement would
				// wait the full 60s and blow this test's ceiling, and there is no
				// retry sleep to cut short. That is the shape that matters —
				// `lock_timeout` is per statement and a real run has 366 of them,
				// so the only bound on the total is this one.
				result = await runMigrate({
					url,
					cwd: dir,
					env: {
						MIGRATE_LOCK_TIMEOUT_MS: "60000",
						MIGRATE_LOCK_ATTEMPTS: "1",
						MIGRATE_BUDGET_MS: "1000",
					},
				});
			} finally {
				await blocker.query("rollback");
				await blocker.end();
			}

			expect(result.code).toBe(1);
			// Well under the 60s the statement itself was allowed to wait.
			expect(result.ms).toBeLessThan(8_000);
			expect(result.stderr).toContain("budget (MIGRATE_BUDGET_MS) ran out");
			expect(result.stdout).not.toContain("migrations applied");
		},
		45_000,
	);

	it("refuses to report success when the journal declares no migrations", async () => {
		const dir = createTempDir();
		writeMigrations(dir, []);
		// Checked before anything connects, so this needs no scratch database.
		const result = await runMigrate({ url: urlForDatabase("postgres"), cwd: dir });
		expect(result.code).toBe(1);
		expect(result.stdout).not.toContain("migrations applied");
		expect(result.stderr).toContain("declares no migrations");
	});

	it.each([
		["MIGRATE_LOCK_TIMEOUT_MS", "0"],
		["MIGRATE_LOCK_TIMEOUT_MS", "600000"],
		["MIGRATE_LOCK_ATTEMPTS", "20"],
		// An integer by `Number.isInteger`, and also 10^21 milliseconds.
		["MIGRATE_LOCK_RETRY_DELAY_MS", "1e21"],
		["MIGRATE_BUDGET_MS", "86400000"],
	])(
		"refuses %s=%s rather than silently using the default",
		async (name, value) => {
			// Rejected before anything connects, so this needs no scratch database.
			const result = await runMigrate({
				url: urlForDatabase("postgres"),
				env: { [name]: value },
			});
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(name);
			expect(result.stdout).not.toContain("migrations applied");
		},
	);
});
