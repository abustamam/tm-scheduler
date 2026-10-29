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
import {
	members,
	people,
	roleDefinitions,
	roleSlots,
	speechRequests,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	type TestTx,
	testDb,
	waitForLockWait,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	lockMembershipsAgainstMerge,
	lockMembershipsForMerge,
	MEMBERSHIP_MERGE_LOCK_NAMESPACE,
	membershipLockKey,
} = await import("./membership-merge-lock");
const { CLUB_BUSY_MESSAGE } = await import("./club-write-lock");
const { mergePeople } = await import("./people-merge-logic");
const { claimSlotCore } = await import("./slots-logic");
const { scheduleSpeechRequest } = await import("./speech-requests-logic");
const { RECORD_CHANGED_MESSAGE } = await import("./guests-logic");
const { isDeadlock } = await import("./pg-errors");

// hashtext(LOW) = 1976659060, hashtext(HIGH) = -415759428: text order and key
// order disagree.
const LOW = "c81e728d-9d4c-2f63-6f06-7f89cc14862c";
const HIGH = "eccbc87e-4b5c-e2fe-2830-8fd9f2a7baf3";

async function parkedHoldsNothingYet(
	take: (tx: Parameters<typeof lockMembershipsForMerge>[0]) => Promise<void>,
) {
	const blocker = await openBlockingTx(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(${MEMBERSHIP_MERGE_LOCK_NAMESPACE}::int4, hashtext(${membershipLockKey(HIGH)}))`,
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

		/** A speaker role with one open slot on the club's seeded meeting. */
		async function openSpeakerSlot(club: SeededClub) {
			const [def] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: club.clubId,
					name: "Prepared Speaker",
					category: "speaker",
					isSpeakerRole: true,
				})
				.returning({ id: roleDefinitions.id });
			if (!def) throw new Error("role definition insert failed");
			const [slot] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: club.meetingId,
					roleDefinitionId: def.id,
					status: "open",
				})
				.returning({ id: roleSlots.id });
			if (!slot) throw new Error("slot insert failed");
			return slot.id;
		}

		const rowLock = (table: string, id: string) => async (tx: TestTx) => {
			await tx.execute(
				sql`select id from ${sql.identifier(table)} where id = ${id} for update`,
			);
		};

		type Writer = {
			name: string;
			side: "absorbed" | "keeper";
			/** Starts the writer's real function. */
			start: () => Promise<unknown>;
			/** Holds the row lock the real writer parks on AFTER its merge lock. */
			hold: (tx: TestTx) => Promise<void>;
			/** What the writer's blocked statement mentions. */
			parkedOn: string;
		};

		/** The real writers: the same functions production calls. */
		async function realWriters(): Promise<Writer[]> {
			const slotId = await openSpeakerSlot(other);
			const keeperSlotId = await openSpeakerSlot(keeper);
			const [request] = await testDb
				.insert(speechRequests)
				.values({
					clubId: keeper.clubId,
					membershipId: keeper.memberId,
					title: "Ice Breaker",
				})
				.returning({ id: speechRequests.id });
			if (!request) throw new Error("request insert failed");
			return [
				{
					name: "claimSlotCore of the absorbed member (speaker role, speech insert)",
					side: "absorbed",
					start: () =>
						testDb.transaction((tx) =>
							claimSlotCore(tx, {
								slotId,
								memberId: absorbedMemberId,
								actorMemberId: absorbedMemberId,
								speakerDetails: { speechTitle: "Real Claim" },
							}),
						),
					hold: rowLock("role_slots", slotId),
					parkedOn: "role_slots",
				},
				{
					name: "scheduleSpeechRequest for the keeper",
					side: "keeper",
					start: () =>
						scheduleSpeechRequest({
							requestId: request.id,
							slotId: keeperSlotId,
							clubId: keeper.clubId,
							actorMemberId: keeper.adminMemberId,
						}),
					hold: rowLock("meetings", keeper.meetingId),
					parkedOn: "meetings",
				},
			];
		}

		/** A stand-in issuing the same two statements through the real helper. */
		function standIn(side: "absorbed" | "keeper"): Writer {
			const memberId = side === "absorbed" ? absorbedMemberId : keeper.memberId;
			const personId = side === "absorbed" ? absorbedPersonId : keeper.personId;
			return {
				name: `a stand-in writer of the ${side} member`,
				side,
				start: () =>
					testDb.transaction(async (tx) => {
						await lockMembershipsAgainstMerge(tx, [memberId]);
						// The row lock a real writer parks on after its merge lock.
						await tx.execute(
							sql`select id from role_slots where id = ${side === "absorbed" ? other.slotId : keeper.slotId} for share`,
						);
						// The speech insert's FK check on the Person.
						await tx.execute(
							sql`select id from people where id = ${personId} for key share`,
						);
					}),
				hold: rowLock(
					"role_slots",
					side === "absorbed" ? other.slotId : keeper.slotId,
				),
				parkedOn: "role_slots",
			};
		}

		const merge = () =>
			mergePeople({ keeperPersonId: keeper.personId, absorbedPersonId });

		/**
		 * The writer starts first and holds its SHARED merge lock, parked on a row
		 * lock a blocker holds; the merge then starts and must wait on that merge
		 * lock holding no Person; the blocker lets go.
		 */
		async function writerFirst(w: Writer) {
			const blocker = await openBlockingTx(w.hold);
			const writing = w.start();
			writing.catch(() => {});
			let results: PromiseSettledResult<unknown>[];
			try {
				const writerPid = await waitForLockWait(w.parkedOn, blocker.pid);
				const merging = merge();
				merging.catch(() => {});
				await waitForLockWait("pg_advisory_xact_lock", writerPid);
				await blocker.commit();
				results = await Promise.allSettled([writing, merging]);
			} finally {
				await blocker.commit().catch(() => {});
			}
			return results;
		}

		/**
		 * The merge starts first and is parked AFTER its merge locks (a blocker
		 * holds the keeper's Person); the writer then arrives and must wait on the
		 * merge lock; the blocker lets go.
		 */
		async function mergeFirst(w: Writer) {
			const blocker = await openBlockingTx(async (tx) => {
				await tx.execute(
					sql`select id from people where id = ${keeper.personId} for update`,
				);
			});
			const merging = merge();
			merging.catch(() => {});
			let results: PromiseSettledResult<unknown>[];
			try {
				const mergePid = await waitForLockWait('"people"', blocker.pid);
				const writing = w.start();
				writing.catch(() => {});
				// The writer is parked on the merge's exclusive merge lock.
				await waitForLockWait("pg_advisory_xact_lock_shared", mergePid);
				await blocker.commit();
				results = await Promise.allSettled([merging, writing]);
			} finally {
				await blocker.commit().catch(() => {});
			}
			return results;
		}

		const expectNoDeadlock = (rs: PromiseSettledResult<unknown>[]) => {
			for (const r of rs) {
				if (r.status === "rejected") {
					expect(isDeadlock(r.reason), String(r.reason)).toBe(false);
				}
			}
		};

		const variants = async () => [
			...(await realWriters()),
			standIn("absorbed"),
			standIn("keeper"),
		];
		// Names only, to register the cases before the fixtures exist.
		const names = [
			"claimSlotCore of the absorbed member (speaker role, speech insert)",
			"scheduleSpeechRequest for the keeper",
			"a stand-in writer of the absorbed member",
			"a stand-in writer of the keeper member",
		];

		for (const [i, name] of names.entries()) {
			// protects=the merge takes the membership's exclusive merge lock before locking the Persons, so a writer holding the shared lock and wanting the Person is not in a cycle with it;
			// fails_when=mergePeople locks the Persons first (or does not take the merge lock until collapse): one side gets 40P01;
			// no_claim=the two stand-in cases issue the same statements as the real writers, not the real functions; the first two call claimSlotCore and scheduleSpeechRequest themselves.
			it(`${name}, writer first: neither side deadlocks and both finish`, async () => {
				const w = (await variants())[i];
				if (!w) throw new Error("no writer");
				const [writing, merging] = await writerFirst(w);
				expectNoDeadlock([writing, merging] as PromiseSettledResult<unknown>[]);
				expect(
					writing?.status,
					String((writing as PromiseRejectedResult).reason),
				).toBe("fulfilled");
				expect(
					merging?.status,
					String((merging as PromiseRejectedResult).reason),
				).toBe("fulfilled");
			}, 30_000);

			it(`${name}, merge first: the writer waits for the merge, then both finish`, async () => {
				const w = (await variants())[i];
				if (!w) throw new Error("no writer");
				const [merging, writing] = await mergeFirst(w);
				expectNoDeadlock([merging, writing] as PromiseSettledResult<unknown>[]);
				expect(merging?.status).toBe("fulfilled");
				// The two Persons sit in different clubs, so no membership is absorbed:
				// the writer waits for the merge, then proceeds on the re-pointed row.
				expect(
					writing?.status,
					String((writing as PromiseRejectedResult).reason),
				).toBe("fulfilled");
			}, 30_000);
		}

		it("refuses with RECORD_CHANGED_MESSAGE when a membership appears under the locks, writing nothing", async () => {
			// A membership of the absorbed Person created by a writer that holds none
			// of the club locks is not in the set read before locking: the re-read
			// must refuse the merge with nothing written.
			const blocker = await openBlockingTx(async (tx) => {
				await tx.execute(
					sql`select pg_advisory_xact_lock(${MEMBERSHIP_MERGE_LOCK_NAMESPACE}::int4, hashtext(${membershipLockKey(absorbedMemberId)}))`,
				);
			});
			const merging = merge();
			merging.catch(() => {});
			let late: string;
			try {
				await waitForLockWait("pg_advisory_xact_lock", blocker.pid);
				// A second membership for the absorbed Person, in the keeper's club
				// (the club write lock is the merge's, but this insert takes none).
				const [row] = await testDb
					.insert(members)
					.values({
						clubId: keeper.clubId,
						personId: absorbedPersonId,
						name: "Late Membership",
						clubRole: "member",
						status: "active",
					})
					.returning({ id: members.id });
				if (!row) throw new Error("late membership insert failed");
				late = row.id;
			} finally {
				await blocker.commit();
			}
			await expect(merging).rejects.toThrow(RECORD_CHANGED_MESSAGE);
			const personOf = async (id: string) =>
				(
					await testDb
						.select({ personId: members.personId })
						.from(members)
						.where(sql`${members.id} = ${id}`)
				)[0]?.personId;
			// Nothing moved: every membership still names the Person it did.
			expect(await personOf(absorbedMemberId)).toBe(absorbedPersonId);
			expect(await personOf(late)).toBe(absorbedPersonId);
			expect(await personOf(keeper.memberId)).toBe(keeper.personId);
			const persons = await testDb
				.select({ id: people.id })
				.from(people)
				.where(sql`${people.id} in (${keeper.personId}, ${absorbedPersonId})`);
			expect(persons).toHaveLength(2);
		}, 20_000);
	},
);
