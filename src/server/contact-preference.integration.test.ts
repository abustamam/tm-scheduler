/**
 * DB-backed tests for the MEMBER's own writer of `people.preferred_contact`
 * (#1093): `applySetMyPreferredContact`, behind `setMyPreferredContact`, and the
 * /account card's reader.
 *
 * The availability check lives in the UPDATE's own WHERE, so the refusal cases
 * here are what fail if it is removed: the write would land and the column
 * would read back the refused method.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { people } from "#/db/schema";
import {
	CONTACT_METHOD_UNAVAILABLE_MESSAGE,
	CONTACT_METHODS,
	type ContactMethod,
} from "#/lib/preferred-contact";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	applySetMyPreferredContact,
	contactMethodAvailableSql,
	loadMyContactPreference,
} = await import("./contact-preference-logic");

const PHONE = "+14155552671";

async function stored(personId: string): Promise<ContactMethod | null> {
	const [row] = await testDb
		.select({ v: people.preferredContact })
		.from(people)
		.where(eq(people.id, personId));
	return row?.v ?? null;
}

async function setPerson(
	personId: string,
	values: { email?: string | null; phone?: string | null },
) {
	await testDb.update(people).set(values).where(eq(people.id, personId));
}

describe.skipIf(!hasTestDb)("setMyPreferredContact (#1093)", () => {
	let seed: SeededClub;
	let adminPersonId: string;
	let orphanPersonIds: string[];

	beforeEach(async () => {
		seed = await seedClub();
		orphanPersonIds = [];
		const [admin] = await testDb
			.select({ id: people.id })
			.from(people)
			.where(eq(people.userId, seed.adminUserId));
		if (!admin) throw new Error("seeded admin has no Person");
		adminPersonId = admin.id;
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		for (const id of orphanPersonIds) {
			await testDb.delete(people).where(eq(people.id, id));
		}
	});

	it("saves every available method, and null", async () => {
		await setPerson(seed.personId, { phone: PHONE });
		for (const m of CONTACT_METHODS) {
			await applySetMyPreferredContact({
				userId: seed.memberUserId,
				preferredContact: m,
			});
			expect(await stored(seed.personId)).toBe(m);
		}
		await applySetMyPreferredContact({
			userId: seed.memberUserId,
			preferredContact: null,
		});
		expect(await stored(seed.personId)).toBeNull();
	});

	it("refuses every phone method without a digit in the phone, writing nothing", async () => {
		for (const phone of [null, "ask at church"]) {
			await setPerson(seed.personId, { phone });
			for (const m of ["call", "sms", "whatsapp"] as const) {
				await expect(
					applySetMyPreferredContact({
						userId: seed.memberUserId,
						preferredContact: m,
					}),
				).rejects.toThrow(CONTACT_METHOD_UNAVAILABLE_MESSAGE);
				expect(await stored(seed.personId)).toBeNull();
			}
		}
	});

	it("refuses email without an email, including a blank one, writing nothing", async () => {
		for (const email of [null, "   "]) {
			await setPerson(seed.personId, { email, phone: PHONE });
			await expect(
				applySetMyPreferredContact({
					userId: seed.memberUserId,
					preferredContact: "email",
				}),
			).rejects.toThrow(CONTACT_METHOD_UNAVAILABLE_MESSAGE);
			expect(await stored(seed.personId)).toBeNull();
		}
	});

	it("refuses email when the address is only a tab or a newline", async () => {
		// The server's test must agree with the UI's `email?.trim()`. `btrim`
		// strips spaces only, so "\t" and "\n" used to pass the WHERE.
		for (const email of ["\t", "\n", " \t\n "]) {
			await setPerson(seed.personId, { email, phone: PHONE });
			await expect(
				applySetMyPreferredContact({
					userId: seed.memberUserId,
					preferredContact: "email",
				}),
			).rejects.toThrow(CONTACT_METHOD_UNAVAILABLE_MESSAGE);
			expect(await stored(seed.personId)).toBeNull();
		}
		// And a real address still passes the same predicate.
		await setPerson(seed.personId, { email: "\tjane@example.com\n" });
		await applySetMyPreferredContact({
			userId: seed.memberUserId,
			preferredContact: "email",
		});
		expect(await stored(seed.personId)).toBe("email");
	});

	it("binds the email pattern as a parameter, backslash intact", () => {
		const { sql: text, params } = testDb
			.update(people)
			.set({ preferredContact: "email" })
			.where(contactMethodAvailableSql("email"))
			.toSQL();
		expect(text).toMatch(/coalesce\("people"\."email", ''\) ~ \$\d+/);
		expect(params).toContain("\\S");
		expect(params.find((p) => p === "\\S")).toHaveLength(2);
	});

	it("writes only the caller's own Person", async () => {
		// Everyone else can have email: an UPDATE missing its user predicate
		// would match them all.
		const bystander = await seedPerson({
			name: "Unlinked Bystander",
			email: "bystander@example.com",
			phone: PHONE,
		});
		orphanPersonIds.push(bystander);

		await applySetMyPreferredContact({
			userId: seed.memberUserId,
			preferredContact: "email",
		});

		expect(await stored(seed.personId)).toBe("email");
		expect(await stored(adminPersonId)).toBeNull();
		expect(await stored(bystander)).toBeNull();
	});

	it("the card's reader returns the EFFECTIVE value and what is available", async () => {
		await setPerson(seed.personId, { phone: PHONE });
		await applySetMyPreferredContact({
			userId: seed.memberUserId,
			preferredContact: "sms",
		});
		expect(await loadMyContactPreference(seed.memberUserId)).toEqual({
			linked: true,
			available: ["email", "call", "sms", "whatsapp"],
			preferredContact: "sms",
		});

		// The phone goes: the column keeps `sms`, the reader shows none.
		await setPerson(seed.personId, { phone: null });
		expect(await stored(seed.personId)).toBe("sms");
		expect(await loadMyContactPreference(seed.memberUserId)).toEqual({
			linked: true,
			available: ["email"],
			preferredContact: null,
		});
	});
});
