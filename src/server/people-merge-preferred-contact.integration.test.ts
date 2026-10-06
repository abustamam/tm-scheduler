/**
 * A Person merge carries the contact preference over (#1093 review).
 *
 * The keeper reconcile adopts every fact the keeper is missing; the preference
 * is the one where "keeper wins" is wrong. Once a member has signed in, only
 * they may set it, so the row carrying the account wins — otherwise merging a
 * signed-in member's duplicate into an unlinked keeper silently replaces their
 * own choice with whatever an admin typed on the duplicate.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { people, user } from "#/db/schema";
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { mergePeople, mergedPreferredContact } = await import(
	"#/server/people-merge-logic"
);

describe("mergedPreferredContact (#1093)", () => {
	it("takes the linked row's value, even null, over the unlinked one", () => {
		expect(
			mergedPreferredContact(
				{ userId: null, preferredContact: "email" },
				{ userId: "u", preferredContact: "sms" },
			),
		).toBe("sms");
		expect(
			mergedPreferredContact(
				{ userId: "u", preferredContact: null },
				{ userId: null, preferredContact: "call" },
			),
		).toBeNull();
	});

	it("falls back to keeper ?? absorbed with neither or both linked", () => {
		expect(
			mergedPreferredContact(
				{ userId: null, preferredContact: null },
				{ userId: null, preferredContact: "call" },
			),
		).toBe("call");
		expect(
			mergedPreferredContact(
				{ userId: "u", preferredContact: "email" },
				{ userId: "u", preferredContact: "sms" },
			),
		).toBe("email");
	});
});

describe.skipIf(!hasTestDb)("mergePeople: preferred contact (#1093)", () => {
	const personIds: string[] = [];
	const userIds: string[] = [];

	afterEach(async () => {
		if (personIds.length)
			await testDb.delete(people).where(inArray(people.id, personIds));
		if (userIds.length)
			await testDb.delete(user).where(inArray(user.id, userIds));
		personIds.length = 0;
		userIds.length = 0;
	});

	it("a linked absorbed Person's choice survives a merge into an unlinked keeper", async () => {
		const userId = randomUUID();
		await testDb.insert(user).values({
			id: userId,
			name: "Linked",
			email: `linked-${userId}@test.example`,
			emailVerified: true,
		});
		userIds.push(userId);

		const [keeper] = await testDb
			.insert(people)
			.values({
				name: "Keeper",
				email: `keeper-${userId}@test.example`,
				phone: "+14155552671",
				preferredContact: "email",
			})
			.returning({ id: people.id });
		const [absorbed] = await testDb
			.insert(people)
			.values({
				name: "Absorbed",
				phone: "+14155552671",
				userId,
				preferredContact: "sms",
			})
			.returning({ id: people.id });
		if (!keeper || !absorbed) throw new Error("insert failed");
		personIds.push(keeper.id, absorbed.id);

		await mergePeople({
			keeperPersonId: keeper.id,
			absorbedPersonId: absorbed.id,
			actorUserId: null,
		});

		const [after] = await testDb
			.select({
				userId: people.userId,
				preferredContact: people.preferredContact,
			})
			.from(people)
			.where(eq(people.id, keeper.id));
		expect(after).toEqual({ userId, preferredContact: "sms" });
	});
});
