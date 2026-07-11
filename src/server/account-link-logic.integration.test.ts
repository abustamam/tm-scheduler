/**
 * DB-backed tests for account-linking on sign-in (#188). Tests the plain
 * `linkPersonToUser` fn directly; `#/db` is redirected to the test database.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/account-link-logic.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { people, user } from "#/db/schema";
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)(
	"linkPersonToUser (account link on sign-in)",
	() => {
		// Track ids to clean up (People are club-less; the user table is shared).
		let personIds: string[];
		let userIds: string[];

		beforeEach(() => {
			personIds = [];
			userIds = [];
		});
		afterEach(async () => {
			if (personIds.length > 0) {
				await testDb.delete(people).where(inArray(people.id, personIds));
			}
			if (userIds.length > 0) {
				await testDb.delete(user).where(inArray(user.id, userIds));
			}
		});

		/** Insert a Better-Auth user row and return its id. */
		async function seedUser(email: string): Promise<string> {
			const id = randomUUID();
			await testDb
				.insert(user)
				.values({ id, name: "Signed-in", email, emailVerified: true });
			userIds.push(id);
			return id;
		}

		/** Insert a Person row and return its id. */
		async function seedPerson(overrides: {
			email: string | null;
			userId?: string | null;
		}): Promise<string> {
			const [row] = await testDb
				.insert(people)
				.values({
					name: "Roster Person",
					email: overrides.email,
					userId: overrides.userId ?? null,
				})
				.returning({ id: people.id });
			if (!row) throw new Error("Failed to insert person");
			personIds.push(row.id);
			return row.id;
		}

		async function userIdOf(personId: string): Promise<string | null> {
			const [row] = await testDb
				.select({ userId: people.userId })
				.from(people)
				.where(eq(people.id, personId));
			return row?.userId ?? null;
		}

		it("links an unlinked Person whose email matches the signed-in user", async () => {
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const email = `match-${randomUUID()}@test.example`;
			const personId = await seedPerson({ email });
			const userId = await seedUser(email);

			const result = await linkPersonToUser(userId);

			expect(result.linkedPersonIds).toEqual([personId]);
			expect(await userIdOf(personId)).toBe(userId);
		});

		it("ordering: Person provisioned AFTER the user already signed in links on a later sign-in", async () => {
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const email = `later-${randomUUID()}@test.example`;
			// User exists first, no Person yet — early sign-ins are a harmless no-op.
			const userId = await seedUser(email);
			expect((await linkPersonToUser(userId)).linkedPersonIds).toEqual([]);

			// Person provisioned later; the NEXT sign-in links it.
			const personId = await seedPerson({ email });
			const result = await linkPersonToUser(userId);
			expect(result.linkedPersonIds).toEqual([personId]);
			expect(await userIdOf(personId)).toBe(userId);
		});

		it("matches email case-insensitively", async () => {
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const token = randomUUID();
			const personId = await seedPerson({
				email: `Mixed.Case-${token}@Test.Example`,
			});
			const userId = await seedUser(`mixed.case-${token}@test.example`);

			const result = await linkPersonToUser(userId);
			expect(result.linkedPersonIds).toEqual([personId]);
			expect(await userIdOf(personId)).toBe(userId);
		});

		it("no matching Person is a no-op (user still lands, just unlinked)", async () => {
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const userId = await seedUser(`nobody-${randomUUID()}@test.example`);
			// An unrelated Person with a different email must be untouched.
			const otherId = await seedPerson({
				email: `someone-else-${randomUUID()}@test.example`,
			});

			const result = await linkPersonToUser(userId);
			expect(result.linkedPersonIds).toEqual([]);
			expect(await userIdOf(otherId)).toBeNull();
		});

		it("is idempotent: repeated sign-ins don't error or change an already-linked Person", async () => {
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const email = `idem-${randomUUID()}@test.example`;
			const personId = await seedPerson({ email });
			const userId = await seedUser(email);

			const first = await linkPersonToUser(userId);
			expect(first.linkedPersonIds).toEqual([personId]);
			// Second sign-in: the Person is already linked → no-op (empty result).
			const second = await linkPersonToUser(userId);
			expect(second.linkedPersonIds).toEqual([]);
			expect(await userIdOf(personId)).toBe(userId);
		});

		it("never reassigns an already-linked Person, even when its email matches", async () => {
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const email = `shared-${randomUUID()}@test.example`;
			// Two roster People share an address (ADR-0008 permits duplicate emails):
			// one is already linked to a prior account, the other is still unlinked.
			const existingUserId = await seedUser(email);
			const linkedPersonId = await seedPerson({
				email,
				userId: existingUserId,
			});
			const unlinkedPersonId = await seedPerson({ email });

			// A fresh sign-in with that email links ONLY the unlinked Person; the
			// already-linked one is protected by the `user_id IS NULL` guard and is
			// never reassigned away from its existing account.
			const newUserId = existingUserId; // same email always resolves to this user
			const result = await linkPersonToUser(newUserId);

			expect(result.linkedPersonIds).toEqual([unlinkedPersonId]);
			expect(await userIdOf(linkedPersonId)).toBe(existingUserId);
			expect(await userIdOf(unlinkedPersonId)).toBe(existingUserId);
		});
	},
);
