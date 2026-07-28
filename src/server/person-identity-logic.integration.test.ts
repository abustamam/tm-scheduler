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

const { resolveUserPersonId, userPersonIds } = await import(
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
	},
);
