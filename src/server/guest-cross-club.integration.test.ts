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
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	guests,
	members,
	officerTerms,
	people,
	user,
} from "#/db/schema";
import { formatActivity } from "#/lib/activity-format";
import type { ActivityEntry } from "#/server/activity-feed";
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
const { loadActivity } = await import("#/server/activity-feed-logic");
const {
	applyAddGuestToClub,
	applyConvertGuestToMember,
	applyDeleteGuest,
	applyLinkGuestAcrossClubs,
	applySeparateGuest,
	CLUB_SET_MOVED_MESSAGE,
	GUEST_LINK_ALREADY_SAME_MESSAGE,
	GUEST_LINK_BOTH_HAVE_HISTORY_MESSAGE,
	GUEST_LINK_CHANGED_MESSAGE,
	GUEST_LINK_EMAIL_DIFFERS_MESSAGE,
	GUEST_LINK_NOT_GUEST_ONLY_MESSAGE,
	GUEST_LINK_PHONE_DIFFERS_MESSAGE,
	listGuestLinkCandidates,
	previewGuestLink,
	GUEST_ADD_ALREADY_THERE_MESSAGE,
	GUEST_CROSS_CLUB_SAME_CLUB_MESSAGE,
	GUEST_ALREADY_SEPARATE_MESSAGE,
	GUEST_NOW_MEMBER_MESSAGE,
	loadGuestPipeline,
	loadOtherAdminClubs,
} = await import("#/server/guest-pipeline-logic");
const { GUEST_NOT_IN_CLUB_MESSAGE, RECORD_CHANGED_MESSAGE } = await import(
	"#/server/guests-logic"
);
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
		// protects=a Separate on a shared guest-only Person gives the guest a fresh Person with its own name and NO email or phone, and leaves the shared Person and the other club's row alone; fails_when=the old contact copy returns (the fresh Person carries the shared email or phone); no_claim=nothing about Persons a member or a sign-in holds (the two tests below)
		it("gives the guest a fresh Person with its own name and no contact, leaving the shared Person alone", async () => {
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
				email: null,
				phone: null,
			});
			// The shared Person keeps its contact, and the other club keeps the Person.
			expect(await personRow(g.personId)).toMatchObject({
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

		// protects=after an Add, a Separate still copies nothing onto the fresh Person; fails_when=the contact copy returns for a Person an Add shared; no_claim=the Person Add shares is guest-only here, not a member's or a signed-in one's
		it("after an Add the shared guest-only Person's contact is NOT copied (#1175)", async () => {
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
			expect(row?.personId).not.toBe(g.personId);
			expect(await personRow(row?.personId ?? "")).toMatchObject({
				email: null,
				phone: null,
			});
			expect((await personRow(g.personId))?.email).toBe(email);
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

	// -----------------------------------------------------------------------
	describe("Link: Same person as… (#1175)", () => {
		const norm = (v: string | null) => v?.trim().toLowerCase() || null;

		/** Both Persons' stored contact as the link normalizes it. */
		function basisOf(
			me: { email?: string | null; phone?: string | null },
			them: { email?: string | null; phone?: string | null },
		) {
			return {
				thisEmail: norm(me.email ?? null),
				thisPhone: (me.phone ?? "").replace(/\D/g, ""),
				otherEmail: norm(them.email ?? null),
				otherPhone: (them.phone ?? "").replace(/\D/g, ""),
			};
		}

		/** The `expected` for a pair, built from the stored rows, for a link the preview refuses. */
		async function handExpected(
			absorbed: "this" | "other",
			g: { personId: string },
			o: { personId: string },
		) {
			return {
				absorbed,
				basis: basisOf(
					(await personRow(g.personId)) ?? {},
					(await personRow(o.personId)) ?? {},
				),
			};
		}

		const asOfficer = (
			g: { id: string },
			o: { id: string },
			clubs = { clubId: a.clubId, otherClubId: b.clubId },
		) => ({
			userId: officer,
			clubId: clubs.clubId,
			guestId: g.id,
			otherClubId: clubs.otherClubId,
			otherGuestId: o.id,
		});

		async function preview(g: { id: string }, o: { id: string }) {
			return previewGuestLink(asOfficer(g, o));
		}

		/** The `expected` the officer's own preview returned. */
		async function expectedOf(g: { id: string }, o: { id: string }) {
			const p = await preview(g, o);
			if (!p.ok) throw new Error(`preview refused: ${p.message}`);
			return p.expected;
		}

		async function link(g: { id: string }, o: { id: string }) {
			return applyLinkGuestAcrossClubs({
				...asOfficer(g, o),
				expected: await expectedOf(g, o),
			});
		}

		async function personOfGuest(guestId: string): Promise<string> {
			const [row] = await testDb
				.select({ personId: guests.personId })
				.from(guests)
				.where(eq(guests.id, guestId));
			return row?.personId ?? "";
		}

		async function linkLogRows(clubId: string) {
			return testDb
				.select()
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, clubId),
						eq(activityLog.action, "member_merge"),
					),
				);
		}

		// -- the two sides and the keeper ----------------------------------
		// protects=the acting card's guest row ends on the other club's Person, its old Person is deleted, the keeper Person's row and both guest names are untouched; fails_when=the keeper is the wrong Person, the old Person survives, or a column or name is written; no_claim=an other-club row's stage, visits and notes (not read by the link)
		it("absorbs the acting guest into the other club's Person, writing nothing else", async () => {
			const email = `keep-${uniq()}@example.test`;
			const g = await seedGuest(a.clubId, { name: "Gina Acting" });
			const o = await seedGuest(b.clubId, {
				name: "Gina Other",
				email,
				phone: "+14155550177",
			});
			const keeperBefore = await personRow(o.personId);
			await expect(link(g, o)).resolves.toEqual({ ok: true });
			expect(await personOfGuest(g.id)).toBe(o.personId);
			expect(await personOfGuest(o.id)).toBe(o.personId);
			expect(await personRow(g.personId)).toBeNull();
			expect(await personRow(o.personId)).toEqual(keeperBefore);
			const names = await testDb
				.select({ id: guests.id, name: guests.name })
				.from(guests)
				.where(inArray(guests.id, [g.id, o.id]));
			expect(names.find((n) => n.id === g.id)?.name).toBe("Gina Acting");
			expect(names.find((n) => n.id === o.id)?.name).toBe("Gina Other");
		});

		// protects=when only the other club's guest is absorbable, ITS row re-points to the acting side's Person and its Person is deleted; fails_when=the acting side is absorbed regardless, or the absorbable arm tests the wrong side; no_claim=none beyond protects
		it("absorbs the OTHER club's guest when only it can be absorbed", async () => {
			const email = `both-${uniq()}@example.test`;
			const g = await seedGuest(a.clubId, { email, phone: "+14155550188" });
			const o = await seedGuest(b.clubId, { email, phone: null });
			const keeperBefore = await personRow(g.personId);
			const p = await preview(g, o);
			expect(p.ok && p.absorbed).toBe("other");
			await link(g, o);
			expect(await personOfGuest(o.id)).toBe(g.personId);
			expect(await personOfGuest(g.id)).toBe(g.personId);
			expect(await personRow(o.personId)).toBeNull();
			expect(await personRow(g.personId)).toEqual(keeperBefore);
		});

		// protects=on a tie (both pristine, equal normalized email and phone, even typed differently) the ACTING card's guest is absorbed; fails_when=the tie-break flips to the other side, or the comparison is on raw instead of normalized values; no_claim=none beyond protects
		it("absorbs the acting guest on a tie, comparing normalized email and phone", async () => {
			const tag = uniq();
			const g = await seedGuest(a.clubId, {
				email: `Tie-${tag}@Example.test `,
				phone: "+1 (415) 555-0199",
			});
			const o = await seedGuest(b.clubId, {
				email: `tie-${tag}@example.test`,
				phone: "+14155550199",
			});
			const p = await preview(g, o);
			expect(p.ok && p.absorbed).toBe("this");
			await link(g, o);
			expect(await personOfGuest(g.id)).toBe(o.personId);
			expect(await personRow(g.personId)).toBeNull();
		});

		// protects=a keeper Person a THIRD club already holds (an earlier Add) can be the target: A's pristine guest joins it and three clubs share it; fails_when=a keeper held elsewhere is refused or loses a holder; no_claim=none beyond protects
		it("lets the keeper already be shared with a third club", async () => {
			const g = await seedGuest(a.clubId);
			const o = await seedGuest(b.clubId, {
				email: `k-${uniq()}@example.test`,
			});
			const third = await seedGuest(c.clubId, { personId: o.personId });
			await link(g, o);
			const rows = await guestRowsOf(o.personId);
			expect(rows.map((r) => r.id).sort()).toEqual(
				[g.id, o.id, third.id].sort(),
			);
			expect(await personRow(g.personId)).toBeNull();
		});

		// -- refusals ----------------------------------------------------------
		// protects=naming one club twice is refused by the preview as data and by the link as a throw, before anything is read; fails_when=the same-club row is dropped or reordered after a read; no_claim=none beyond protects
		it("refuses the same club twice", async () => {
			const g = await seedGuest(a.clubId);
			const o = await seedGuest(a.clubId);
			const same = { clubId: a.clubId, otherClubId: a.clubId };
			await expect(previewGuestLink(asOfficer(g, o, same))).resolves.toEqual({
				ok: false,
				message: GUEST_CROSS_CLUB_SAME_CLUB_MESSAGE,
			});
			await expect(
				applyLinkGuestAcrossClubs({
					...asOfficer(g, o, same),
					expected: { absorbed: "this", basis: basisOf({}, {}) },
				}),
			).rejects.toThrow(GUEST_CROSS_CLUB_SAME_CLUB_MESSAGE);
			await expect(
				listGuestLinkCandidates({
					userId: officer,
					clubId: a.clubId,
					guestId: g.id,
					otherClubId: a.clubId,
					q: "",
				}),
			).rejects.toThrow(GUEST_CROSS_CLUB_SAME_CLUB_MESSAGE);
		});

		// protects=a guest id that is not in the club it is named under is not found, on either side, in the preview and the link; fails_when=the club scope of the read is dropped (a guest of a third club links); no_claim=none beyond protects
		it("refuses a guest that is not in the club it is named under", async () => {
			const g = await seedGuest(a.clubId);
			const o = await seedGuest(b.clubId);
			const elsewhere = await seedGuest(c.clubId);
			for (const [mine, theirs] of [
				[elsewhere, o],
				[g, elsewhere],
			] as const) {
				await expect(preview(mine, theirs)).resolves.toEqual({
					ok: false,
					message: GUEST_NOT_IN_CLUB_MESSAGE,
				});
				await expect(
					applyLinkGuestAcrossClubs({
						...asOfficer(mine, theirs),
						expected: { absorbed: "this", basis: basisOf({}, {}) },
					}),
				).rejects.toThrow(GUEST_NOT_IN_CLUB_MESSAGE);
			}
		});

		// protects=a converted guest on either side is refused ("now a member") and nothing moves; fails_when=the converted check is dropped or only one side is checked; no_claim=the convert itself (the lifecycle tests)
		it("refuses a converted guest on either side", async () => {
			for (const convertedSide of ["this", "other"] as const) {
				const g = await seedGuest(a.clubId, {
					stage: convertedSide === "this" ? "joined" : "prospect",
				});
				const o = await seedGuest(b.clubId, {
					stage: convertedSide === "other" ? "joined" : "prospect",
				});
				await expect(preview(g, o)).resolves.toEqual({
					ok: false,
					message: GUEST_NOW_MEMBER_MESSAGE,
				});
				await expect(
					applyLinkGuestAcrossClubs({
						...asOfficer(g, o),
						expected: { absorbed: "this", basis: basisOf({}, {}) },
					}),
				).rejects.toThrow(GUEST_NOW_MEMBER_MESSAGE);
				expect(await personOfGuest(g.id)).toBe(g.personId);
				expect(await personOfGuest(o.id)).toBe(o.personId);
			}
		});

		// protects=two guests already on one Person are told "Already the same person." and nothing is written; fails_when=a self-link deletes the Person both rows name; no_claim=the link's own reachability: its stale check (absorbed is null here) answers first, so the message is the preview's
		it("refuses two guests that are already one person", async () => {
			const g = await seedGuest(a.clubId);
			const o = await seedGuest(b.clubId, { personId: g.personId });
			await expect(preview(g, o)).resolves.toEqual({
				ok: false,
				message: GUEST_LINK_ALREADY_SAME_MESSAGE,
			});
			await expect(
				applyLinkGuestAcrossClubs({
					...asOfficer(g, o),
					expected: { absorbed: "this", basis: basisOf({}, {}) },
				}),
			).rejects.toThrow();
			expect(await personRow(g.personId)).not.toBeNull();
			expect(await guestRowsOf(g.personId)).toHaveLength(2);
		});

		// protects=a Person a member holds, or somebody signed in as, is never linked, on either side; fails_when=the guest-only check is dropped (a member's Person would be re-pointed onto, or deleted from under, a roster row); no_claim=the preview and the link agree because the link is given the matching expected by hand
		it("refuses a Person that is not guest-only: a member's, or a signed-in person's", async () => {
			const member = await seedMember(c.clubId);
			const signedIn = await seedUser(null);
			for (const nonGuestPerson of [member.personId, signedIn.personId]) {
				const bad = await seedGuest(a.clubId, { personId: nonGuestPerson });
				const clean = await seedGuest(b.clubId);
				// The clean side is absorbable (blank contact), so the guest-only check is
				// what answers, not "no absorbable side".
				await expect(preview(bad, clean)).resolves.toEqual({
					ok: false,
					message: GUEST_LINK_NOT_GUEST_ONLY_MESSAGE,
				});
				await expect(
					applyLinkGuestAcrossClubs({
						...asOfficer(bad, clean),
						expected: await handExpected("other", bad, clean),
					}),
				).rejects.toThrow(GUEST_LINK_NOT_GUEST_ONLY_MESSAGE);
				// And with the roles swapped.
				const clean2 = await seedGuest(a.clubId);
				const bad2 = await seedGuest(b.clubId, { personId: nonGuestPerson });
				await expect(preview(clean2, bad2)).resolves.toEqual({
					ok: false,
					message: GUEST_LINK_NOT_GUEST_ONLY_MESSAGE,
				});
				expect(await personOfGuest(clean.id)).toBe(clean.personId);
			}
		});

		// protects=with no absorbable side, differing emails say so (before phones); fails_when=the email arm of absorbable is dropped (a pristine side with a different address is absorbed and its address lost), or the message order changes; no_claim=the stale message answers first if the link is called, as the next test pins
		it("refuses different email addresses when neither side can be absorbed", async () => {
			const g = await seedGuest(a.clubId, {
				email: `x-${uniq()}@example.test`,
				phone: "+14155550101",
			});
			const o = await seedGuest(b.clubId, {
				email: `y-${uniq()}@example.test`,
				phone: "+14155550102",
			});
			await expect(preview(g, o)).resolves.toEqual({
				ok: false,
				message: GUEST_LINK_EMAIL_DIFFERS_MESSAGE,
			});
			expect(await personRow(g.personId)).not.toBeNull();
			expect(await personRow(o.personId)).not.toBeNull();
		});

		// protects=equal emails but different phones say "Different phone numbers."; fails_when=the phone arm of absorbable is dropped (a pristine side with a different phone is absorbed and its phone lost); no_claim=none beyond protects
		it("refuses different phone numbers when neither side can be absorbed", async () => {
			const email = `p-${uniq()}@example.test`;
			const g = await seedGuest(a.clubId, { email, phone: "+14155550101" });
			const o = await seedGuest(b.clubId, { email, phone: "+14155550102" });
			await expect(preview(g, o)).resolves.toEqual({
				ok: false,
				message: GUEST_LINK_PHONE_DIFFERS_MESSAGE,
			});
		});

		// protects=two Persons that each carry history (here: each is held by a third club too) are refused with the superadmin message, and a link attempt writes nothing; fails_when=the pristine arm of absorbable is dropped (a Person other clubs hold is deleted from under them); no_claim=history here is a shared guest row, not a speech or enrolment (pristineGuestPerson's own tests cover those)
		it("refuses when both records have history, and the three-club case is one of them", async () => {
			const g = await seedGuest(a.clubId);
			const o = await seedGuest(b.clubId);
			await seedGuest(c.clubId, { personId: g.personId });
			await seedGuest(c.clubId, { personId: o.personId });
			await expect(preview(g, o)).resolves.toEqual({
				ok: false,
				message: GUEST_LINK_BOTH_HAVE_HISTORY_MESSAGE,
			});
			await expect(
				applyLinkGuestAcrossClubs({
					...asOfficer(g, o),
					expected: { absorbed: "this", basis: basisOf({}, {}) },
				}),
			).rejects.toThrow(GUEST_LINK_CHANGED_MESSAGE);
			expect(await personRow(g.personId)).not.toBeNull();
			expect(await personRow(o.personId)).not.toBeNull();
		});

		// protects=a side held by a third club is not absorbable even when its contact is blank, so the OTHER side is absorbed instead and the third club keeps its Person; fails_when=the shared side is absorbed and its Person deleted from under club C; no_claim=none beyond protects
		it("never absorbs a side a third club holds", async () => {
			const g = await seedGuest(a.clubId);
			const third = await seedGuest(c.clubId, { personId: g.personId });
			const o = await seedGuest(b.clubId);
			const p = await preview(g, o);
			expect(p.ok && p.absorbed).toBe("other");
			await link(g, o);
			expect(await personOfGuest(o.id)).toBe(g.personId);
			expect(await personOfGuest(third.id)).toBe(g.personId);
			expect(await personRow(o.personId)).toBeNull();
		});

		// -- authorization --------------------------------------------------
		// protects=an admin of only ONE of the two clubs is refused by the picker, the preview and the link, whichever club it is, and nothing moves; fails_when=any of the six `requireClubRole` calls on the Link path is dropped; no_claim=an elected officer's standing (Add's tests cover the shared gate)
		it("refuses an admin of only one of the two clubs, on all three functions", async () => {
			const g = await seedGuest(a.clubId);
			const o = await seedGuest(b.clubId);
			const base = { clubId: a.clubId, guestId: g.id, otherClubId: b.clubId };
			for (const who of [onlyA, onlyB]) {
				await expect(
					listGuestLinkCandidates({ userId: who, ...base, q: "" }),
				).rejects.toThrow(NOT_A_MEMBER_MESSAGE);
				await expect(
					previewGuestLink({ userId: who, ...base, otherGuestId: o.id }),
				).rejects.toThrow(NOT_A_MEMBER_MESSAGE);
				await expect(
					applyLinkGuestAcrossClubs({
						userId: who,
						...base,
						otherGuestId: o.id,
						expected: { absorbed: "this", basis: basisOf({}, {}) },
					}),
				).rejects.toThrow(NOT_A_MEMBER_MESSAGE);
			}
			expect(await personOfGuest(g.id)).toBe(g.personId);
			expect(await personRow(g.personId)).not.toBeNull();
		});

		// protects=a seat revoked in the OTHER club while the link waits for a club lock writes nothing; fails_when=the in-transaction re-ask for either club is dropped; no_claim=the up-front gate (it passed: the call got as far as the lock)
		it("re-asks both seats once the locks are held", async () => {
			for (const [revoke, label] of [
				[officerMemberInB, "other club"],
				[a.adminMemberId, "acting club"],
			] as const) {
				const g = await seedGuest(a.clubId);
				const o = await seedGuest(b.clubId, {
					email: `r-${uniq()}@example.test`,
				});
				const expected = await expectedOf(g, o);
				const err = await parkedThen(
					b.clubId,
					() => applyLinkGuestAcrossClubs({ ...asOfficer(g, o), expected }),
					async () => {
						await testDb
							.update(members)
							.set({ status: "inactive" })
							.where(eq(members.id, revoke));
					},
				);
				expect(err?.message, label).toBe(NOT_A_MEMBER_MESSAGE);
				expect(await personOfGuest(g.id)).toBe(g.personId);
				expect(await personRow(g.personId)).not.toBeNull();
				// Put the seat back for the next round.
				await testDb
					.update(members)
					.set({ status: "active" })
					.where(eq(members.id, revoke));
			}
		});

		// -- the preview is what the link finds ----------------------------------
		// protects=an edit to EITHER Person's email or phone between preview and link refuses with the stale message and writes nothing, even where the edit would make the link refuse for a conflict instead; fails_when=the stale comparison is dropped, compares only some of the four values, or runs after the other refusals; no_claim=an edit to a name (not compared, the link never reads it)
		it("refuses a link whose records changed since the preview, before any other refusal", async () => {
			const edits: Array<{
				label: string;
				edit: (
					g: { personId: string },
					o: { personId: string },
					oEmail: string,
				) => Promise<void>;
			}> = [
				{
					label: "this email makes a conflict",
					edit: async (g) => {
						await testDb
							.update(people)
							.set({ email: "conflict-a@example.test" })
							.where(eq(people.id, g.personId));
					},
				},
				{
					label: "other phone (absorbed side unchanged)",
					edit: async (_g, o) => {
						await testDb
							.update(people)
							.set({ phone: "+14155550123" })
							.where(eq(people.id, o.personId));
					},
				},
				{
					label:
						"this phone, becoming equal to the other's (absorbed unchanged)",
					edit: async (g) => {
						await testDb
							.update(people)
							.set({ phone: "+14155550166" })
							.where(eq(people.id, g.personId));
					},
				},
				{
					label:
						"this email, becoming equal to the other's (absorbed unchanged)",
					edit: async (g, _o, oEmail) => {
						await testDb
							.update(people)
							.set({ email: oEmail })
							.where(eq(people.id, g.personId));
					},
				},
				{
					label: "other email",
					edit: async (_g, o) => {
						await testDb
							.update(people)
							.set({ email: `changed-${uniq()}@example.test` })
							.where(eq(people.id, o.personId));
					},
				},
			];
			for (const { label, edit } of edits) {
				const g = await seedGuest(a.clubId);
				const oEmail = `s-${uniq()}@example.test`;
				const o = await seedGuest(b.clubId, {
					email: oEmail,
					phone: "+14155550166",
				});
				const expected = await expectedOf(g, o);
				await edit(g, o, oEmail);
				await expect(
					applyLinkGuestAcrossClubs({ ...asOfficer(g, o), expected }),
					label,
				).rejects.toThrow(GUEST_LINK_CHANGED_MESSAGE);
				expect(await personOfGuest(g.id), label).toBe(g.personId);
				expect(await personRow(g.personId), label).not.toBeNull();
			}
		});

		// protects=a guest row that moved to another Person between the read and the locks is refused with RECORD_CHANGED, not linked on the old one; fails_when=the post-lock person_id comparison is dropped; no_claim=the club-set re-read (Add's tests cover the shared helper)
		it("refuses with 'This record changed' when a guest row moved Persons while it waited", async () => {
			const g = await seedGuest(a.clubId);
			const o = await seedGuest(b.clubId, {
				email: `m-${uniq()}@example.test`,
			});
			const expected = await expectedOf(g, o);
			const other = await seedPerson({ name: "Moved To" });
			extraPeople.push(other);
			const err = await parkedThen(
				b.clubId,
				() => applyLinkGuestAcrossClubs({ ...asOfficer(g, o), expected }),
				async () => {
					await testDb
						.update(guests)
						.set({ personId: other })
						.where(eq(guests.id, g.id));
				},
			);
			expect(err?.message).toBe(RECORD_CHANGED_MESSAGE);
			expect(await personOfGuest(g.id)).toBe(other);
		});

		// -- the audit row ----------------------------------------------------
		// protects=exactly one activity row, in the ACTING club, naming the acting guest and nothing of the other club, credited to the officer's seat there, and the feed words it; fails_when=a second row, a row in the other club, an other-club id or name in `detail`, or a missing actor; no_claim=an impersonating superadmin's attribution (logActivity's own tests)
		it("writes one audit row in the acting club with no other-club id or name", async () => {
			const g = await seedGuest(a.clubId, { name: "Audit Acting" });
			const o = await seedGuest(b.clubId, {
				name: "Audit Other",
				email: `au-${uniq()}@example.test`,
			});
			await link(g, o);
			const rowsA = await linkLogRows(a.clubId);
			expect(rowsA).toHaveLength(1);
			expect(await linkLogRows(b.clubId)).toHaveLength(0);
			expect(rowsA[0]?.actorMemberId).toBe(a.adminMemberId);
			expect(rowsA[0]?.detail).toEqual({
				change: "guest_cross_club_link",
				guestId: g.id,
				guestName: "Audit Acting",
			});
			const serialized = JSON.stringify(rowsA[0]);
			for (const secret of [o.id, "Audit Other", b.clubId, o.personId]) {
				expect(serialized).not.toContain(secret);
			}
			const feed = await loadActivity({ clubId: a.clubId });
			const entry = feed.find((e) => e.action === "member_merge");
			expect(entry).toMatchObject({
				crossClubLink: true,
				guestLink: false,
				guestName: "Audit Acting",
			});
			expect(formatActivity(entry as ActivityEntry).summary).toBe(
				"linked Audit Acting to the same person in another club",
			);
		});

		// -- the read contracts -------------------------------------------------
		// protects=the picker returns exactly {guestId,name,email,phone} per row, only the other club's unconverted guest-only Persons that are not this guest's own, filtered case-insensitively on name or email, `%` literal, by name, capped at 20; fails_when=a key (stage, notes, personId, …) is added, an excluded kind leaks in, the filter or cap or order changes; no_claim=the viewer sees names, emails and phones of the other club's guests by design (the dialog says so)
		it("lists candidates with exactly the contract's keys, filtered and capped", async () => {
			const g = await seedGuest(a.clubId);
			const keep = await seedGuest(b.clubId, {
				name: "Zed Candidate",
				email: `zed-${uniq()}@Example.test`,
				phone: "+14155550133",
			});
			const member = await seedMember(c.clubId);
			await seedGuest(b.clubId, {
				name: "Zed Member",
				personId: member.personId,
			});
			const signedIn = await seedUser(null);
			await seedGuest(b.clubId, {
				name: "Zed Signed",
				personId: signedIn.personId,
			});
			await seedGuest(b.clubId, { name: "Zed Converted", stage: "joined" });
			await seedGuest(b.clubId, { name: "Zed Own", personId: g.personId });
			await seedGuest(c.clubId, { name: "Zed Third Club" });
			await seedGuest(b.clubId, { name: "100% Real" });

			const ask = (q: string) =>
				listGuestLinkCandidates({
					userId: officer,
					clubId: a.clubId,
					guestId: g.id,
					otherClubId: b.clubId,
					q,
				});
			const zed = await ask("ZED");
			expect(zed.map((r) => r.name)).toEqual(["Zed Candidate"]);
			expect(Object.keys(zed[0] ?? {}).sort()).toEqual([
				"email",
				"guestId",
				"name",
				"phone",
			]);
			expect(zed[0]).toMatchObject({
				guestId: keep.id,
				phone: "+14155550133",
			});
			// By email, case-insensitively.
			expect((await ask("EXAMPLE.TEST")).map((r) => r.name)).toEqual([
				"Zed Candidate",
			]);
			// A typed % means itself.
			expect((await ask("%")).map((r) => r.name)).toEqual(["100% Real"]);
			// Ordered by name; empty q is the first 20.
			for (let i = 0; i < 22; i++) {
				await seedGuest(b.clubId, {
					name: `Many ${String(i).padStart(2, "0")}`,
				});
			}
			const all = await ask("");
			expect(all).toHaveLength(20);
			expect(all.map((r) => r.name)).toEqual(
				[...all.map((r) => r.name)].sort((x, y) => x.localeCompare(y)),
			);
		});

		// protects=the preview returns exactly the contract's keys, ok:true with the keeper Person's stored values and ok:false with only a message; fails_when=a key is added (the other club's stage, counts, ids) or the keeper's values are wrong; no_claim=none beyond protects
		it("previews with exactly the contract's keys and the keeper's stored values", async () => {
			const g = await seedGuest(a.clubId, { name: "Pre Acting" });
			const o = await seedGuest(b.clubId, {
				name: "Pre Other",
				email: `Pre-${uniq()}@Example.test`,
				phone: "+14155550144",
			});
			const keeper = await personRow(o.personId);
			const p = await preview(g, o);
			expect(Object.keys(p).sort()).toEqual([
				"absorbed",
				"email",
				"expected",
				"name",
				"ok",
				"phone",
			]);
			expect(p).toMatchObject({
				ok: true,
				absorbed: "this",
				name: keeper?.name,
				email: keeper?.email,
				phone: keeper?.phone,
			});
			if (!p.ok) throw new Error("unreachable");
			expect(Object.keys(p.expected).sort()).toEqual(["absorbed", "basis"]);
			expect(Object.keys(p.expected.basis).sort()).toEqual([
				"otherEmail",
				"otherPhone",
				"thisEmail",
				"thisPhone",
			]);
			const refused = await preview(
				await seedGuest(a.clubId, { email: "a1@example.test" }),
				await seedGuest(b.clubId, { email: "b1@example.test" }),
			);
			expect(Object.keys(refused).sort()).toEqual(["message", "ok"]);
		});

		// -- Separate copies nothing after a Link -----------------------------------
		// protects=after a Link, Separate gives the guest a fresh Person with null email and phone and leaves the shared Person's columns alone; fails_when=Separate copies the linked Person's contact; no_claim=none beyond protects
		it("Separate after a Link copies no contact", async () => {
			const g = await seedGuest(a.clubId, { name: "Sep Linked" });
			const o = await seedGuest(b.clubId, {
				email: `sep-${uniq()}@example.test`,
				phone: "+14155550155",
			});
			await link(g, o);
			const sharedBefore = await personRow(o.personId);
			await applySeparateGuest({
				userId: onlyA,
				clubId: a.clubId,
				guestId: g.id,
			});
			const fresh = await personRow(await personOfGuest(g.id));
			expect(fresh).toMatchObject({
				name: "Sep Linked",
				email: null,
				phone: null,
			});
			expect(await personOfGuest(g.id)).not.toBe(o.personId);
			expect(await personRow(o.personId)).toEqual(sharedBefore);
			expect(await personOfGuest(o.id)).toBe(o.personId);
		});

		// -- lifecycle on a linked pair -------------------------------------------
		// protects=deleting one side of a linked pair leaves the shared Person (and the other card) alone; fails_when=the guest delete removes a Person another club's row still names; no_claim=delete's own tests (this only pins it on a pair Link produced)
		it("delete on one side leaves the shared Person with the other", async () => {
			const g = await seedGuest(a.clubId);
			const o = await seedGuest(b.clubId, {
				email: `d-${uniq()}@example.test`,
			});
			await link(g, o);
			await applyDeleteGuest({
				clubId: a.clubId,
				guestId: g.id,
				actorMemberId: a.adminMemberId,
			});
			expect(await personRow(o.personId)).not.toBeNull();
			expect(await personOfGuest(o.id)).toBe(o.personId);
		});

		// protects=converting one side of a linked pair gives the converted guest a Person of its own (the shared one is not pristine) and leaves the other card, its contact and the shared Person exactly as they were; fails_when=a convert after a Link deletes, re-keys or locks the shared Person; no_claim=that the other card goes read-only: it does not, today, for an Added pair either, because convert never adopts a shared Person
		it("convert on one side leaves the other card and the shared Person alone", async () => {
			const email = `cv-${uniq()}@example.test`;
			const g = await seedGuest(a.clubId, { name: "Conv Acting" });
			const o = await seedGuest(b.clubId, { name: "Conv Other", email });
			await link(g, o);
			const sharedBefore = await personRow(o.personId);
			await applyConvertGuestToMember({
				clubId: a.clubId,
				guestId: g.id,
				actorMemberId: a.adminMemberId,
				confirmedEmail: null,
			});
			expect(await personOfGuest(o.id)).toBe(o.personId);
			expect(await personRow(o.personId)).toEqual(sharedBefore);
			expect(await personOfGuest(g.id)).not.toBe(o.personId);
			const row = (await loadGuestPipeline(b.clubId)).find(
				(r) => r.id === o.id,
			);
			expect(row?.contactRefusal ?? null).toBeNull();
		});

		// protects=once somebody signs in as the shared Person, BOTH clubs' cards show the contact read-only ("signed in"); fails_when=a linked pair's second card stays editable after a bind; no_claim=the bind flow itself
		it("binding a user to the shared Person makes both cards read-only", async () => {
			const g = await seedGuest(a.clubId);
			const o = await seedGuest(b.clubId, {
				email: `sg-${uniq()}@example.test`,
			});
			await link(g, o);
			const u = await seedUser(null);
			await testDb
				.update(people)
				.set({ userId: u.userId })
				.where(eq(people.id, o.personId));
			const inA = (await loadGuestPipeline(a.clubId)).find(
				(r) => r.id === g.id,
			);
			const inB = (await loadGuestPipeline(b.clubId)).find(
				(r) => r.id === o.id,
			);
			expect(inA?.contactRefusal).toBe("signed_in");
			expect(inB?.contactRefusal).toBe("signed_in");
		});

		// -- concurrency -----------------------------------------------------------
		// protects=two sessions linking the same pair: exactly one succeeds, the other is refused with one of the known messages, and no guest row names a deleted Person; fails_when=the club or Person locks are dropped (both succeed, or a row is left on a deleted Person); no_claim=a deterministic interleaving: the sessions are started together and Postgres picks the order
		it("two sessions linking the same pair: exactly one wins", async () => {
			const g = await seedGuest(a.clubId);
			const o = await seedGuest(b.clubId, {
				email: `cc-${uniq()}@example.test`,
			});
			const expected = await expectedOf(g, o);
			const results = await Promise.allSettled([
				applyLinkGuestAcrossClubs({ ...asOfficer(g, o), expected }),
				applyLinkGuestAcrossClubs({ ...asOfficer(g, o), expected }),
			]);
			expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
			const lost = results.find((r) => r.status === "rejected");
			expect([
				RECORD_CHANGED_MESSAGE,
				CLUB_SET_MOVED_MESSAGE,
				GUEST_LINK_CHANGED_MESSAGE,
				GUEST_LINK_ALREADY_SAME_MESSAGE,
			]).toContain((lost as PromiseRejectedResult).reason.message);
			expect(await personOfGuest(g.id)).toBe(o.personId);
			expect(await personRow(g.personId)).toBeNull();
		});

		// protects=a Link and an Add of the Person the Link absorbs, started together: no guest row ends on a deleted Person, and a refused side says why; fails_when=the Add's row lands on a Person the Link deleted; no_claim=which commits first (either order is allowed)
		it("a Link racing an Add of the absorbed Person leaves no row on a deleted Person", async () => {
			const g = await seedGuest(a.clubId);
			const o = await seedGuest(b.clubId, {
				email: `ra-${uniq()}@example.test`,
			});
			const expected = await expectedOf(g, o);
			const [linked, added] = await Promise.allSettled([
				applyLinkGuestAcrossClubs({ ...asOfficer(g, o), expected }),
				applyAddGuestToClub({
					userId: officer,
					fromClubId: a.clubId,
					guestId: g.id,
					toClubId: b.clubId,
				}),
			]);
			const allowed = [
				GUEST_ADD_ALREADY_THERE_MESSAGE,
				RECORD_CHANGED_MESSAGE,
				CLUB_SET_MOVED_MESSAGE,
				GUEST_LINK_CHANGED_MESSAGE,
				GUEST_LINK_ALREADY_SAME_MESSAGE,
			];
			for (const r of [linked, added]) {
				if (r.status === "rejected") {
					expect(allowed).toContain(r.reason.message);
				}
			}
			expect(
				[linked, added].filter((r) => r.status === "fulfilled").length,
			).toBeGreaterThanOrEqual(1);
			const rows = await testDb
				.select({ id: guests.id, personId: guests.personId })
				.from(guests)
				.where(inArray(guests.clubId, [a.clubId, b.clubId, c.clubId]));
			for (const row of rows) {
				expect(await personRow(row.personId), row.id).not.toBeNull();
			}
		});
	});
});
