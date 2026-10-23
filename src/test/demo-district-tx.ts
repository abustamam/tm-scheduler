/**
 * Test-only: run a test body inside ONE open transaction that always rolls
 * back, with `#/db` pointed at it, so a test may own an `is_demo` district
 * without touching the rest of the shared test database.
 *
 * Why. `districts_is_demo_unique` allows one `is_demo` district in the whole
 * database, and the demo rebuild's suite may own it. Files run in parallel
 * against one database, so a second suite that COMMITTED an `is_demo` district
 * would collide with the first. An uncommitted row is invisible to the other
 * suite, and its inserts wait for this transaction to end. Modelled on
 * `demo-club-tx.ts`; read its header for the costs (everything runs on one
 * connection, a nested `db.transaction` is a SAVEPOINT, lock waits cannot be
 * exercised here, a driver spy counts zero statements).
 *
 * Use:
 *   vi.mock("#/db", async () => (await import("#/test/demo-district-tx")).dbMock());
 *   await withDemoDistrict(async ({ tx, districtId }) => { ... });
 * Outside the body `db` is `testDb`, so a suite may use it for its other tests.
 */
import { randomUUID } from "node:crypto";
import { districts } from "#/db/schema";
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

export interface DemoDistrictCtx {
	tx: TestTx;
	districtId: string;
}

/** The transaction type a `withDemoDistrict` body receives. */
export type DemoTx = DemoDistrictCtx["tx"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Kept under vitest's 15s `testTimeout` so this helper's own error fires. */
const SLOT_WAIT_MS = 10_000;

/**
 * Insert the `is_demo` district, run `body`, roll everything back. When the
 * single `is_demo` slot is taken by another suite's committed row, wait and
 * try again.
 */
export async function withDemoDistrict<T>(
	body: (ctx: DemoDistrictCtx) => Promise<T>,
): Promise<T> {
	const deadline = Date.now() + SLOT_WAIT_MS;
	while (Date.now() < deadline) {
		let taken = false;
		let result!: T;
		try {
			await testDb.transaction(async (tx) => {
				const [row] = await tx
					.insert(districts)
					.values({ number: `DEMO-T${randomUUID().slice(0, 8)}`, isDemo: true })
					.onConflictDoNothing()
					.returning({ id: districts.id });
				if (!row) {
					taken = true;
					throw new RollBack();
				}
				holder.current = tx;
				try {
					result = await body({ tx, districtId: row.id });
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
	throw new Error("withDemoDistrict: the single is_demo slot never came free");
}
