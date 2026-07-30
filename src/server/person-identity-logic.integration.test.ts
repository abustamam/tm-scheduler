/**
 * Regression: duplicate `people.user_id` rows split a member's Pathways record.
 * Found by /qa on 2026-07-28 against a dev DB where one account had six linked
 * Person rows — declaring a path on the dashboard wrote it to a membership-less
 * Person while the speech project picker read the Person behind the roster
 * membership. Same human, two records, no error.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/person-identity-logic.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { user } from "#/db/auth-schema";
import { clubs, members, people } from "#/db/schema";
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { resolveUserPersonId, userMemberIds, userPersonIds } = await import(
	"./person-identity-logic"
);

const SUITE_TAG = randomUUID().slice(0, 8);
const createdUserIds: string[] = [];
const createdPersonIds: string[] = [];
const createdClubIds: string[] = [];

async function makeUser(): Promise<string> {
	const id = randomUUID();
	await testDb
		.insert(user)
		.values({ id, name: "Dup", email: `${id}@example.com` });
	createdUserIds.push(id);
	return id;
}

async function makePerson(userId: string, createdAt: Date): Promise<string> {
	const id = randomUUID();
	await testDb.insert(people).values({
		id,
		name: "Dup Human",
		email: `${id}@example.com`,
		userId,
		createdAt,
	});
	createdPersonIds.push(id);
	return id;
}

describe.skipIf(!hasTestDb)(
	"resolveUserPersonId with duplicate Persons",
	() => {
		afterAll(async () => {
			if (!hasTestDb) return;
			if (createdPersonIds.length > 0) {
				await testDb.delete(people).where(inArray(people.id, createdPersonIds));
			}
			if (createdClubIds.length > 0) {
				await testDb.delete(clubs).where(inArray(clubs.id, createdClubIds));
			}
			if (createdUserIds.length > 0) {
				await testDb.delete(user).where(inArray(user.id, createdUserIds));
			}
		});

		// The actual bug: the person-level surfaces (dashboard) and the club-scoped
		// ones (speech picker, which reads members.person_id) must agree.
		it("prefers the Person that holds a roster membership", async () => {
			const userId = await makeUser();
			// Older, membership-less — what an unordered query could return first.
			const orphan = await makePerson(userId, new Date("2020-01-01"));
			const rostered = await makePerson(userId, new Date("2024-01-01"));

			const [club] = await testDb
				.insert(clubs)
				.values({ name: `Dup ${SUITE_TAG}`, slug: `dup-${SUITE_TAG}` })
				.returning({ id: clubs.id });
			createdClubIds.push(club.id);
			await testDb
				.insert(members)
				.values({ clubId: club.id, personId: rostered, name: "Dup Human" });

			expect(await resolveUserPersonId(userId)).toBe(rostered);
			expect(await resolveUserPersonId(userId)).not.toBe(orphan);
		});

		it("is stable across calls when nothing distinguishes them", async () => {
			const userId = await makeUser();
			const first = await makePerson(userId, new Date("2021-01-01"));
			await makePerson(userId, new Date("2022-01-01"));
			await makePerson(userId, new Date("2023-01-01"));

			// Oldest wins, and it must be the SAME answer every time — two queries in
			// one request disagreeing is what split the record.
			const answers = new Set([
				await resolveUserPersonId(userId),
				await resolveUserPersonId(userId),
				await resolveUserPersonId(userId),
			]);
			expect(answers.size).toBe(1);
			expect([...answers][0]).toBe(first);
		});

		it("returns null for an account with no linked Person", async () => {
			expect(await resolveUserPersonId(await makeUser())).toBeNull();
		});

		// Self-checks compare against ALL linked Persons: matching only the canonical
		// one would tell a member their own roster row isn't theirs, pushing them
		// into the admin gate on their own record.
		it("userPersonIds returns every linked Person, not just the canonical one", async () => {
			const userId = await makeUser();
			const a = await makePerson(userId, new Date("2021-06-01"));
			const b = await makePerson(userId, new Date("2021-07-01"));

			const all = await userPersonIds(userId);
			expect(all).toHaveLength(2);
			expect(all).toContain(a);
			expect(all).toContain(b);
			expect(all).toContain((await resolveUserPersonId(userId)) as string);
		});

		// #437: the membership-level resolver. A user with duplicate Persons holds
		// memberships under BOTH, and a personal cross-club view that took one of
		// them showed a subset of the clubs the switcher lists.
		it("userMemberIds spans every club, across duplicate Persons", async () => {
			const userId = await makeUser();
			const p1 = await makePerson(userId, new Date("2021-01-01"));
			const p2 = await makePerson(userId, new Date("2022-01-01"));

			const madeMembers: string[] = [];
			for (const [i, personId] of [p1, p2].entries()) {
				const [club] = await testDb
					.insert(clubs)
					.values({
						name: `Multi ${SUITE_TAG}-${i}`,
						slug: `multi-${SUITE_TAG}-${i}`,
					})
					.returning({ id: clubs.id });
				createdClubIds.push(club.id);
				const [m] = await testDb
					.insert(members)
					.values({ clubId: club.id, personId, name: "Dup Human" })
					.returning({ id: members.id });
				madeMembers.push(m.id);
			}

			const ids = await userMemberIds(userId);
			expect(ids).toHaveLength(2);
			expect(ids).toEqual(expect.arrayContaining(madeMembers));
			// Both memberships hang off DIFFERENT Persons — the case a
			// single-Person resolver cannot see.
			expect(p1).not.toBe(p2);
		});

		// Needs MORE THAN ONE membership to mean anything: with a single row
		// every ordering is trivially stable, so the `.orderBy(members.id)` the
		// resolver documents would go unverified.
		it("userMemberIds is stable across calls, and sorted by id", async () => {
			const userId = await makeUser();
			const personId = await makePerson(userId, new Date("2023-01-01"));
			const made: string[] = [];
			for (let i = 0; i < 3; i++) {
				const [club] = await testDb
					.insert(clubs)
					.values({
						name: `Stable ${SUITE_TAG}-${i}`,
						slug: `stable-${SUITE_TAG}-${i}`,
					})
					.returning({ id: clubs.id });
				createdClubIds.push(club.id);
				const [m] = await testDb
					.insert(members)
					.values({ clubId: club.id, personId, name: "Dup Human" })
					.returning({ id: members.id });
				made.push(m.id);
			}

			const first = await userMemberIds(userId);
			expect(first).toHaveLength(3);
			// Sorted, not merely repeatable — insertion order is deliberately
			// not id order (uuids are random), so this pins the ORDER BY.
			expect(first).toEqual([...made].sort());

			const answers = new Set([
				JSON.stringify(first),
				JSON.stringify(await userMemberIds(userId)),
				JSON.stringify(await userMemberIds(userId)),
			]);
			expect(answers.size).toBe(1);
		});

		it("userMemberIds returns empty for an account with no membership", async () => {
			const userId = await makeUser();
			// A linked Person exists, but it holds no roster row — the membership-
			// less duplicate that #436 found on the dashboard.
			await makePerson(userId, new Date("2024-01-01"));
			expect(await userMemberIds(userId)).toEqual([]);
		});
	},
);
