/**
 * DB-backed integration tests for `mergePeople` — the cross-club, irreversible
 * Person merge. It re-points the three PERSON-scoped FKs (members / speeches /
 * path_enrollments) onto a keeper, funnels shared-club memberships through
 * `collapseMemberships`, keeps the more-progressed enrollment on a Pathways-path
 * collision, deletes the absorbed Person, and writes one `member_merge` audit
 * row per affected club.
 *
 * Covers the required cases:
 *   1. Clean cross-club merge (speech + membership re-pointed to keeper).
 *   2. Block: differing customer_id.
 *   3. Block: differing user_id (two distinct sign-in accounts).
 *   4. Block: differing basecamp_user_id.
 *   5. Adopt-if-null: keeper adopts the absorbed's customer_id.
 *   6. Same-club collapse: two memberships of one club fuse to one keeper row.
 *   7. Path collision: the more-progressed enrollment survives.
 *   8. Audit: a member_merge activity_log row is written with impersonated_by.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/people-merge.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubs,
	members,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
	people,
	speeches,
	user,
} from "#/db/schema";
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// Import after the mock so the logic module's `#/db` import resolves to testDb.
const { mergePeople } = await import("./people-logic");

describe.skipIf(!hasTestDb)("mergePeople", () => {
	// Everything created here, tracked for FK-safe teardown.
	const clubIds: string[] = [];
	const personIds: string[] = [];
	const userIds: string[] = [];
	const pathIds: string[] = [];

	afterEach(async () => {
		// clubs cascade → members, activity_log, meetings, role_slots.
		if (clubIds.length)
			await testDb.delete(clubs).where(inArray(clubs.id, clubIds));
		// paths cascade → path_enrollments → path_level_progress.
		if (pathIds.length)
			await testDb
				.delete(pathwaysPaths)
				.where(inArray(pathwaysPaths.id, pathIds));
		// people cascade → speeches + any remaining enrollments. Absorbed people
		// deleted during a successful merge simply don't match (idempotent).
		if (personIds.length)
			await testDb.delete(people).where(inArray(people.id, personIds));
		// users last — people referencing them are already gone.
		if (userIds.length)
			await testDb.delete(user).where(inArray(user.id, userIds));
		clubIds.length = 0;
		personIds.length = 0;
		userIds.length = 0;
		pathIds.length = 0;
	});

	async function makeClub(): Promise<string> {
		const id = randomUUID();
		await testDb
			.insert(clubs)
			.values({ id, name: "Merge Test Club", slug: `merge-${id}` });
		clubIds.push(id);
		return id;
	}

	async function makeUser(): Promise<string> {
		const id = randomUUID();
		await testDb.insert(user).values({
			id,
			name: "Actor",
			email: `${id}@test.example`,
			emailVerified: true,
		});
		userIds.push(id);
		return id;
	}

	async function makePerson(overrides?: {
		name?: string;
		email?: string | null;
		customerId?: string | null;
		basecampUserId?: string | null;
		userId?: string | null;
		originalJoinDate?: Date | null;
	}): Promise<string> {
		const [row] = await testDb
			.insert(people)
			.values({
				name: overrides?.name ?? "Merge Person",
				email: overrides?.email ?? null,
				customerId: overrides?.customerId ?? null,
				basecampUserId: overrides?.basecampUserId ?? null,
				userId: overrides?.userId ?? null,
				originalJoinDate: overrides?.originalJoinDate ?? null,
			})
			.returning({ id: people.id });
		if (!row) throw new Error("Failed to insert person");
		personIds.push(row.id);
		return row.id;
	}

	async function addMembership(
		clubId: string,
		personId: string,
		clubRole: "admin" | "member" = "member",
	): Promise<string> {
		const [m] = await testDb
			.insert(members)
			.values({ clubId, personId, name: "Member", clubRole, status: "active" })
			.returning({ id: members.id });
		if (!m) throw new Error("Failed to insert membership");
		return m.id;
	}

	async function makePath(): Promise<string> {
		const [p] = await testDb
			.insert(pathwaysPaths)
			.values({
				courseCode: `PM-${randomUUID()}`,
				name: "Presentation Mastery",
			})
			.returning({ id: pathwaysPaths.id });
		if (!p) throw new Error("Failed to insert path");
		pathIds.push(p.id);
		return p.id;
	}

	/** Enroll a person in a path with `approvedLevels` approved levels. */
	async function enroll(
		personId: string,
		pathId: string,
		approvedLevels: number,
		lastSyncedAt?: Date,
	): Promise<string> {
		const [e] = await testDb
			.insert(pathEnrollments)
			.values({
				personId,
				pathId,
				...(lastSyncedAt ? { lastSyncedAt } : {}),
			})
			.returning({ id: pathEnrollments.id });
		if (!e) throw new Error("Failed to insert enrollment");
		for (let level = 1; level <= approvedLevels; level++) {
			await testDb.insert(pathLevelProgress).values({
				enrollmentId: e.id,
				level,
				completed: 3,
				total: 3,
				approved: true,
			});
		}
		return e.id;
	}

	async function countApproved(enrollmentId: string): Promise<number> {
		const rows = await testDb
			.select()
			.from(pathLevelProgress)
			.where(
				and(
					eq(pathLevelProgress.enrollmentId, enrollmentId),
					eq(pathLevelProgress.approved, true),
				),
			);
		return rows.length;
	}

	it("cleanly merges across clubs: speech + membership re-point to the keeper", async () => {
		const email = `cross-${randomUUID()}@x.io`;
		const clubA = await makeClub();
		const clubB = await makeClub();
		const keeper = await makePerson({ email });
		const absorbed = await makePerson({ email });
		// keeper is in club A; absorbed is in a DIFFERENT club B (plain re-point).
		await addMembership(clubA, keeper);
		const absorbedMembership = await addMembership(clubB, absorbed);
		// absorbed has a speech.
		const [speech] = await testDb
			.insert(speeches)
			.values({ personId: absorbed, title: "Icebreaker" })
			.returning({ id: speeches.id });
		if (!speech) throw new Error("Failed to insert speech");

		const result = await mergePeople({
			keeperPersonId: keeper,
			absorbedPersonId: absorbed,
		});

		expect(result.movedCounts.speeches).toBe(1);
		expect(result.movedCounts.memberships).toBe(1);
		expect(result.movedCounts.collapsed).toBe(0);

		// absorbed Person is gone.
		const absRows = await testDb
			.select()
			.from(people)
			.where(eq(people.id, absorbed));
		expect(absRows).toHaveLength(0);

		// speech re-pointed to keeper.
		const [speechAfter] = await testDb
			.select()
			.from(speeches)
			.where(eq(speeches.id, speech.id));
		expect(speechAfter?.personId).toBe(keeper);

		// membership re-pointed to keeper.
		const [memberAfter] = await testDb
			.select()
			.from(members)
			.where(eq(members.id, absorbedMembership));
		expect(memberAfter?.personId).toBe(keeper);
	});

	it("blocks on a differing customer_id", async () => {
		const keeper = await makePerson({ customerId: `PN-${randomUUID()}` });
		const absorbed = await makePerson({ customerId: `PN-${randomUUID()}` });

		await expect(
			mergePeople({ keeperPersonId: keeper, absorbedPersonId: absorbed }),
		).rejects.toThrow(/customer/i);

		// Nothing deleted.
		const rows = await testDb
			.select()
			.from(people)
			.where(inArray(people.id, [keeper, absorbed]));
		expect(rows).toHaveLength(2);
	});

	it("blocks on differing user_id (two distinct sign-in accounts)", async () => {
		const userA = await makeUser();
		const userB = await makeUser();
		const keeper = await makePerson({ userId: userA });
		const absorbed = await makePerson({ userId: userB });

		await expect(
			mergePeople({ keeperPersonId: keeper, absorbedPersonId: absorbed }),
		).rejects.toThrow(/account/i);

		const rows = await testDb
			.select()
			.from(people)
			.where(inArray(people.id, [keeper, absorbed]));
		expect(rows).toHaveLength(2);
	});

	it("blocks on a differing basecamp_user_id", async () => {
		const keeper = await makePerson({ basecampUserId: `BC-${randomUUID()}` });
		const absorbed = await makePerson({ basecampUserId: `BC-${randomUUID()}` });

		await expect(
			mergePeople({ keeperPersonId: keeper, absorbedPersonId: absorbed }),
		).rejects.toThrow(/base camp/i);

		const rows = await testDb
			.select()
			.from(people)
			.where(inArray(people.id, [keeper, absorbed]));
		expect(rows).toHaveLength(2);
	});

	it("adopts the absorbed's customer_id when the keeper has none", async () => {
		const customerId = `PN-${randomUUID()}`;
		const keeper = await makePerson({ customerId: null });
		const absorbed = await makePerson({ customerId });

		await mergePeople({ keeperPersonId: keeper, absorbedPersonId: absorbed });

		const [keeperAfter] = await testDb
			.select()
			.from(people)
			.where(eq(people.id, keeper));
		expect(keeperAfter?.customerId).toBe(customerId);
		// absorbed gone (its unique customer_id freed before the keeper adopted it).
		const absRows = await testDb
			.select()
			.from(people)
			.where(eq(people.id, absorbed));
		expect(absRows).toHaveLength(0);
	});

	it("collapses two memberships of the SAME club into one keeper membership", async () => {
		const club = await makeClub();
		const keeper = await makePerson();
		const absorbed = await makePerson();
		await addMembership(club, keeper, "member");
		await addMembership(club, absorbed, "admin");

		const result = await mergePeople({
			keeperPersonId: keeper,
			absorbedPersonId: absorbed,
		});

		expect(result.movedCounts.collapsed).toBe(1);
		expect(result.movedCounts.memberships).toBe(0);

		// Exactly one membership remains in the club, owned by the keeper.
		const clubMembers = await testDb
			.select()
			.from(members)
			.where(eq(members.clubId, club));
		expect(clubMembers).toHaveLength(1);
		expect(clubMembers[0]?.personId).toBe(keeper);
		// admin role folded up from the absorbed membership.
		expect(clubMembers[0]?.clubRole).toBe("admin");
	});

	it("keeps the more-progressed enrollment on a shared-path collision", async () => {
		const email = `path-${randomUUID()}@x.io`;
		const keeper = await makePerson({ email });
		const absorbed = await makePerson({ email });
		const path = await makePath();
		// keeper enrolled in P with 1 approved level; absorbed with 2.
		await enroll(keeper, path, 1);
		const absorbedEnrollment = await enroll(absorbed, path, 2);

		const result = await mergePeople({
			keeperPersonId: keeper,
			absorbedPersonId: absorbed,
		});

		expect(result.movedCounts.enrollments).toBe(1);

		// keeper has exactly ONE enrollment in P — the absorbed's (2 approved).
		const keeperEnr = await testDb
			.select()
			.from(pathEnrollments)
			.where(eq(pathEnrollments.personId, keeper));
		expect(keeperEnr).toHaveLength(1);
		expect(keeperEnr[0]?.id).toBe(absorbedEnrollment);
		expect(keeperEnr[0]?.pathId).toBe(path);
		expect(await countApproved(keeperEnr[0]?.id ?? "")).toBe(2);
	});

	it("writes a member_merge audit row per affected club with impersonated_by", async () => {
		const email = `audit-${randomUUID()}@x.io`;
		const actorUserId = await makeUser();
		const clubB = await makeClub();
		const keeper = await makePerson({ email });
		const absorbed = await makePerson({ email });
		await addMembership(clubB, absorbed); // absorbed's club = the affected club.

		await mergePeople({
			keeperPersonId: keeper,
			absorbedPersonId: absorbed,
			actorUserId,
		});

		const audit = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, clubB),
					eq(activityLog.action, "member_merge"),
				),
			);
		expect(audit).toHaveLength(1);
		expect(audit[0]?.impersonatedBy).toBe(actorUserId);
		expect(audit[0]?.actorMemberId).toBeNull();
		expect(audit[0]?.targetId).toBe(keeper);
		expect(
			(audit[0]?.detail as { absorbedPersonId?: string })?.absorbedPersonId,
		).toBe(absorbed);
	});
});
