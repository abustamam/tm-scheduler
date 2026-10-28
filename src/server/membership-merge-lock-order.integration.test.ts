/**
 * The membership merge locks are taken in ascending order of their advisory
 * KEY (`hashtext` of the id), not of the id text (#1327). `hashtext` is not
 * injective and does not preserve text order, so two takers ordering by text
 * can invert each other on a hash collision (40P01).
 *
 * The pair below was found with `select hashtext(...)`: LOW sorts before HIGH
 * as text, but its key is the larger one. A blocker holds the SMALLER key
 * (HIGH's). A helper that orders by key parks on it holding nothing; one that
 * orders by text would already hold LOW's lock. The test reads the parked
 * backend's granted advisory locks from `pg_locks`.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { hasTestDb, openBlockingTx, testDb, waitForLockWait } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { lockMembershipsAgainstMerge, lockMembershipsForMerge } = await import(
	"./membership-merge-lock"
);
const { CLUB_BUSY_MESSAGE } = await import("./club-write-lock");

// hashtext(LOW) = 1976659060, hashtext(HIGH) = -415759428: text order and key
// order disagree.
const LOW = "c81e728d-9d4c-2f63-6f06-7f89cc14862c";
const HIGH = "eccbc87e-4b5c-e2fe-2830-8fd9f2a7baf3";

async function parkedHoldsNothingYet(
	take: (tx: Parameters<typeof lockMembershipsForMerge>[0]) => Promise<void>,
) {
	const blocker = await openBlockingTx(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(${0x4d656d62}::int4, hashtext(${HIGH}))`,
		);
	});
	let taker: Promise<unknown> | undefined;
	let granted = -1;
	try {
		taker = testDb.transaction(take);
		taker.catch(() => {});
		const pid = await waitForLockWait("pg_advisory_xact_lock", blocker.pid);
		const res = await testDb.execute(
			sql`select count(*)::int as n from pg_locks where pid = ${pid} and locktype = 'advisory' and granted`,
		);
		granted = Number((res.rows[0] as { n: number }).n);
	} finally {
		await blocker.commit();
	}
	return { granted, taker: taker as Promise<unknown> };
}

describe.skipIf(!hasTestDb)("membership merge lock order (#1327)", () => {
	// protects=the merge's exclusive locks on the keeper and absorbed ids are taken in ascending advisory-key order, so a taker parked on the smaller key holds nothing;
	// fails_when=the helper orders by id text (or any order other than the key): it already holds the larger-text id's lock while parked;
	// no_claim=two ids that share a key (taken once, covered by the distinct in the key query).
	it("the exclusive helper takes the smaller KEY first, not the smaller id text", async () => {
		const { granted, taker } = await parkedHoldsNothingYet((tx) =>
			lockMembershipsForMerge(tx, [LOW, HIGH]),
		);
		await taker;
		expect(granted).toBe(0);
	});

	// protects=a covered writer's shared locks are taken in ascending advisory-key order, the same order as the merge's, so the two cannot invert on a hash collision;
	// fails_when=lockMembershipsAgainstMerge orders by id text again;
	// no_claim=the existence check that follows the locks (covered by the merge-race suite).
	it("the shared helper takes the smaller KEY first, not the smaller id text", async () => {
		const { granted, taker } = await parkedHoldsNothingYet((tx) =>
			lockMembershipsAgainstMerge(tx, [LOW, HIGH]),
		);
		// Neither id is a member, so once past the locks it is refused.
		await expect(taker).rejects.toThrow(CLUB_BUSY_MESSAGE);
		expect(granted).toBe(0);
	});
});
