/**
 * DB-backed tests for `findBestPersonByEmail` — the case-insensitive email →
 * best-matching-Person lookup (Rule B), ranked by the shared `pickKeeper`
 * heuristic when more than one Person shares an email.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/people-logic.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { members, people, user } from "#/db/schema";
import { cleanup, hasTestDb, seedClub, seedPerson, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("findBestPersonByEmail", () => {
	const personIds: string[] = [];
	const userIds: string[] = [];

	afterEach(async () => {
		for (const id of personIds.splice(0)) {
			await testDb.delete(people).where(eq(people.id, id));
		}
		for (const id of userIds.splice(0)) {
			await testDb.delete(user).where(eq(user.id, id));
		}
	});

	/** Insert a bare (club-less) Person, tracked for cleanup. */
	async function person(overrides?: {
		email?: string | null;
		userId?: string | null;
	}): Promise<string> {
		const id = await seedPerson(overrides);
		personIds.push(id);
		return id;
	}

	/** Insert a Better-Auth user (needed to link a Person via `userId`), tracked
	 *  for cleanup. */
	async function seedUser(): Promise<string> {
		const id = randomUUID();
		await testDb.insert(user).values({
			id,
			name: "Linked",
			email: `${id}@test.example`,
			emailVerified: true,
		});
		userIds.push(id);
		return id;
	}

	it("returns null when no person matches the email", async () => {
		const { findBestPersonByEmail } = await import("./people-logic");
		expect(await findBestPersonByEmail(`none-${randomUUID()}@x.io`)).toBeNull();
	});

	it("matches case-insensitively", async () => {
		const { findBestPersonByEmail } = await import("./people-logic");
		const email = `cy-${randomUUID()}@x.io`;
		const id = await person({ email });
		expect(await findBestPersonByEmail(email.toUpperCase())).toBe(id);
	});

	it("prefers the login-linked person among multiple matches (Rule B)", async () => {
		const { findBestPersonByEmail } = await import("./people-logic");
		const email = `dup-${randomUUID()}@x.io`;
		await person({ email }); // unlinked
		const linkedUserId = await seedUser();
		const linkedId = await person({ email, userId: linkedUserId });

		expect(await findBestPersonByEmail(email)).toBe(linkedId);
	});
});

describe.skipIf(!hasTestDb)("listDuplicatePeople", () => {
	it("finds two Persons carrying one address, however it is spelled", async () => {
		// The pair the ambiguity arm of the bind refuses (#907): the merge tool
		// is how a superadmin finds and repairs it.
		const { listDuplicatePeople } = await import("./people-logic");
		const shared = `dupe-roster-${randomUUID()}@x.io`;
		const club = await seedClub();
		const pair: string[] = [];
		try {
			const a = await seedPerson({ name: "Pat Shared", email: shared });
			const b = await seedPerson({
				name: "Sam Shared",
				email: ` ${shared.toUpperCase()}\t`,
			});
			pair.push(a, b);
			for (const personId of [a, b]) {
				await testDb.insert(members).values({
					clubId: club.clubId,
					personId,
					name: "Shared Address",
				});
			}

			const group = (await listDuplicatePeople()).find(
				(g) => g.email === shared,
			);
			expect(group, "the pair is invisible to the merge tool").toBeDefined();
			expect(group?.people.map((p) => p.id).sort()).toEqual([...pair].sort());
		} finally {
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
			// By ID, never by the seeded name: `people` is club-less so `cleanup`
			// does not reach these, and vitest runs files in parallel against one
			// shared database — an unscoped delete takes another file's rows.
			if (pair.length > 0) {
				await testDb.delete(people).where(inArray(people.id, pair));
			}
		}
	});
});
