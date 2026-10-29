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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members, people } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	testDb,
	waitForLockWait,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { lockMembershipsAgainstMerge, lockMembershipsForMerge } = await import(
	"./membership-merge-lock"
);
const { CLUB_BUSY_MESSAGE } = await import("./club-write-lock");
const { mergePeople } = await import("./people-merge-logic");

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

function pgCode(reason: unknown): string | undefined {
	const e = reason as { code?: string; cause?: { code?: string } };
	return e?.code ?? e?.cause?.code;
}

/**
 * `mergePeople` takes the exclusive merge lock of every membership either Person
 * holds BEFORE it locks the Persons (#1388). A speaker claim of the absorbed
 * member, and `scheduleSpeechRequest` for the keeper, both hold the membership's
 * SHARED merge lock and then key-share the Person (the speech insert). With the
 * Persons locked first the merge held the Person and waited on the merge lock
 * while the writer held the merge lock and waited on the Person: 40P01.
 *
 * The writer is a stand-in issuing the same two statements in the same order
 * through the real helper (`lockMembershipsAgainstMerge`, then a `FOR KEY
 * SHARE` of the Person); the merge is the real function.
 */
describe.skipIf(!hasTestDb)(
	"mergePeople lock order vs speech writers (#1388)",
	() => {
		let keeper: SeededClub;
		let other: SeededClub;
		let absorbedPersonId: string;
		let absorbedMemberId: string;
		beforeEach(async () => {
			keeper = await seedClub();
			other = await seedClub();
			const [p] = await testDb
				.insert(people)
				.values({ name: "Merge Absorbed" })
				.returning({ id: people.id });
			if (!p) throw new Error("person insert failed");
			absorbedPersonId = p.id;
			const [m] = await testDb
				.insert(members)
				.values({
					clubId: other.clubId,
					personId: p.id,
					name: "Merge Absorbed",
					clubRole: "member",
					status: "active",
				})
				.returning({ id: members.id });
			if (!m) throw new Error("membership insert failed");
			absorbedMemberId = m.id;
		});
		afterEach(async () => {
			await cleanup(keeper.clubId, [keeper.adminUserId, keeper.memberUserId]);
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		});

		const targets = [
			{ name: "a speaker claim of the absorbed member", side: "absorbed" },
			{ name: "scheduleSpeechRequest for the keeper", side: "keeper" },
		] as const;

		for (const t of targets) {
			const ids = () =>
				t.side === "absorbed"
					? { memberId: absorbedMemberId, personId: absorbedPersonId }
					: { memberId: keeper.memberId, personId: keeper.personId };

			// protects=the merge takes the membership's exclusive merge lock before locking the Persons, so a writer holding the shared lock and wanting the Person is not in a cycle with it;
			// fails_when=mergePeople locks the Persons first (or does not take the merge lock until collapse): one side gets 40P01;
			// no_claim=the writer is a stand-in for claimSlotCore / scheduleSpeechRequest (same statements, same order).
			it(`${t.name}, writer first: neither side deadlocks`, async () => {
				const { memberId, personId } = ids();
				let release!: () => void;
				const gate = new Promise<void>((r) => {
					release = r;
				});
				let holding!: (pid: number) => void;
				const holderPid = new Promise<number>((r) => {
					holding = r;
				});
				const writer = testDb.transaction(async (tx) => {
					const res = await tx.execute(sql`select pg_backend_pid() as pid`);
					await lockMembershipsAgainstMerge(tx, [memberId]);
					holding(Number((res.rows[0] as { pid: number }).pid));
					await gate;
					// The speech insert's FK check on the Person.
					await tx.execute(
						sql`select id from people where id = ${personId} for key share`,
					);
				});
				writer.catch(() => {});
				const pid = await holderPid;

				const merging = mergePeople({
					keeperPersonId: keeper.personId,
					absorbedPersonId,
				});
				merging.catch(() => {});
				// The merge is parked on the writer's shared merge lock, holding no Person.
				await waitForLockWait("pg_advisory_xact_lock", pid);
				release();

				const results = await Promise.allSettled([writer, merging]);
				const codes = results
					.filter((r) => r.status === "rejected")
					.map((r) => pgCode((r as PromiseRejectedResult).reason));
				expect(codes, "40P01 means the merge locks the Persons first").toEqual(
					[],
				);
				expect(results[0]?.status).toBe("fulfilled");
				expect(results[1]?.status).toBe("fulfilled");
			}, 20_000);

			it(`${t.name}, merge first: the writer waits, then is refused or proceeds, never 40P01`, async () => {
				const { memberId, personId } = ids();
				// Park the merge AFTER its merge locks: a blocker holds the keeper's
				// Person, which is the first Person the merge locks (id order is
				// irrelevant, it waits on whichever is held).
				const blocker = await openBlockingTx(async (tx) => {
					await tx.execute(
						sql`select id from people where id = ${keeper.personId} for update`,
					);
				});
				const merging = mergePeople({
					keeperPersonId: keeper.personId,
					absorbedPersonId,
				});
				merging.catch(() => {});
				await waitForLockWait('"people"', blocker.pid);

				const writing = testDb.transaction(async (tx) => {
					await lockMembershipsAgainstMerge(tx, [memberId]);
					await tx.execute(
						sql`select id from people where id = ${personId} for key share`,
					);
				});
				writing.catch(() => {});
				// The writer is parked on the merge's exclusive merge lock.
				const mergePid = await testDb
					.execute(
						sql`select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%"people"%' and ${blocker.pid} = any(pg_blocking_pids(pid)) limit 1`,
					)
					.then((r) => Number((r.rows[0] as { pid: number }).pid));
				await waitForLockWait("pg_advisory_xact_lock_shared", mergePid);
				await blocker.commit();

				const [w, m] = await Promise.allSettled([writing, merging]);
				expect(m.status).toBe("fulfilled");
				if (w.status === "rejected") {
					expect(pgCode(w.reason)).toBeUndefined();
					// The absorbed membership no longer exists: the documented refusal.
					expect((w.reason as Error).message).toBe(CLUB_BUSY_MESSAGE);
					expect(t.side).toBe("absorbed");
				}
			}, 20_000);
		}

		it("refuses with RECORD_CHANGED_MESSAGE when a membership appears under the locks", async () => {
			// A membership of the absorbed Person created by a writer that holds none
			// of the club locks is not in the set read before locking: the re-read
			// must refuse the merge with nothing written.
			const blocker = await openBlockingTx(async (tx) => {
				await tx.execute(
					sql`select pg_advisory_xact_lock(${0x4d656d62}::int4, hashtext(${absorbedMemberId}))`,
				);
			});
			const merging = mergePeople({
				keeperPersonId: keeper.personId,
				absorbedPersonId,
			});
			merging.catch(() => {});
			await waitForLockWait("pg_advisory_xact_lock", blocker.pid);
			// A second membership for the absorbed Person, in the keeper's club
			// (the club write lock is the merge's, but this insert takes none).
			await testDb.insert(members).values({
				clubId: keeper.clubId,
				personId: absorbedPersonId,
				name: "Late Membership",
				clubRole: "member",
				status: "active",
			});
			await blocker.commit();
			await expect(merging).rejects.toThrow();
			const [still] = await testDb
				.select({ id: people.id })
				.from(people)
				.where(sql`${people.id} = ${absorbedPersonId}`);
			expect(still?.id).toBe(absorbedPersonId);
		}, 20_000);
	},
);
