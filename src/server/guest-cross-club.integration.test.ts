/**
 * An officer of two clubs adds a guest to another club, or separates a guest
 * from the Person other clubs share (#1127, ADR-0031), against a real database.
 *
 * The claims, each stated in the terms of what a reader of the data sees:
 * - Add puts a `prospect` row on the SAME Person in the other club and leaves
 *   this club's row alone; two sessions adding the same Person yield one row.
 * - Separate gives the guest a fresh Person, copying contact only from a
 *   guest-only Person.
 * - Every action is refused for a user who is not an admin of the clubs it names,
 *   in both directions, before and again after the locks.
 *
 * `#/db` is mocked to the TEST_DATABASE_URL client; the suite skips without it.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guests, members, officerTerms, people, user } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
	waitForLockWait,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { CLUB_BUSY_MESSAGE, CLUB_WRITE_LOCK_NAMESPACE } = await import(
	"#/server/club-write-lock"
);
const { NO_PERMISSION_MESSAGE, NOT_A_MEMBER_MESSAGE } = await import(
	"#/server/guards"
);
const {
	applyAddGuestToClub,
	applySeparateGuest,
	CLUB_SET_MOVED_MESSAGE,
	GUEST_ADD_ALREADY_THERE_MESSAGE,
	GUEST_CROSS_CLUB_SAME_CLUB_MESSAGE,
	GUEST_ALREADY_SEPARATE_MESSAGE,
	GUEST_NOW_MEMBER_MESSAGE,
	loadGuestPipeline,
	loadOtherAdminClubs,
} = await import("#/server/guest-pipeline-logic");
const { statementsDuring } = await import("#/test/query-spy");

const uniq = () => randomUUID().slice(0, 8);

describe.skipIf(!hasTestDb)("guests across clubs (#1127)", () => {
	let a: SeededClub;
	let b: SeededClub;
	let c: SeededClub;
	/** Admin of A and of B (an officer of two clubs). */
	let officer: string;
	let officerPersonId: string;
	let officerMemberInB: string;
	/** Admin of A only, and of B only: the single-club admins. */
	let onlyA: string;
	let onlyB: string;
	const extraUsers: string[] = [];
	const extraPeople: string[] = [];

	/** A signed-in user with a Person, optionally an admin of `clubId`. */
	async function seedUser(
		clubId: string | null,
	): Promise<{ userId: string; personId: string }> {
		const userId = randomUUID();
		await testDb.insert(user).values({
			id: userId,
			name: "Officer",
			email: `officer-${userId}@test.example`,
			emailVerified: true,
		});
		const personId = await seedPerson({
			name: "Officer",
			email: `officer-${userId}@test.example`,
			userId,
		});
		extraUsers.push(userId);
		extraPeople.push(personId);
		if (clubId) await makeAdmin(personId, clubId);
		return { userId, personId };
	}

	async function makeAdmin(personId: string, clubId: string): Promise<string> {
		const [m] = await testDb
			.insert(members)
			.values({
				clubId,
				personId,
				name: "Officer",
				clubRole: "admin",
				status: "active",
			})
			.returning({ id: members.id });
		if (!m) throw new Error("no membership");
		return m.id;
	}

	async function seedGuest(
		clubId: string,
		over: {
			name?: string;
			email?: string | null;
			phone?: string | null;
			stage?: "prospect" | "following_up" | "joined" | "lost";
			personId?: string;
		} = {},
	): Promise<{ id: string; personId: string }> {
		const [row] = await testDb
			.insert(guests)
			.values(
				await withGuestPerson(
					{
						clubId,
						name: over.name ?? `Guest ${uniq()}`,
						email: over.email === undefined ? null : over.email,
						phone: over.phone === undefined ? null : over.phone,
						stage: over.stage ?? "prospect",
						...(over.personId ? { personId: over.personId } : {}),
					},
					testDb,
				),
			)
			.returning({ id: guests.id, personId: guests.personId });
		if (!row) throw new Error("no guest");
		return row;
	}

	/**
	 * Run `run`, park it behind `clubId`'s write lock (proved from the lock graph, so
	 * it is already inside its transaction and past every up-front check), change
	 * the world with `change`, then let it go. Returns what it threw, or null.
	 */
	async function parkedThen(
		clubId: string,
		run: () => Promise<unknown>,
		change: () => Promise<void>,
	): Promise<Error | null> {
		const blocker = await openBlockingTx(async (tx) => {
			await tx.execute(
				sql`select pg_advisory_xact_lock(${CLUB_WRITE_LOCK_NAMESPACE}::int4, hashtext(${clubId}))`,
			);
		});
		const settled = run().then(
			() => null,
			(e: Error) => e,
		);
		await waitForLockWait("pg_advisory_xact_lock", blocker.pid);
		await change();
		await blocker.commit();
		return settled;
	}

	/**
	 * `run` is refused WHILE `clubId`'s write lock is held by somebody else: the
	 * refusal is the up-front gate, which asks before it takes any lock. The
	 * re-ask inside the transaction would give the same answer, but only after
	 * waiting for the lock (5s, then "busy"), so a refusal that arrives with the lock
	 * still held proves the gate ran first.
	 */
	async function refusedWithoutWaiting(
		clubId: string,
		run: () => Promise<unknown>,
		message: string,
	): Promise<void> {
		const blocker = await openBlockingTx(async (tx) => {
			await tx.execute(
				sql`select pg_advisory_xact_lock(${CLUB_WRITE_LOCK_NAMESPACE}::int4, hashtext(${clubId}))`,
			);
		});
		try {
			await expect(run()).rejects.toThrow(message);
		} finally {
			await blocker.commit();
		}
	}

	/**
	 * A writer that holds `personId` `FOR UPDATE` and NO club lock, adds a guest row
	 * for it in `lateClubId`, and commits only after `run` has passed its club locks
	 * and is parked on the Person. Returns what `run` threw, or null.
	 */
	async function clubAppearsWhileParkedOnPerson(
		personId: string,
		lateClubId: string,
		waitFor: string,
		run: () => Promise<unknown>,
	): Promise<Error | null> {
		const blocker = await openBlockingTx(async (tx) => {
			await tx.execute(
				sql`select id from people where id = ${personId} for update`,
			);
			await tx.insert(guests).values({
				clubId: lateClubId,
				name: "Late Arrival",
				personId,
			});
		});
		const settled = run().then(
			() => null,
			(e: Error) => e,
		);
		await waitForLockWait(waitFor, blocker.pid);
		await blocker.commit();
		return settled;
	}

	async function guestRowsOf(personId: string) {
		return testDb
			.select({ id: guests.id, clubId: guests.clubId, stage: guests.stage })
			.from(guests)
			.where(eq(guests.personId, personId));
	}

	async function personRow(id: string) {
		const [row] = await testDb.select().from(people).where(eq(people.id, id));
		return row ?? null;
	}

	/** A member of `clubId` (role member) on a fresh Person with this contact. */
	async function seedMember(
		clubId: string,
		contact: { email?: string | null; phone?: string | null } = {},
	): Promise<{ memberId: string; personId: string }> {
		const personId = await seedPerson({
			name: `Member ${uniq()}`,
			email: contact.email ?? null,
			phone: contact.phone ?? null,
		});
		extraPeople.push(personId);
		const [m] = await testDb
			.insert(members)
			.values({
				clubId,
				personId,
				name: `Member ${uniq()}`,
				clubRole: "member",
				status: "active",
			})
			.returning({ id: members.id });
		if (!m) throw new Error("no member");
		return { memberId: m.id, personId };
	}

	beforeEach(async () => {
		a = await seedClub();
		b = await seedClub();
		c = await seedClub();
		const [p] = await testDb
			.select({ id: people.id })
			.from(people)
			.where(eq(people.userId, a.adminUserId));
		if (!p) throw new Error("no officer person");
		officer = a.adminUserId;
		officerPersonId = p.id;
		officerMemberInB = await makeAdmin(officerPersonId, b.clubId);
		onlyA = (await seedUser(a.clubId)).userId;
		onlyB = (await seedUser(b.clubId)).userId;
	});

	afterEach(async () => {
		// A guest row of one club can name a MEMBER Person of another, and `cleanup`
		// deletes a club's member Persons before the other clubs' guest rows are
		// gone: the guest rows go first, but each Person is kept for `cleanup` to
		// delete (it collects guest Persons before the cascade).
		const guestPersons = await testDb
			.selectDistinct({ id: guests.personId })
			.from(guests)
			.where(inArray(guests.clubId, [a.clubId, b.clubId, c.clubId]));
		await testDb
			.delete(guests)
			.where(inArray(guests.clubId, [a.clubId, b.clubId, c.clubId]));
		extraPeople.push(...guestPersons.map((g) => g.id));
		await cleanup(a.clubId, [a.adminUserId, a.memberUserId]);
		await cleanup(b.clubId, [b.adminUserId, b.memberUserId]);
		await cleanup(c.clubId, [c.adminUserId, c.memberUserId]);
		const people_ = extraPeople.splice(0);
		if (people_.length > 0) {
			await testDb.delete(people).where(inArray(people.id, people_));
		}
		const users = extraUsers.splice(0);
		for (const id of users) {
			await testDb.delete(user).where(eq(user.id, id));
		}
	});

	// -----------------------------------------------------------------------
	describe("Add to <club>", () => {
		it("gives the other club a prospect visitor row on the SAME Person and leaves this club's row alone", async () => {
			const g = await seedGuest(a.clubId, {
				name: "Dana Visitor",
				email: `dana-${uniq()}@example.test`,
				stage: "following_up",
			});
			await testDb
				.update(guests)
				.set({ preferredName: "Dee" })
				.where(eq(guests.id, g.id));

			await expect(
				applyAddGuestToClub({
					userId: officer,
					fromClubId: a.clubId,
					guestId: g.id,
					toClubId: b.clubId,
				}),
			).resolves.toEqual({ ok: true });

			const rows = await guestRowsOf(g.personId);
			expect(rows).toHaveLength(2);
			const added = rows.find((r) => r.clubId === b.clubId);
			expect(added?.stage).toBe("prospect");
			const [full] = await testDb
				.select()
				.from(guests)
				.where(eq(guests.id, added?.id ?? ""));
			expect(full).toMatchObject({
				name: "Dana Visitor",
				preferredName: "Dee",
				kind: "visitor",
				stage: "prospect",
				personId: g.personId,
			});
			// This club's row is exactly as it was.
			const [mine] = await testDb
				.select({ stage: guests.stage, clubId: guests.clubId })
				.from(guests)
				.where(eq(guests.id, g.id));
			expect(mine).toEqual({ stage: "following_up", clubId: a.clubId });
		});

		it("re-reads the clubs that hold the Person once it is locked", async () => {
			const g = await seedGuest(a.clubId);
			const err = await clubAppearsWhileParkedOnPerson(
				g.personId,
				c.clubId,
				"for no key update",
				() =>
					applyAddGuestToClub({
						userId: officer,
						fromClubId: a.clubId,
						guestId: g.id,
						toClubId: b.clubId,
					}),
			);
			expect(err?.message).toBe(CLUB_BUSY_MESSAGE);
			expect(
				(await guestRowsOf(g.personId)).filter((r) => r.clubId === b.clubId),
			).toHaveLength(0);
		});

		it("a CONVERTED guest row of the same Person in the other club does not block it", async () => {
			const g = await seedGuest(a.clubId);
			await seedGuest(b.clubId, { personId: g.personId, stage: "joined" });
			const board = await loadGuestPipeline(a.clubId, [b.clubId]);
			expect(board.find((r) => r.id === g.id)?.addableTo).toEqual([b.clubId]);
			await expect(
				applyAddGuestToClub({
					userId: officer,
					fromClubId: a.clubId,
					guestId: g.id,
					toClubId: b.clubId,
				}),
			).resolves.toEqual({ ok: true });
		});

		it("credits the officer who added them as the new row's introducer", async () => {
			const g = await seedGuest(a.clubId);
			await applyAddGuestToClub({
				userId: officer,
				fromClubId: a.clubId,
				guestId: g.id,
				toClubId: b.clubId,
			});
			const [added] = await testDb
				.select({ introducedBy: guests.introducedByMemberId })
				.from(guests)
				.where(eq(guests.clubId, b.clubId));
			expect(added?.introducedBy).toBe(officerMemberInB);
			const [mine] = await testDb
				.select({ introducedBy: guests.introducedByMemberId })
				.from(guests)
				.where(eq(guests.id, g.id));
			expect(mine?.introducedBy).toBeNull();
		});

		it("is refused when the other club already has an unconverted guest on that Person", async () => {
			const g = await seedGuest(a.clubId);
			await seedGuest(b.clubId, { personId: g.personId, stage: "lost" });
			await expect(
				applyAddGuestToClub({
					userId: officer,
					fromClubId: a.clubId,
					guestId: g.id,
					toClubId: b.clubId,
				}),
			).rejects.toThrow(GUEST_ADD_ALREADY_THERE_MESSAGE);
			expect(await guestRowsOf(g.personId)).toHaveLength(2);
		});

		it("is refused when the Person is an active member of the other club", async () => {
			const g = await seedGuest(a.clubId);
			await testDb.insert(members).values({
				clubId: b.clubId,
				personId: g.personId,
				name: "Already Here",
				clubRole: "member",
				status: "active",
			});
			await expect(
				applyAddGuestToClub({
					userId: officer,
					fromClubId: a.clubId,
					guestId: g.id,
					toClubId: b.clubId,
				}),
			).rejects.toThrow(GUEST_ADD_ALREADY_THERE_MESSAGE);
			expect(await guestRowsOf(g.personId)).toHaveLength(1);
		});

		it("is refused for a converted guest", async () => {
			const g = await seedGuest(a.clubId, { stage: "joined" });
			await expect(
				applyAddGuestToClub({
					userId: officer,
					fromClubId: a.clubId,
					guestId: g.id,
					toClubId: b.clubId,
				}),
			).rejects.toThrow(GUEST_NOW_MEMBER_MESSAGE);
		});

		it("refuses naming the same club twice", async () => {
			const g = await seedGuest(a.clubId);
			await expect(
				applyAddGuestToClub({
					userId: officer,
					fromClubId: a.clubId,
					guestId: g.id,
					toClubId: a.clubId,
				}),
			).rejects.toThrow(GUEST_CROSS_CLUB_SAME_CLUB_MESSAGE);
			expect(await guestRowsOf(g.personId)).toHaveLength(1);
		});

		it("refuses an admin of only ONE of the two clubs, whichever one", async () => {
			const g = await seedGuest(a.clubId);
			// Admin of A only, naming B.
			await expect(
				applyAddGuestToClub({
					userId: onlyA,
					fromClubId: a.clubId,
					guestId: g.id,
					toClubId: b.clubId,
				}),
			).rejects.toThrow(NOT_A_MEMBER_MESSAGE);
			// Admin of B only, naming A as the source.
			await expect(
				applyAddGuestToClub({
					userId: onlyB,
					fromClubId: a.clubId,
					guestId: g.id,
					toClubId: b.clubId,
				}),
			).rejects.toThrow(NOT_A_MEMBER_MESSAGE);
			// A plain member of both is not an admin of either.
			await expect(
				applyAddGuestToClub({
					userId: a.memberUserId,
					fromClubId: a.clubId,
					guestId: g.id,
					toClubId: b.clubId,
				}),
			).rejects.toThrow(NO_PERMISSION_MESSAGE);
			expect(await guestRowsOf(g.personId)).toHaveLength(1);
		});

		it("refuses a single-club admin before it waits for any lock", async () => {
			const g = await seedGuest(a.clubId);
			await refusedWithoutWaiting(
				b.clubId,
				() =>
					applyAddGuestToClub({
						userId: onlyA,
						fromClubId: a.clubId,
						guestId: g.id,
						toClubId: b.clubId,
					}),
				NOT_A_MEMBER_MESSAGE,
			);
			await refusedWithoutWaiting(
				b.clubId,
				() =>
					applyAddGuestToClub({
						userId: onlyB,
						fromClubId: a.clubId,
						guestId: g.id,
						toClubId: b.clubId,
					}),
				NOT_A_MEMBER_MESSAGE,
			);
		});

		it("two sessions adding the same Person to the same club yield exactly one row", async () => {
			const g = await seedGuest(a.clubId);
			const blocker = await openBlockingTx(async (tx) => {
				await tx.execute(
					sql`select pg_advisory_xact_lock(${CLUB_WRITE_LOCK_NAMESPACE}::int4, hashtext(${b.clubId}))`,
				);
			});
			const add = () =>
				applyAddGuestToClub({
					userId: officer,
					fromClubId: a.clubId,
					guestId: g.id,
					toClubId: b.clubId,
				});
			const both = Promise.allSettled([add(), add()]);
			// At least one is provably parked behind the club lock, so the two are
			// interleaved and not run one after the other.
			await waitForLockWait("pg_advisory_xact_lock", blocker.pid);
			await blocker.commit();
			const results = await both;

			expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
			const rejected = results.find((r) => r.status === "rejected");
			expect((rejected as PromiseRejectedResult).reason.message).toBe(
				GUEST_ADD_ALREADY_THERE_MESSAGE,
			);
			const inB = (await guestRowsOf(g.personId)).filter(
				(r) => r.clubId === b.clubId,
			);
			expect(inB).toHaveLength(1);
		});

		it("re-asks the officer's standing once the locks are held: a seat revoked while waiting writes nothing", async () => {
			const g = await seedGuest(a.clubId);
			const err = await parkedThen(
				b.clubId,
				() =>
					applyAddGuestToClub({
						userId: officer,
						fromClubId: a.clubId,
						guestId: g.id,
						toClubId: b.clubId,
					}),
				// The up-front check has passed; now the officer loses B.
				async () => {
					await testDb
						.update(members)
						.set({ status: "inactive" })
						.where(eq(members.id, officerMemberInB));
				},
			);
			expect(err?.message).toBe(NOT_A_MEMBER_MESSAGE);
			expect(await guestRowsOf(g.personId)).toHaveLength(1);
		});

		it("re-asks the SOURCE club too: a seat revoked in the guest's own club writes nothing", async () => {
			const g = await seedGuest(a.clubId);
			const err = await parkedThen(
				b.clubId,
				() =>
					applyAddGuestToClub({
						userId: officer,
						fromClubId: a.clubId,
						guestId: g.id,
						toClubId: b.clubId,
					}),
				async () => {
					await testDb
						.update(members)
						.set({ status: "inactive" })
						.where(eq(members.id, a.adminMemberId));
				},
			);
			expect(err?.message).toBe(NOT_A_MEMBER_MESSAGE);
			expect(await guestRowsOf(g.personId)).toHaveLength(1);
		});

		it("refuses with 'This record changed' when the Person moved under it", async () => {
			// A third club's guest row on the Person appears while Add waits: the
			// club set it locked is no longer the set the Person names.
			const g = await seedGuest(a.clubId);
			const err = await parkedThen(
				b.clubId,
				() =>
					applyAddGuestToClub({
						userId: officer,
						fromClubId: a.clubId,
						guestId: g.id,
						toClubId: b.clubId,
					}),
				async () => {
					await seedGuest(c.clubId, { personId: g.personId });
				},
			);
			expect(err?.message).toBe(CLUB_SET_MOVED_MESSAGE);
			expect(
				(await guestRowsOf(g.personId)).filter((r) => r.clubId === b.clubId),
			).toHaveLength(0);
		});
	});

	// -----------------------------------------------------------------------
	describe("Separate from other clubs", () => {
		it("gives the guest a fresh Person with its own name, copying contact from a guest-only Person", async () => {
			const email = `shared-${uniq()}@example.test`;
			const g = await seedGuest(a.clubId, {
				name: "Sam Shared",
				email,
				phone: "+14155550155",
			});
			const other = await seedGuest(b.clubId, {
				personId: g.personId,
				name: "Samuel Shared",
			});

			await expect(
				applySeparateGuest({
					userId: onlyA,
					clubId: a.clubId,
					guestId: g.id,
				}),
			).resolves.toEqual({ ok: true });

			const [mine] = await testDb
				.select({ personId: guests.personId })
				.from(guests)
				.where(eq(guests.id, g.id));
			expect(mine?.personId).not.toBe(g.personId);
			const fresh = await personRow(mine?.personId ?? "");
			expect(fresh).toMatchObject({
				name: "Sam Shared",
				email,
				phone: "+14155550155",
			});
			// The other club keeps the Person it had.
			const [theirs] = await testDb
				.select({ personId: guests.personId })
				.from(guests)
				.where(eq(guests.id, other.id));
			expect(theirs?.personId).toBe(g.personId);
		});

		it("copies NO contact from a member's Person", async () => {
			const member = await seedMember(b.clubId, {
				email: `mem-${uniq()}@example.test`,
				phone: "+14155550166",
			});
			const g = await seedGuest(a.clubId, {
				name: "Guest On Member",
				personId: member.personId,
			});
			await applySeparateGuest({
				userId: onlyA,
				clubId: a.clubId,
				guestId: g.id,
			});
			const [mine] = await testDb
				.select({ personId: guests.personId })
				.from(guests)
				.where(eq(guests.id, g.id));
			const fresh = await personRow(mine?.personId ?? "");
			expect(fresh).toMatchObject({
				name: "Guest On Member",
				email: null,
				phone: null,
			});
			// The member's Person is untouched.
			expect((await personRow(member.personId))?.phone).toBe("+14155550166");
		});

		it("copies NO contact from a signed-in person's Person", async () => {
			const g = await seedGuest(a.clubId, {
				name: "Signed In Guest",
				email: `si-${uniq()}@example.test`,
				phone: "+14155550177",
			});
			await seedGuest(b.clubId, { personId: g.personId });
			const signedIn = await seedUser(null);
			await testDb
				.update(people)
				.set({ userId: null })
				.where(eq(people.id, signedIn.personId));
			await testDb
				.update(people)
				.set({ userId: signedIn.userId })
				.where(eq(people.id, g.personId));
			await applySeparateGuest({
				userId: onlyA,
				clubId: a.clubId,
				guestId: g.id,
			});
			const [mine] = await testDb
				.select({ personId: guests.personId })
				.from(guests)
				.where(eq(guests.id, g.id));
			expect(await personRow(mine?.personId ?? "")).toMatchObject({
				email: null,
				phone: null,
			});
			await testDb
				.update(people)
				.set({ userId: null })
				.where(eq(people.id, g.personId));
		});

		it("is refused as 'Already separate' for a Person no other club holds", async () => {
			const g = await seedGuest(a.clubId);
			await expect(
				applySeparateGuest({ userId: onlyA, clubId: a.clubId, guestId: g.id }),
			).rejects.toThrow(GUEST_ALREADY_SEPARATE_MESSAGE);
		});

		it("is refused for a converted guest", async () => {
			const g = await seedGuest(a.clubId, { stage: "joined" });
			await seedGuest(b.clubId, { personId: g.personId });
			await expect(
				applySeparateGuest({ userId: onlyA, clubId: a.clubId, guestId: g.id }),
			).rejects.toThrow(GUEST_NOW_MEMBER_MESSAGE);
		});

		it("needs this club's admin and nobody else's: the other club's admin is refused", async () => {
			const g = await seedGuest(a.clubId);
			await seedGuest(b.clubId, { personId: g.personId });
			// Admin of the OTHER club only.
			await expect(
				applySeparateGuest({ userId: onlyB, clubId: a.clubId, guestId: g.id }),
			).rejects.toThrow(NOT_A_MEMBER_MESSAGE);
			// A plain member of this club.
			await expect(
				applySeparateGuest({
					userId: a.memberUserId,
					clubId: a.clubId,
					guestId: g.id,
				}),
			).rejects.toThrow(NO_PERMISSION_MESSAGE);
			const [row] = await testDb
				.select({ personId: guests.personId })
				.from(guests)
				.where(eq(guests.id, g.id));
			expect(row?.personId).toBe(g.personId);
		});

		it("re-asks the officer's standing once the lock is held", async () => {
			const g = await seedGuest(a.clubId);
			await seedGuest(b.clubId, { personId: g.personId });
			const onlyAMember = await testDb
				.select({ id: members.id })
				.from(members)
				.innerJoin(people, eq(people.id, members.personId))
				.where(eq(people.userId, onlyA));
			const err = await parkedThen(
				a.clubId,
				() =>
					applySeparateGuest({
						userId: onlyA,
						clubId: a.clubId,
						guestId: g.id,
					}),
				async () => {
					await testDb
						.update(members)
						.set({ status: "inactive" })
						.where(eq(members.id, onlyAMember[0]?.id ?? ""));
				},
			);
			expect(err?.message).toBe(NOT_A_MEMBER_MESSAGE);
			const [row] = await testDb
				.select({ personId: guests.personId })
				.from(guests)
				.where(eq(guests.id, g.id));
			expect(row?.personId).toBe(g.personId);
		});

		it("refuses another club's admin before it waits for the lock", async () => {
			const g = await seedGuest(a.clubId);
			await seedGuest(b.clubId, { personId: g.personId });
			await refusedWithoutWaiting(
				a.clubId,
				() =>
					applySeparateGuest({
						userId: onlyB,
						clubId: a.clubId,
						guestId: g.id,
					}),
				NOT_A_MEMBER_MESSAGE,
			);
		});

		it("a guest from another club's id is not found", async () => {
			const g = await seedGuest(b.clubId);
			await seedGuest(c.clubId, { personId: g.personId });
			await expect(
				applySeparateGuest({ userId: onlyA, clubId: a.clubId, guestId: g.id }),
			).rejects.toThrow("Guest not found in this club.");
		});

		it("re-reads the clubs that hold the Person once it is locked", async () => {
			const keeper = await seedGuest(a.clubId);
			const mine = await seedGuest(b.clubId, { personId: keeper.personId });
			const err = await clubAppearsWhileParkedOnPerson(
				keeper.personId,
				c.clubId,
				"for update",
				() =>
					applySeparateGuest({
						userId: onlyB,
						clubId: b.clubId,
						guestId: mine.id,
					}),
			);
			expect(err?.message).toBe(CLUB_BUSY_MESSAGE);
			const [row] = await testDb
				.select({ personId: guests.personId })
				.from(guests)
				.where(eq(guests.id, mine.id));
			expect(row?.personId).toBe(keeper.personId);
		});

		it("after an Add the shared guest-only Person's contact is copied", async () => {
			const email = `add-${uniq()}@example.test`;
			const g = await seedGuest(a.clubId, { email, phone: null });
			await applyAddGuestToClub({
				userId: officer,
				fromClubId: a.clubId,
				guestId: g.id,
				toClubId: b.clubId,
			});
			await applySeparateGuest({
				userId: onlyA,
				clubId: a.clubId,
				guestId: g.id,
			});
			const [row] = await testDb
				.select({ personId: guests.personId })
				.from(guests)
				.where(eq(guests.id, g.id));
			expect((await personRow(row?.personId ?? ""))?.email).toBe(email);
		});
	});

	// -----------------------------------------------------------------------
	describe("the board's flags and the viewer's other clubs", () => {
		it("sharedWithOtherClub reads true only when another club holds the Person; addableTo lists the viewer's clubs that do not", async () => {
			await seedGuest(a.clubId, { name: "Lone Guest" });
			const shared = await seedGuest(a.clubId, { name: "Shared Guest" });
			await seedGuest(b.clubId, { personId: shared.personId });
			const memberElsewhere = await seedGuest(a.clubId, {
				name: "Member Elsewhere",
			});
			await testDb.insert(members).values({
				clubId: c.clubId,
				personId: memberElsewhere.personId,
				name: "Member Elsewhere",
				clubRole: "member",
				status: "active",
			});
			await seedGuest(a.clubId, { name: "Joined Guest", stage: "joined" });

			const board = await loadGuestPipeline(a.clubId, [b.clubId, c.clubId]);
			const row = (name: string) => board.find((g) => g.name === name);
			expect(row("Lone Guest")?.sharedWithOtherClub).toBe(false);
			expect(row("Lone Guest")?.addableTo?.sort()).toEqual(
				[b.clubId, c.clubId].sort(),
			);
			expect(row("Shared Guest")?.sharedWithOtherClub).toBe(true);
			// Already a guest in B; still addable to C.
			expect(row("Shared Guest")?.addableTo).toEqual([c.clubId]);
			expect(row("Member Elsewhere")?.sharedWithOtherClub).toBe(true);
			expect(row("Member Elsewhere")?.addableTo).toEqual([b.clubId]);
			expect(row("Joined Guest")?.addableTo).toEqual([]);
			// A caller that names no clubs gets no Add offers.
			const plain = await loadGuestPipeline(a.clubId);
			expect(plain.every((g) => g.addableTo?.length === 0)).toBe(true);
		});

		it("probes the viewer's other clubs once, and only when there is something to probe", async () => {
			await seedGuest(a.clubId, { name: "On The Board" });
			const probes = (statements: string[]) =>
				statements.filter((q) => q.includes("unnest("));
			// Anti-vacuity: the spy sees the board's own reads.
			const none = await statementsDuring(() => loadGuestPipeline(a.clubId));
			expect(none.length).toBeGreaterThan(0);
			expect(probes(none)).toHaveLength(0);
			// Clubs named, a non-empty board: exactly one probe for the whole board.
			const some = await statementsDuring(() =>
				loadGuestPipeline(a.clubId, [b.clubId, c.clubId]),
			);
			expect(probes(some)).toHaveLength(1);
			// Clubs named, an empty board: nothing to ask about, nothing asked.
			const empty = await statementsDuring(() =>
				loadGuestPipeline(b.clubId, [a.clubId]),
			);
			expect(empty.length).toBeGreaterThan(0);
			expect(probes(empty)).toHaveLength(0);
		});

		it("the flags carry nothing about the other club's record", async () => {
			const shared = await seedGuest(a.clubId, { name: "Shared Guest" });
			await seedGuest(b.clubId, {
				personId: shared.personId,
				stage: "following_up",
			});
			const board = await loadGuestPipeline(a.clubId, [b.clubId]);
			const json = JSON.stringify(board);
			expect(json).not.toContain("following_up");
			const r = board.find((g) => g.name === "Shared Guest");
			expect(r?.stage).toBe("prospect");
		});

		it("loadOtherAdminClubs lists only the clubs where the user is an admin or an officer, other than this one", async () => {
			// The officer: admin of A and B; a plain member of C does not count.
			await testDb.insert(members).values({
				clubId: c.clubId,
				personId: officerPersonId,
				name: "Officer",
				clubRole: "member",
				status: "active",
			});
			const fromA = await loadOtherAdminClubs(officer, a.clubId);
			expect(fromA.map((x) => x.clubId)).toEqual([b.clubId]);
			const fromB = await loadOtherAdminClubs(officer, b.clubId);
			expect(fromB.map((x) => x.clubId)).toEqual([a.clubId]);
			expect(await loadOtherAdminClubs(onlyA, a.clubId)).toEqual([]);
			expect(Object.keys(fromA[0] ?? {}).sort()).toEqual(["clubId", "name"]);
		});

		it("an elected officer with an open term counts as an admin of the other club", async () => {
			const { userId, personId } = await seedUser(a.clubId);
			const [m] = await testDb
				.insert(members)
				.values({
					clubId: c.clubId,
					personId,
					name: "Elected",
					clubRole: "member",
					status: "active",
				})
				.returning({ id: members.id });
			await testDb.insert(officerTerms).values({
				membershipId: m?.id ?? "",
				position: "vp_membership",
				termStart: new Date(),
				termEnd: null,
			});
			const list = await loadOtherAdminClubs(userId, a.clubId);
			expect(list.map((x) => x.clubId)).toEqual([c.clubId]);
		});
	});
});
