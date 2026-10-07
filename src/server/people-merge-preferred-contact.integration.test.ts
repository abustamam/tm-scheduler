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

type Side = Parameters<typeof mergedPreferredContact>[0];
const side = (
	userId: string | null,
	preferredContact: Side["preferredContact"],
	contactPreferenceBy: Side["contactPreferenceBy"] = null,
): Side => ({ userId, preferredContact, contactPreferenceBy });

describe("mergedPreferredContact (#1093, #1110)", () => {
	it("takes the linked row's value, even null, over the unlinked one", () => {
		expect(
			mergedPreferredContact(side(null, "email"), side("u", "sms")),
		).toEqual({ preferredContact: "sms", contactPreferenceBy: null });
		expect(mergedPreferredContact(side("u", null), side(null, "call"))).toEqual(
			{ preferredContact: null, contactPreferenceBy: null },
		);
	});

	it("falls back to keeper ?? absorbed with neither or both linked, carrying the supplier's source", () => {
		expect(
			mergedPreferredContact(side(null, null), side(null, "call", "officer")),
		).toEqual({ preferredContact: "call", contactPreferenceBy: "officer" });
		expect(
			mergedPreferredContact(side("u", "email"), side("u", "sms")),
		).toEqual({ preferredContact: "email", contactPreferenceBy: null });
	});

	it("pairs the value with the supplier's own source, never the other row's", () => {
		// Keeper linked with nothing chosen, absorbed officer-set sms: the linked
		// row supplies (null, null); "officer" must not leak onto that null.
		expect(
			mergedPreferredContact(side("u", null), side(null, "sms", "officer")),
		).toEqual({ preferredContact: null, contactPreferenceBy: null });
		expect(
			mergedPreferredContact(side(null, "sms", "officer"), side("u", null)),
		).toEqual({ preferredContact: null, contactPreferenceBy: null });
	});

	it("with both values null, takes the supplier's stamp", () => {
		expect(
			mergedPreferredContact(side(null, null), side(null, null, "officer")),
		).toEqual({ preferredContact: null, contactPreferenceBy: "officer" });
		expect(
			mergedPreferredContact(side(null, null, "officer"), side(null, null)),
		).toEqual({ preferredContact: null, contactPreferenceBy: null });
	});

	it("a member-set side wins over an officer-set one, whichever is keeper or linked", () => {
		const member = side(null, "sms", "member");
		const officer = side("u", "email", "officer");
		const want = { preferredContact: "sms", contactPreferenceBy: "member" };
		expect(mergedPreferredContact(member, officer)).toEqual(want);
		expect(mergedPreferredContact(officer, member)).toEqual(want);
		expect(
			mergedPreferredContact(
				side("u", "sms", "member"),
				side(null, "email", "officer"),
			),
		).toEqual(want);
	});

	it("a member-set No preference beats an officer-set value", () => {
		expect(
			mergedPreferredContact(
				side(null, "sms", "officer"),
				side(null, null, "member"),
			),
		).toEqual({ preferredContact: null, contactPreferenceBy: "member" });
	});

	it("both member-set: the existing order decides, the source stays member", () => {
		expect(
			mergedPreferredContact(
				side(null, "email", "member"),
				side(null, "sms", "member"),
			),
		).toEqual({ preferredContact: "email", contactPreferenceBy: "member" });
		expect(
			mergedPreferredContact(
				side(null, "email", "member"),
				side("u", "sms", "member"),
			),
		).toEqual({ preferredContact: "sms", contactPreferenceBy: "member" });
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
	it("a member-set absorbed No preference beats an officer-set keeper value, and the row carries member", async () => {
		const [keeper] = await testDb
			.insert(people)
			.values({
				name: "Keeper",
				email: `keeper-${randomUUID()}@test.example`,
				phone: "+14155552671",
				preferredContact: "sms",
				contactPreferenceBy: "officer",
			})
			.returning({ id: people.id });
		const [absorbed] = await testDb
			.insert(people)
			.values({
				name: "Absorbed",
				phone: "+14155552671",
				preferredContact: null,
				contactPreferenceBy: "member",
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
				preferredContact: people.preferredContact,
				by: people.contactPreferenceBy,
			})
			.from(people)
			.where(eq(people.id, keeper.id));
		expect(after).toEqual({ preferredContact: null, by: "member" });
	});
});
