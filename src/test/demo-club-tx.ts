/**
 * Test-only: run a test body inside ONE open transaction that always rolls
 * back, with `#/db` pointed at it, so a test may own an `is_demo` club without
 * touching the rest of the shared test database.
 *
 * Why. `clubs_single_demo_unique` allows one `is_demo` club in the whole
 * database, and `demo-reset-logic.integration.test.ts` owns it: its teardown
 * deletes EVERY `is_demo` row and `resetDemoClub` deletes the existing one. Files
 * run in parallel against one database, so a second suite that committed an
 * `is_demo` club would be deleted mid-test by the first, or make the first fail
 * on the unique index. An uncommitted row is invisible to the other suite's
 * reads and deletes, and its inserts wait for this transaction to end, so the
 * two suites cannot see each other.
 *
 * What it costs. Everything the code under test does runs on this one
 * connection: a `db.transaction` inside it becomes a SAVEPOINT, advisory and row
 * locks are re-entrant, and a lock timeout or a blocked second writer cannot be
 * exercised here. Test those against `testDb` as the other suites do.
 * A spy on the driver (`db.$client`: `statementsDuring`, `readsOf`) counts ZERO
 * statements under `dbMock()`: the proxy hands the transaction's own client, not
 * the pool's, so assert on rows instead of counting queries.
 *
 * The demo advisory lock. `resetDemoClub` takes it, then inserts its own
 * `is_demo` row, which waits behind this transaction's uncommitted row at the
 * unique index. A body that calls `resetDemoClub` waits on the lock in turn: a
 * deadlock. So `withDemoClub` takes the SAME lock (the constants are imported,
 * not copied) before it inserts, and the two serialize on it; the body's own
 * reset re-takes it re-entrantly on this connection.
 *
 * Use:
 *   vi.mock("#/db", async () => (await import("#/test/demo-club-tx")).dbMock());
 *   await withDemoClub(async ({ tx, demoClubId }) => { ... });
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { clubs } from "#/db/schema";
import { type TestTx, testDb } from "./db";

const holder: { current: TestTx | null } = { current: null };

/** The module `#/db` is mocked with: forwards every use to the open
 *  transaction, or to `testDb` when none is open. */
export function dbMock() {
	const db = new Proxy(
		{},
		{
			get(_target, prop) {
				const target = (holder.current ?? testDb) as unknown as Record<
					string | symbol,
					unknown
				>;
				const value = target[prop];
				return typeof value === "function"
					? (value as (...a: unknown[]) => unknown).bind(target)
					: value;
			},
		},
	);
	return { db };
}

class RollBack extends Error {}

export interface DemoClubCtx {
	tx: TestTx;
	demoClubId: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The retry budget, kept under vitest's 15s `testTimeout` so this helper's own
 *  error fires instead of the runner's. */
const SLOT_WAIT_MS = 10_000;

/**
 * Insert the `is_demo` club, run `body`, roll everything back. When the single
 * `is_demo` slot is taken by another suite's committed row, wait and try again.
 */
export async function withDemoClub<T>(
	body: (ctx: DemoClubCtx) => Promise<T>,
): Promise<T> {
	// Dynamic: `demo-reset-logic` imports `#/db`, which a test mocks with
	// `dbMock()` from this file, so a static import would be a cycle.
	const { DEMO_LOCK_KEY, DEMO_LOCK_NAMESPACE } = await import(
		"#/server/demo-reset-logic"
	);
	const deadline = Date.now() + SLOT_WAIT_MS;
	while (Date.now() < deadline) {
		let taken = false;
		let result!: T;
		try {
			await testDb.transaction(async (tx) => {
				await tx.execute(
					sql`select pg_advisory_xact_lock(${DEMO_LOCK_NAMESPACE}::int4, hashtext(${DEMO_LOCK_KEY}))`,
				);
				const [row] = await tx
					.insert(clubs)
					.values({
						name: `Demo Test ${randomUUID().slice(0, 8)}`,
						slug: `demo-1200-${randomUUID()}`,
						isDemo: true,
					})
					.onConflictDoNothing()
					.returning({ id: clubs.id });
				if (!row) {
					taken = true;
					throw new RollBack();
				}
				holder.current = tx;
				try {
					result = await body({ tx, demoClubId: row.id });
				} finally {
					holder.current = null;
				}
				throw new RollBack();
			});
		} catch (err) {
			if (!(err instanceof RollBack)) throw err;
		}
		if (!taken) return result;
		await sleep(50 + Math.random() * 100);
	}
	throw new Error("withDemoClub: the single is_demo slot never came free");
}
