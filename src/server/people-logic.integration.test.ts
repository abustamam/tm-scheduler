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
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { people, user } from "#/db/schema";
import { hasTestDb, seedPerson, testDb } from "#/test/db";

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
