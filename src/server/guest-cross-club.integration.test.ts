/**
 * An officer of two clubs adds, links or separates a guest across them (#1127,
 * ADR-0031), against a real database.
 *
 * The claims, each stated in the terms of what a reader of the data sees:
 * - Add puts a `prospect` row on the SAME Person in the other club and leaves
 *   this club's row alone; two sessions adding the same Person yield one row.
 * - Link leaves two records on ONE Person; a guest-only keeper fills blanks from
 *   the absorbed side, a member's or signed-in person's contact is never written.
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
import {
	activityLog,
	clubCharterHelpers,
	guests,
	impersonationSessions,
	members,
	officerTerms,
	pathEnrollments,
	pathwaysPaths,
	people,
	speeches,
	user,
} from "#/db/schema";
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
	applyConvertGuestToMember,
	applyDeleteGuest,
	applyLinkGuestAcrossClubs,
	applySeparateGuest,
	CLUB_SET_MOVED_MESSAGE,
	GUEST_ADD_ALREADY_THERE_MESSAGE,
	GUEST_CROSS_CLUB_SAME_CLUB_MESSAGE,
	GUEST_ALREADY_SEPARATE_MESSAGE,
	GUEST_LINK_ALREADY_HERE_MESSAGE,
	GUEST_LINK_HAS_HISTORY_MESSAGE,
	GUEST_LINK_HAS_MEMBERSHIP_MESSAGE,
	GUEST_LINK_NOT_FOUND_MESSAGE,
	GUEST_LINK_SAME_PERSON_MESSAGE,
	GUEST_LINK_SIGNED_IN_MESSAGE,
	GUEST_LINK_STALE_MESSAGE,
	GUEST_NOW_MEMBER_MESSAGE,
	GUEST_SEPARATE_FIRST_MESSAGE,
	listGuestLinkCandidates,
	loadGuestPipeline,
	loadOtherAdminClubs,
	previewGuestLink,
} = await import("#/server/guest-pipeline-logic");
const { guestLinkResult, mergePeople } = await import(
	"#/server/people-merge-logic"
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
	const extraPaths: string[] = [];

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
		// A link re-points a guest row of one club onto a MEMBER Person of another,
		// and `cleanup` deletes a club's member Persons before the other clubs'
		// guest rows are gone: the guest rows go first, but each Person is kept for
		// `cleanup` to delete (it collects guest Persons before the cascade).
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
		const paths = extraPaths.splice(0);
		if (paths.length > 0) {
			await testDb
				.delete(pathwaysPaths)
				.where(inArray(pathwaysPaths.id, paths));
		}
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
	describe("Same person as…", () => {
		async function preview(
			guestId: string,
			other: { id: string; kind: "guest" | "member" },
			userId = officer,
		) {
			return previewGuestLink({
				userId,
				clubId: b.clubId,
				guestId,
				otherClubId: a.clubId,
				otherId: other.id,
				otherKind: other.kind,
			});
		}

		async function link(
			guestId: string,
			other: { id: string; kind: "guest" | "member" },
			expected: Awaited<ReturnType<typeof preview>>,
			userId = officer,
		) {
			return applyLinkGuestAcrossClubs({
				userId,
				clubId: b.clubId,
				guestId,
				otherClubId: a.clubId,
				otherId: other.id,
				otherKind: other.kind,
				expected,
			});
		}

		it("links B's guest to A's guest: one Person, B's old Person gone, contact filled only where blank", async () => {
			const keeper = await seedGuest(a.clubId, {
				name: "Robert Lee",
				email: `rob-${uniq()}@example.test`,
				phone: null,
			});
			const mine = await seedGuest(b.clubId, {
				name: "Bob Lee",
				email: `bob-${uniq()}@example.test`,
				phone: "+14155550100",
			});
			const keeperBefore = await personRow(keeper.personId);

			const shown = await preview(mine.id, { id: keeper.id, kind: "guest" });
			// The keeper's own email wins; the blank phone is filled from B's.
			expect(shown).toEqual({
				name: "Robert Lee",
				preferredName: null,
				email: keeperBefore?.email,
				phone: "+14155550100",
			});
			await expect(
				link(mine.id, { id: keeper.id, kind: "guest" }, shown),
			).resolves.toEqual({ ok: true });

			expect(
				(await guestRowsOf(keeper.personId)).map((r) => r.clubId).sort(),
			).toEqual([a.clubId, b.clubId].sort());
			expect(await personRow(mine.personId)).toBeNull();
			const merged = await personRow(keeper.personId);
			expect(merged).toMatchObject({
				name: "Robert Lee",
				email: keeperBefore?.email,
				phone: "+14155550100",
			});
			// Each club keeps its own spelling.
			const [bRow] = await testDb
				.select({ name: guests.name })
				.from(guests)
				.where(eq(guests.id, mine.id));
			expect(bRow?.name).toBe("Bob Lee");
		});

		it("adopts the absorbed goes-by name only when the keeper has none", async () => {
			const keeper = await seedGuest(a.clubId, { name: "Robert Lee" });
			const mine = await seedGuest(b.clubId, { name: "Bob Lee" });
			await testDb
				.update(people)
				.set({ preferredName: "Bob" })
				.where(eq(people.id, mine.personId));
			const shown = await preview(mine.id, { id: keeper.id, kind: "guest" });
			expect(shown.preferredName).toBe("Bob");
			await link(mine.id, { id: keeper.id, kind: "guest" }, shown);
			expect((await personRow(keeper.personId))?.preferredName).toBe("Bob");
		});

		it("links B's guest to A's MEMBER: re-points, and the member's blank contact stays blank", async () => {
			const member = await seedMember(a.clubId, { email: null, phone: null });
			const mine = await seedGuest(b.clubId, {
				name: "Mem Ber",
				email: `mem-${uniq()}@example.test`,
				phone: "+14155550111",
			});
			const shown = await preview(mine.id, {
				id: member.memberId,
				kind: "member",
			});
			// The member's contact is never written: blank stays blank.
			expect(shown.email).toBeNull();
			expect(shown.phone).toBeNull();
			await link(mine.id, { id: member.memberId, kind: "member" }, shown);

			const [row] = await testDb
				.select({ personId: guests.personId })
				.from(guests)
				.where(eq(guests.id, mine.id));
			expect(row?.personId).toBe(member.personId);
			expect(await personRow(mine.personId)).toBeNull();
			const kept = await personRow(member.personId);
			expect(kept?.email).toBeNull();
			expect(kept?.phone).toBeNull();
		});

		it("leaves a member's existing contact exactly as it was", async () => {
			const memberEmail = `m-${uniq()}@example.test`;
			const member = await seedMember(a.clubId, {
				email: memberEmail,
				phone: null,
			});
			const mine = await seedGuest(b.clubId, {
				email: `g-${uniq()}@example.test`,
				phone: "+14155550122",
			});
			const shown = await preview(mine.id, {
				id: member.memberId,
				kind: "member",
			});
			await link(mine.id, { id: member.memberId, kind: "member" }, shown);
			const kept = await personRow(member.personId);
			expect(kept?.email).toBe(memberEmail);
			expect(kept?.phone).toBeNull();
		});

		it("never writes the contact of a signed-in keeper, email or phone", async () => {
			// The keeper holds no membership, so it is not "a member"; only the
			// signed-in check keeps its blank email and phone blank.
			const keeper = await seedGuest(a.clubId, { email: null, phone: null });
			const signedIn = await seedUser(null);
			await testDb
				.update(people)
				.set({ userId: null })
				.where(eq(people.id, signedIn.personId));
			await testDb
				.update(people)
				.set({ userId: signedIn.userId })
				.where(eq(people.id, keeper.personId));
			const mine = await seedGuest(b.clubId, {
				email: `abs-${uniq()}@example.test`,
				phone: "+14155550133",
			});
			const shown = await preview(mine.id, { id: keeper.id, kind: "guest" });
			expect(shown.phone).toBeNull();
			expect(shown.email).toBeNull();
			await link(mine.id, { id: keeper.id, kind: "guest" }, shown);
			const kept = await personRow(keeper.personId);
			expect(kept?.phone).toBeNull();
			expect(kept?.email).toBeNull();
			await testDb
				.update(people)
				.set({ userId: null })
				.where(eq(people.id, keeper.personId));
		});

		it("is refused when this guest's Person holds a membership", async () => {
			const keeper = await seedGuest(a.clubId);
			const mine = await seedGuest(b.clubId);
			await testDb.insert(members).values({
				clubId: c.clubId,
				personId: mine.personId,
				name: "Elsewhere",
				clubRole: "member",
				status: "inactive",
			});
			await expect(
				preview(mine.id, { id: keeper.id, kind: "guest" }),
			).rejects.toThrow(GUEST_LINK_HAS_MEMBERSHIP_MESSAGE);
			await expect(
				link(
					mine.id,
					{ id: keeper.id, kind: "guest" },
					{ name: "x", preferredName: null, email: null, phone: null },
				),
			).rejects.toThrow(GUEST_LINK_HAS_MEMBERSHIP_MESSAGE);
			expect(await personRow(mine.personId)).not.toBeNull();
		});

		describe("a guest's Person with a history of its own is not absorbed (#1127 review)", () => {
			const stub = { name: "x", preferredName: null, email: null, phone: null };

			async function refuseAndWriteNothing(
				mine: { id: string; personId: string },
				keeper: { id: string; personId: string },
			) {
				await expect(
					preview(mine.id, { id: keeper.id, kind: "guest" }),
				).rejects.toThrow(GUEST_LINK_HAS_HISTORY_MESSAGE);
				await expect(
					link(mine.id, { id: keeper.id, kind: "guest" }, stub),
				).rejects.toThrow(GUEST_LINK_HAS_HISTORY_MESSAGE);
				// Nothing moved: both Persons stand and each guest row is on its own.
				expect(await personRow(mine.personId)).not.toBeNull();
				expect(await personRow(keeper.personId)).not.toBeNull();
				const [row] = await testDb
					.select({ personId: guests.personId })
					.from(guests)
					.where(eq(guests.id, mine.id));
				expect(row?.personId).toBe(mine.personId);
			}

			it("a FORMER member: a removal names the Person and no membership remains", async () => {
				const keeper = await seedGuest(a.clubId);
				const mine = await seedGuest(b.clubId);
				await testDb.insert(activityLog).values({
					clubId: b.clubId,
					actorMemberId: null,
					action: "member_remove",
					targetType: "member",
					detail: { personId: mine.personId },
				});
				await refuseAndWriteNothing(mine, keeper);
			});

			it.each([
				["customer_id", { customerId: `C${uniq()}` }],
				["basecamp_user_id", { basecampUserId: `B${uniq()}` }],
				["original_join_date", { originalJoinDate: new Date("2020-01-01") }],
			] as const)("a roster-identity column: %s", async (_name, set) => {
				const keeper = await seedGuest(a.clubId);
				const mine = await seedGuest(b.clubId);
				await testDb
					.update(people)
					.set(set)
					.where(eq(people.id, mine.personId));
				await refuseAndWriteNothing(mine, keeper);
			});

			it("a speech of its own", async () => {
				const keeper = await seedGuest(a.clubId);
				const mine = await seedGuest(b.clubId);
				await testDb
					.insert(speeches)
					.values({ personId: mine.personId, title: "Icebreaker" });
				await refuseAndWriteNothing(mine, keeper);
				const left = await testDb
					.select({ id: speeches.id })
					.from(speeches)
					.where(eq(speeches.personId, keeper.personId));
				expect(left).toHaveLength(0);
			});

			it("an enrolment, and the KEEPER's own enrolment on the same path survives", async () => {
				const keeper = await seedGuest(a.clubId);
				const mine = await seedGuest(b.clubId);
				const [path] = await testDb
					.insert(pathwaysPaths)
					.values({ courseCode: `PM-${randomUUID()}`, name: "Presentation" })
					.returning({ id: pathwaysPaths.id });
				if (!path) throw new Error("no path");
				extraPaths.push(path.id);
				await testDb.insert(pathEnrollments).values([
					{ personId: mine.personId, pathId: path.id },
					{ personId: keeper.personId, pathId: path.id },
				]);
				await refuseAndWriteNothing(mine, keeper);
				const kept = await testDb
					.select({ id: pathEnrollments.id })
					.from(pathEnrollments)
					.where(eq(pathEnrollments.personId, keeper.personId));
				expect(kept).toHaveLength(1);
			});

			it("a charter-helper row naming it, in a club the officer does not run", async () => {
				const keeper = await seedGuest(a.clubId);
				const mine = await seedGuest(b.clubId);
				const [helper] = await testDb
					.insert(clubCharterHelpers)
					.values({
						clubId: c.clubId,
						role: "club_mentor",
						personId: mine.personId,
					})
					.returning({ id: clubCharterHelpers.id });
				await refuseAndWriteNothing(mine, keeper);
				const [row] = await testDb
					.select({ personId: clubCharterHelpers.personId })
					.from(clubCharterHelpers)
					.where(eq(clubCharterHelpers.id, helper?.id ?? ""));
				expect(row?.personId).toBe(mine.personId);
			});

			it("the history is checked under the locks too: one that appears while the link waits refuses it", async () => {
				const keeper = await seedGuest(a.clubId);
				const mine = await seedGuest(b.clubId);
				const shown = await preview(mine.id, { id: keeper.id, kind: "guest" });
				const err = await parkedThen(
					b.clubId,
					() => link(mine.id, { id: keeper.id, kind: "guest" }, shown),
					async () => {
						await testDb
							.insert(speeches)
							.values({ personId: mine.personId, title: "Late" });
					},
				);
				expect(err?.message).toBe(GUEST_LINK_HAS_HISTORY_MESSAGE);
				expect(await personRow(mine.personId)).not.toBeNull();
			});
		});

		describe("a member's or signed-in keeper keeps its goes-by name and contact preference", () => {
			async function setPrefs(
				personId: string,
				prefs: {
					preferredName?: string | null;
					preferredContact?: "sms" | "email" | null;
					contactPreferenceBy?: "member" | "officer" | null;
				},
			) {
				await testDb.update(people).set(prefs).where(eq(people.id, personId));
			}

			it("a MEMBER keeper's blank goes-by name and blank preference stay blank", async () => {
				const member = await seedMember(a.clubId);
				const mine = await seedGuest(b.clubId, { name: "Bobby" });
				await setPrefs(mine.personId, {
					preferredName: "Bob",
					preferredContact: "sms",
					contactPreferenceBy: "officer",
				});
				const shown = await preview(mine.id, {
					id: member.memberId,
					kind: "member",
				});
				expect(shown.preferredName).toBeNull();
				await link(mine.id, { id: member.memberId, kind: "member" }, shown);
				const kept = await personRow(member.personId);
				expect(kept?.preferredName).toBeNull();
				expect(kept?.preferredContact).toBeNull();
				expect(kept?.contactPreferenceBy).toBeNull();
			});

			it("a MEMBER keeper's own preference is not replaced either", async () => {
				const member = await seedMember(a.clubId);
				await setPrefs(member.personId, {
					preferredName: "Mem",
					preferredContact: "email",
					contactPreferenceBy: "member",
				});
				const mine = await seedGuest(b.clubId);
				await setPrefs(mine.personId, {
					preferredName: "Other",
					preferredContact: "sms",
					contactPreferenceBy: "member",
				});
				const shown = await preview(mine.id, {
					id: member.memberId,
					kind: "member",
				});
				await link(mine.id, { id: member.memberId, kind: "member" }, shown);
				const kept = await personRow(member.personId);
				expect(kept?.preferredName).toBe("Mem");
				expect(kept?.preferredContact).toBe("email");
			});

			it("a GUEST-ONLY keeper fills its blank goes-by name and preference from the absorbed side", async () => {
				const keeper = await seedGuest(a.clubId, { name: "Robert" });
				const mine = await seedGuest(b.clubId, { name: "Bobby" });
				await setPrefs(mine.personId, {
					preferredName: "Bob",
					preferredContact: "sms",
					contactPreferenceBy: "officer",
				});
				const shown = await preview(mine.id, { id: keeper.id, kind: "guest" });
				expect(shown.preferredName).toBe("Bob");
				await link(mine.id, { id: keeper.id, kind: "guest" }, shown);
				const merged = await personRow(keeper.personId);
				expect(merged?.preferredName).toBe("Bob");
				expect(merged?.preferredContact).toBe("sms");
			});

			it("a SIGNED-IN keeper keeps its own, too", async () => {
				const keeper = await seedGuest(a.clubId);
				const signedIn = await seedUser(null);
				await testDb
					.update(people)
					.set({ userId: null })
					.where(eq(people.id, signedIn.personId));
				await testDb
					.update(people)
					.set({ userId: signedIn.userId })
					.where(eq(people.id, keeper.personId));
				const mine = await seedGuest(b.clubId);
				await setPrefs(mine.personId, {
					preferredName: "Abs",
					preferredContact: "sms",
					contactPreferenceBy: "officer",
				});
				const shown = await preview(mine.id, { id: keeper.id, kind: "guest" });
				await link(mine.id, { id: keeper.id, kind: "guest" }, shown);
				const kept = await personRow(keeper.personId);
				expect(kept?.preferredName).toBeNull();
				expect(kept?.preferredContact).toBeNull();
				await testDb
					.update(people)
					.set({ userId: null })
					.where(eq(people.id, keeper.personId));
			});
		});

		it("re-reads the clubs that hold the Persons once they are locked: a club that appeared while it waited for a Person refuses it", async () => {
			const keeper = await seedGuest(a.clubId);
			const mine = await seedGuest(b.clubId);
			const shown = await preview(mine.id, { id: keeper.id, kind: "guest" });
			const err = await clubAppearsWhileParkedOnPerson(
				keeper.personId,
				c.clubId,
				"for update",
				() => link(mine.id, { id: keeper.id, kind: "guest" }, shown),
			);
			expect(err?.message).toBe(CLUB_BUSY_MESSAGE);
			expect(await personRow(mine.personId)).not.toBeNull();
		});

		it("an impersonating superadmin's link names them on the audit row", async () => {
			const keeper = await seedGuest(b.clubId);
			const mine = await seedGuest(a.clubId);
			const su = await seedUser(b.clubId);
			await testDb
				.update(user)
				.set({ isSuperadmin: true })
				.where(eq(user.id, su.userId));
			await testDb.insert(impersonationSessions).values({
				superadminUserId: su.userId,
				clubId: a.clubId,
				mode: "read_write",
				reason: "repair",
				expiresAt: new Date(Date.now() + 60 * 60 * 1000),
			});
			const shown = await previewGuestLink({
				userId: su.userId,
				clubId: a.clubId,
				guestId: mine.id,
				otherClubId: b.clubId,
				otherId: keeper.id,
				otherKind: "guest",
			});
			await applyLinkGuestAcrossClubs({
				userId: su.userId,
				clubId: a.clubId,
				guestId: mine.id,
				otherClubId: b.clubId,
				otherId: keeper.id,
				otherKind: "guest",
				expected: shown,
			});
			const rows = await testDb
				.select({
					impersonatedBy: activityLog.impersonatedBy,
					actorMemberId: activityLog.actorMemberId,
				})
				.from(activityLog)
				.where(eq(activityLog.targetId, keeper.personId));
			expect(rows).toEqual([
				{ impersonatedBy: su.userId, actorMemberId: null },
			]);
		});

		describe("Separate is the undo of a link", () => {
			async function linked(over: {
				keeperContact: { email: string | null; phone: string | null };
				mineContact: { email: string | null; phone: string | null };
			}) {
				const keeper = await seedGuest(a.clubId, {
					name: "Robert Lee",
					...over.keeperContact,
				});
				const mine = await seedGuest(b.clubId, {
					name: "Bob Lee",
					...over.mineContact,
				});
				const shown = await preview(mine.id, { id: keeper.id, kind: "guest" });
				await link(mine.id, { id: keeper.id, kind: "guest" }, shown);
				return { keeper, mine };
			}

			it("gives the separated guest back ITS OWN contact, never the other club's merged one", async () => {
				const keeperEmail = `keeper-${uniq()}@example.test`;
				const mineEmail = `mine-${uniq()}@example.test`;
				const { keeper, mine } = await linked({
					keeperContact: { email: keeperEmail, phone: null },
					mineContact: { email: mineEmail, phone: "+14155550188" },
				});
				// The merged Person holds the keeper's email and the filled phone.
				expect(await personRow(keeper.personId)).toMatchObject({
					email: keeperEmail,
					phone: "+14155550188",
				});

				await applySeparateGuest({
					userId: onlyB,
					clubId: b.clubId,
					guestId: mine.id,
				});

				const [row] = await testDb
					.select({ personId: guests.personId })
					.from(guests)
					.where(eq(guests.id, mine.id));
				expect(row?.personId).not.toBe(keeper.personId);
				const fresh = await personRow(row?.personId ?? "");
				expect(fresh).toMatchObject({
					name: "Bob Lee",
					email: mineEmail,
					phone: "+14155550188",
				});
				expect(fresh?.email).not.toBe(keeperEmail);
				// The keeper's club still has the Person it had.
				const [k] = await testDb
					.select({ personId: guests.personId })
					.from(guests)
					.where(eq(guests.id, keeper.id));
				expect(k?.personId).toBe(keeper.personId);
			});

			it("restores a contact the guest did NOT have as blank, not as the keeper's", async () => {
				const { mine } = await linked({
					keeperContact: {
						email: `k-${uniq()}@example.test`,
						phone: "+14155550199",
					},
					mineContact: { email: null, phone: null },
				});
				await applySeparateGuest({
					userId: onlyB,
					clubId: b.clubId,
					guestId: mine.id,
				});
				const [row] = await testDb
					.select({ personId: guests.personId })
					.from(guests)
					.where(eq(guests.id, mine.id));
				expect(await personRow(row?.personId ?? "")).toMatchObject({
					email: null,
					phone: null,
				});
			});

			it("restores the goes-by name and contact preference it had", async () => {
				const keeper = await seedGuest(a.clubId, { name: "Robert Lee" });
				const mine = await seedGuest(b.clubId, { name: "Bob Lee" });
				await testDb
					.update(people)
					.set({
						preferredName: "Bobby",
						preferredContact: "sms",
						contactPreferenceBy: "officer",
					})
					.where(eq(people.id, mine.personId));
				const shown = await preview(mine.id, { id: keeper.id, kind: "guest" });
				await link(mine.id, { id: keeper.id, kind: "guest" }, shown);
				await applySeparateGuest({
					userId: onlyB,
					clubId: b.clubId,
					guestId: mine.id,
				});
				const [row] = await testDb
					.select({ personId: guests.personId })
					.from(guests)
					.where(eq(guests.id, mine.id));
				expect(await personRow(row?.personId ?? "")).toMatchObject({
					preferredName: "Bobby",
					preferredContact: "sms",
					contactPreferenceBy: "officer",
				});
			});

			it("a record of a link the guest has since left does not apply to a later Person", async () => {
				const keeperEmail = `k-${uniq()}@example.test`;
				const { mine } = await linked({
					keeperContact: { email: keeperEmail, phone: null },
					mineContact: { email: `old-${uniq()}@example.test`, phone: null },
				});
				await applySeparateGuest({
					userId: onlyB,
					clubId: b.clubId,
					guestId: mine.id,
				});
				// A later, different shared Person: the guest's new Person is corrected
				// and then shared with club C by an Add.
				const [own] = await testDb
					.select({ personId: guests.personId })
					.from(guests)
					.where(eq(guests.id, mine.id));
				const newEmail = `new-${uniq()}@example.test`;
				await testDb
					.update(people)
					.set({ email: newEmail })
					.where(eq(people.id, own?.personId ?? ""));
				await seedGuest(c.clubId, { personId: own?.personId });
				await applySeparateGuest({
					userId: onlyB,
					clubId: b.clubId,
					guestId: mine.id,
				});
				const [again] = await testDb
					.select({ personId: guests.personId })
					.from(guests)
					.where(eq(guests.id, mine.id));
				expect((await personRow(again?.personId ?? ""))?.email).toBe(newEmail);
			});

			/** Records of a cross-club link still held for this guest. */
			async function recordsFor(guestId: string): Promise<number> {
				const res = await testDb.execute<{ n: number }>(
					sql`select count(*)::int as n from activity_log
						where action = 'member_merge'
						  and detail->>'linkedGuestId' = ${guestId}
						  and detail ? 'absorbedContact'`,
				);
				return Number(res.rows[0]?.n ?? 0);
			}

			it("Separate consumes the record it used", async () => {
				const { mine } = await linked({
					keeperContact: { email: `k-${uniq()}@example.test`, phone: null },
					mineContact: { email: `m-${uniq()}@example.test`, phone: null },
				});
				expect(await recordsFor(mine.id)).toBe(1);
				await applySeparateGuest({
					userId: onlyB,
					clubId: b.clubId,
					guestId: mine.id,
				});
				expect(await recordsFor(mine.id)).toBe(0);
			});

			it("a deleted guest leaves no record of its contact", async () => {
				const { mine } = await linked({
					keeperContact: { email: null, phone: null },
					mineContact: { email: `m-${uniq()}@example.test`, phone: null },
				});
				expect(await recordsFor(mine.id)).toBe(1);
				await applyDeleteGuest({
					clubId: b.clubId,
					guestId: mine.id,
					actorMemberId: officerMemberInB,
				});
				expect(await recordsFor(mine.id)).toBe(0);
			});

			it("a convert drops it too", async () => {
				const { mine } = await linked({
					keeperContact: { email: null, phone: null },
					mineContact: { email: `m-${uniq()}@example.test`, phone: null },
				});
				expect(await recordsFor(mine.id)).toBe(1);
				await applyConvertGuestToMember({
					clubId: b.clubId,
					guestId: mine.id,
					actorMemberId: officerMemberInB,
				});
				expect(await recordsFor(mine.id)).toBe(0);
			});

			it("a newer link supersedes the record an older one left", async () => {
				const { keeper, mine } = await linked({
					keeperContact: { email: null, phone: null },
					mineContact: { email: `m-${uniq()}@example.test`, phone: null },
				});
				// The keeper's own guest row goes, so the guest's Person is held by
				// this club alone again and can be linked once more.
				await applyDeleteGuest({
					clubId: a.clubId,
					guestId: keeper.id,
					actorMemberId: a.adminMemberId,
				});
				const second = await seedGuest(a.clubId, { name: "Second Keeper" });
				const shown = await preview(mine.id, { id: second.id, kind: "guest" });
				await link(mine.id, { id: second.id, kind: "guest" }, shown);
				expect(await recordsFor(mine.id)).toBe(1);
			});

			it("a merge that puts the guest back on the Person does not replay a stale record", async () => {
				const keeperEmail = `k-${uniq()}@example.test`;
				const oldEmail = `old-${uniq()}@example.test`;
				const { keeper, mine } = await linked({
					keeperContact: { email: keeperEmail, phone: null },
					mineContact: { email: oldEmail, phone: null },
				});
				await applySeparateGuest({
					userId: onlyB,
					clubId: b.clubId,
					guestId: mine.id,
				});
				// The officer corrects the guest's own contact, then a superadmin merges
				// that Person back into the keeper's.
				const [own] = await testDb
					.select({ personId: guests.personId })
					.from(guests)
					.where(eq(guests.id, mine.id));
				const corrected = `corrected-${uniq()}@example.test`;
				await testDb
					.update(people)
					.set({ email: corrected })
					.where(eq(people.id, own?.personId ?? ""));
				await mergePeople({
					keeperPersonId: keeper.personId,
					absorbedPersonId: own?.personId ?? "",
				});
				await applySeparateGuest({
					userId: onlyB,
					clubId: b.clubId,
					guestId: mine.id,
				});
				const [again] = await testDb
					.select({ personId: guests.personId })
					.from(guests)
					.where(eq(guests.id, mine.id));
				// Never the contact from before the correction.
				expect((await personRow(again?.personId ?? ""))?.email).not.toBe(
					oldEmail,
				);
			});

			it("a record of ANOTHER guest on the same Person does not apply", async () => {
				const keeperEmail = `k-${uniq()}@example.test`;
				const { keeper } = await linked({
					keeperContact: { email: keeperEmail, phone: null },
					mineContact: { email: `old-${uniq()}@example.test`, phone: null },
				});
				// A second guest of club B that came to share the keeper's Person
				// without a link of its own (a state older code could leave).
				const other = await seedGuest(b.clubId, {
					name: "Other Guest",
					personId: keeper.personId,
				});
				await applySeparateGuest({
					userId: onlyB,
					clubId: b.clubId,
					guestId: other.id,
				});
				const [row] = await testDb
					.select({ personId: guests.personId })
					.from(guests)
					.where(eq(guests.id, other.id));
				// Not the first guest's recorded contact; the shared guest-only Person's.
				expect((await personRow(row?.personId ?? ""))?.email).toBe(keeperEmail);
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

			it("without a link record (an Add) the shared guest-only Person's contact is copied, as before", async () => {
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

		it("is refused when this guest's Person is bound to a sign-in", async () => {
			const keeper = await seedGuest(a.clubId);
			const mine = await seedGuest(b.clubId);
			const signedIn = await seedUser(null);
			await testDb
				.update(people)
				.set({ userId: null })
				.where(eq(people.id, signedIn.personId));
			await testDb
				.update(people)
				.set({ userId: signedIn.userId })
				.where(eq(people.id, mine.personId));
			await expect(
				link(
					mine.id,
					{ id: keeper.id, kind: "guest" },
					{ name: "x", preferredName: null, email: null, phone: null },
				),
			).rejects.toThrow(GUEST_LINK_SIGNED_IN_MESSAGE);
			await testDb
				.update(people)
				.set({ userId: null })
				.where(eq(people.id, mine.personId));
		});

		it("is refused when this guest's Person has a guest row in a THIRD club", async () => {
			const keeper = await seedGuest(a.clubId);
			const mine = await seedGuest(b.clubId);
			await seedGuest(c.clubId, { personId: mine.personId });
			await expect(
				preview(mine.id, { id: keeper.id, kind: "guest" }),
			).rejects.toThrow(GUEST_SEPARATE_FIRST_MESSAGE);
			await expect(
				link(
					mine.id,
					{ id: keeper.id, kind: "guest" },
					{ name: "x", preferredName: null, email: null, phone: null },
				),
			).rejects.toThrow(GUEST_SEPARATE_FIRST_MESSAGE);
			expect(await guestRowsOf(mine.personId)).toHaveLength(2);
		});

		it("is refused when both already share a Person", async () => {
			const keeper = await seedGuest(a.clubId);
			const mine = await seedGuest(b.clubId, { personId: keeper.personId });
			await expect(
				preview(mine.id, { id: keeper.id, kind: "guest" }),
			).rejects.toThrow(GUEST_LINK_SAME_PERSON_MESSAGE);
		});

		it("is refused when the other Person is already a guest here", async () => {
			const keeper = await seedGuest(a.clubId);
			await seedGuest(b.clubId, { personId: keeper.personId });
			const mine = await seedGuest(b.clubId);
			await expect(
				preview(mine.id, { id: keeper.id, kind: "guest" }),
			).rejects.toThrow(GUEST_LINK_ALREADY_HERE_MESSAGE);
		});

		it("is refused for a converted guest on either side", async () => {
			const keeper = await seedGuest(a.clubId, { stage: "joined" });
			const mine = await seedGuest(b.clubId);
			await expect(
				preview(mine.id, { id: keeper.id, kind: "guest" }),
			).rejects.toThrow(GUEST_NOW_MEMBER_MESSAGE);
			const other = await seedGuest(a.clubId);
			const converted = await seedGuest(b.clubId, { stage: "joined" });
			await expect(
				preview(converted.id, { id: other.id, kind: "guest" }),
			).rejects.toThrow(GUEST_NOW_MEMBER_MESSAGE);
		});

		it("is refused for a record that is not in the other club", async () => {
			const mine = await seedGuest(b.clubId);
			const inC = await seedGuest(c.clubId);
			await expect(
				preview(mine.id, { id: inC.id, kind: "guest" }),
			).rejects.toThrow(GUEST_LINK_NOT_FOUND_MESSAGE);
			const memberOfC = await seedMember(c.clubId);
			await expect(
				preview(mine.id, { id: memberOfC.memberId, kind: "member" }),
			).rejects.toThrow(GUEST_LINK_NOT_FOUND_MESSAGE);
		});

		it("refuses an admin of only ONE of the two clubs, on every action, whichever one", async () => {
			const keeper = await seedGuest(a.clubId);
			const mine = await seedGuest(b.clubId);
			const stub = { name: "x", preferredName: null, email: null, phone: null };
			for (const userId of [onlyA, onlyB]) {
				await expect(
					preview(mine.id, { id: keeper.id, kind: "guest" }, userId),
				).rejects.toThrow(NOT_A_MEMBER_MESSAGE);
				await expect(
					link(mine.id, { id: keeper.id, kind: "guest" }, stub, userId),
				).rejects.toThrow(NOT_A_MEMBER_MESSAGE);
				await expect(
					listGuestLinkCandidates({
						userId,
						clubId: b.clubId,
						otherClubId: a.clubId,
						q: "",
					}),
				).rejects.toThrow(NOT_A_MEMBER_MESSAGE);
			}
			expect(await personRow(mine.personId)).not.toBeNull();
		});

		it("refuses a single-club admin before it waits for any lock", async () => {
			const keeper = await seedGuest(a.clubId);
			const mine = await seedGuest(b.clubId);
			const stub = { name: "x", preferredName: null, email: null, phone: null };
			for (const userId of [onlyA, onlyB]) {
				await refusedWithoutWaiting(
					b.clubId,
					() => link(mine.id, { id: keeper.id, kind: "guest" }, stub, userId),
					NOT_A_MEMBER_MESSAGE,
				);
			}
		});

		it("refuses a link whose preview no longer matches, and writes nothing", async () => {
			const keeper = await seedGuest(a.clubId, { phone: null });
			const mine = await seedGuest(b.clubId, { phone: "+14155550144" });
			const shown = await preview(mine.id, { id: keeper.id, kind: "guest" });
			// Somebody gives the keeper a phone after the officer looked.
			await testDb
				.update(people)
				.set({ phone: "+14155550199" })
				.where(eq(people.id, keeper.personId));
			await expect(
				link(mine.id, { id: keeper.id, kind: "guest" }, shown),
			).rejects.toThrow(GUEST_LINK_STALE_MESSAGE);
			expect(await personRow(mine.personId)).not.toBeNull();
			expect(await guestRowsOf(keeper.personId)).toHaveLength(1);
		});

		it("re-asks the officer's standing in BOTH clubs once the locks are held", async () => {
			for (const revoke of [officerMemberInB, a.adminMemberId]) {
				const keeper = await seedGuest(a.clubId);
				const mine = await seedGuest(b.clubId);
				const shown = await preview(mine.id, { id: keeper.id, kind: "guest" });
				const err = await parkedThen(
					b.clubId,
					() => link(mine.id, { id: keeper.id, kind: "guest" }, shown),
					async () => {
						await testDb
							.update(members)
							.set({ status: "inactive" })
							.where(eq(members.id, revoke));
					},
				);
				expect(err?.message).toBe(NOT_A_MEMBER_MESSAGE);
				expect(await personRow(mine.personId)).not.toBeNull();
				await testDb
					.update(members)
					.set({ status: "active" })
					.where(eq(members.id, revoke));
			}
		});

		it("refuses with 'This record changed' when a Person gains a club while it waits", async () => {
			const keeper = await seedGuest(a.clubId);
			const mine = await seedGuest(b.clubId);
			const shown = await preview(mine.id, { id: keeper.id, kind: "guest" });
			const err = await parkedThen(
				b.clubId,
				() => link(mine.id, { id: keeper.id, kind: "guest" }, shown),
				async () => {
					await seedGuest(c.clubId, { personId: keeper.personId });
				},
			);
			expect(err?.message).toBe(CLUB_SET_MOVED_MESSAGE);
			expect(await personRow(mine.personId)).not.toBeNull();
		});

		it("the audit row names the officer and is written for this club only", async () => {
			const keeper = await seedGuest(a.clubId);
			const mine = await seedGuest(b.clubId);
			const shown = await preview(mine.id, { id: keeper.id, kind: "guest" });
			await link(mine.id, { id: keeper.id, kind: "guest" }, shown);
			const rows = await testDb.execute<{
				club_id: string;
				actor_member_id: string | null;
				detail: { mode?: string };
			}>(
				sql`select club_id, actor_member_id, detail from activity_log
					where action = 'member_merge' and target_id = ${keeper.personId}`,
			);
			expect(rows.rows).toHaveLength(1);
			expect(rows.rows[0]?.club_id).toBe(b.clubId);
			expect(rows.rows[0]?.actor_member_id).toBe(officerMemberInB);
			expect(rows.rows[0]?.detail.mode).toBe("guest-link");
		});
	});

	// -----------------------------------------------------------------------
	describe("the picker and the preview carry exactly the contract's fields", () => {
		it("candidates: {kind, id, name, email, phone}; unconverted guests and active members; case-insensitive on name or email; ordered by name", async () => {
			await seedGuest(a.clubId, {
				name: "Zed Zebra",
				email: `zed-${uniq()}@example.test`,
			});
			await seedGuest(a.clubId, { name: "Amy Alpha", email: null });
			await seedGuest(a.clubId, { name: "Joined Jo", stage: "joined" });
			const inactive = await seedMember(a.clubId);
			await testDb
				.update(members)
				.set({ status: "inactive" })
				.where(eq(members.id, inactive.memberId));
			await testDb
				.update(members)
				.set({ name: "Lapsed Lou" })
				.where(eq(members.id, inactive.memberId));
			const mem = await seedMember(a.clubId, { email: "mid@example.test" });
			await testDb
				.update(members)
				.set({ name: "Mid Member" })
				.where(eq(members.id, mem.memberId));
			await seedGuest(b.clubId, { name: "Other Clubs Guest" });

			const all = await listGuestLinkCandidates({
				userId: officer,
				clubId: b.clubId,
				otherClubId: a.clubId,
				q: "",
			});
			const names = all.map((r) => r.name);
			expect(names).toContain("Amy Alpha");
			expect(names).toContain("Mid Member");
			expect(names).toContain("Zed Zebra");
			expect(names).not.toContain("Joined Jo");
			expect(names).not.toContain("Lapsed Lou");
			expect(names).not.toContain("Other Clubs Guest");
			expect(names).toEqual([...names].sort((x, y) => x.localeCompare(y)));
			for (const row of all) {
				expect(Object.keys(row).sort()).toEqual(
					["email", "id", "kind", "name", "phone"].sort(),
				);
			}

			const byEmail = await listGuestLinkCandidates({
				userId: officer,
				clubId: b.clubId,
				otherClubId: a.clubId,
				q: "MID@EXAMPLE",
			});
			expect(byEmail.map((r) => r.name)).toEqual(["Mid Member"]);
			const byName = await listGuestLinkCandidates({
				userId: officer,
				clubId: b.clubId,
				otherClubId: a.clubId,
				q: "zEbRa",
			});
			expect(byName.map((r) => r.name)).toEqual(["Zed Zebra"]);
			// A LIKE wildcard typed in the box means itself.
			const wildcard = await listGuestLinkCandidates({
				userId: officer,
				clubId: b.clubId,
				otherClubId: a.clubId,
				q: "%",
			});
			expect(wildcard).toEqual([]);
		});

		it("candidates: at most 20", async () => {
			for (let i = 0; i < 22; i++) {
				await seedGuest(a.clubId, {
					name: `Many ${String(i).padStart(2, "0")}`,
				});
			}
			const rows = await listGuestLinkCandidates({
				userId: officer,
				clubId: b.clubId,
				otherClubId: a.clubId,
				q: "Many",
			});
			expect(rows).toHaveLength(20);
		});

		it("preview: exactly {name, preferredName, email, phone}", async () => {
			const keeper = await seedGuest(a.clubId);
			const mine = await seedGuest(b.clubId);
			const shown = await previewGuestLink({
				userId: officer,
				clubId: b.clubId,
				guestId: mine.id,
				otherClubId: a.clubId,
				otherId: keeper.id,
				otherKind: "guest",
			});
			expect(Object.keys(shown).sort()).toEqual(
				["email", "name", "phone", "preferredName"].sort(),
			);
		});

		it("guestLinkResult: a non-guest-only keeper keeps its own contact, blank or not; a guest-only keeper fills blanks", () => {
			const absorbed = {
				preferredName: "Abs",
				email: "abs@example.test",
				phone: "+1000",
			};
			const keeper = {
				name: "Keep",
				preferredName: null,
				email: null,
				phone: "+2000",
			};
			expect(guestLinkResult(keeper, absorbed, true)).toEqual({
				name: "Keep",
				preferredName: "Abs",
				email: "abs@example.test",
				phone: "+2000",
			});
			expect(guestLinkResult(keeper, absorbed, false)).toEqual({
				name: "Keep",
				preferredName: null,
				email: null,
				phone: "+2000",
			});
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
