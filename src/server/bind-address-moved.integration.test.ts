/**
 * The bind re-checks, IN ITS OWN STATEMENT, that the account still signs in
 * with the address it read (#1091 review).
 *
 * `bindVerifiedPerson` reads the account's address with `verifiedEmailFor`,
 * then runs its UPDATE. A change of sign-in address confirmed between the two
 * moves the account (and its bound Person) off that address. Without the
 * re-check the bind then stamps the OLD address onto a second Person and binds
 * it — and the household arm, which used to refuse that because the bound
 * Person carried the same address, no longer sees anyone else holding it.
 *
 * The interleaving is driven deterministically: `#/db` is the test client
 * wrapped so that the bind's `update(people)` runs a hook just before it is
 * sent — after the read, before the write, the exact window.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/bind-address-moved.integration.test.ts
 */
import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { members, people, user } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

/** Runs once, just before the next `update(people)` is sent, then clears. */
const hook: { before: null | (() => Promise<void>) } = { before: null };

vi.mock("#/db", async () => {
	const { testDb: real } = await import("#/test/db");
	const { people: peopleTable } = await import("#/db/schema");
	type Chain = {
		set: (v: unknown) => {
			where: (w: unknown) => { returning: (f: unknown) => Promise<unknown> };
		};
	};
	const db = new Proxy(real, {
		get: (target, prop, receiver) =>
			prop === "update"
				? (table: unknown) => {
						const chain = (target.update as unknown as (t: unknown) => Chain)(
							table,
						);
						if (table !== peopleTable) return chain;
						return {
							set: (v: unknown) => ({
								where: (w: unknown) => ({
									returning: async (f: unknown) => {
										const before = hook.before;
										hook.before = null;
										if (before) await before();
										return chain.set(v).where(w).returning(f);
									},
								}),
							}),
						};
					}
				: Reflect.get(target, prop, receiver),
	});
	return { db };
});

const { bindVerifiedPerson } = await import("./account-link-logic");

describe.skipIf(!hasTestDb)("the bind and a concurrent address change", () => {
	const SUFFIX = randomBytes(4).toString("hex");
	let club: SeededClub | null = null;
	const personIds: string[] = [];

	afterEach(async () => {
		hook.before = null;
		if (club) await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		if (personIds.length > 0) {
			await testDb.delete(people).where(inArray(people.id, personIds));
		}
		club = null;
		personIds.length = 0;
	});

	/**
	 * The member's account is bound to its Person; a SECOND, unbound Person on
	 * the roster carries the same address (a household pair, or a duplicate).
	 * Today the household arm refuses binding the second one.
	 */
	async function seedSecondCarrier(): Promise<{
		c: SeededClub;
		oldAddress: string;
		secondId: string;
	}> {
		const c = await seedClub();
		club = c;
		const [account] = await testDb
			.select({ email: user.email })
			.from(user)
			.where(eq(user.id, c.memberUserId));
		const oldAddress = account?.email ?? "";
		const [second] = await testDb
			.insert(people)
			.values({ name: "Second", email: oldAddress })
			.returning({ id: people.id });
		if (!second) throw new Error("no person");
		personIds.push(second.id);
		await testDb.insert(members).values({
			clubId: c.clubId,
			personId: second.id,
			name: "Second",
			clubRole: "member",
			status: "active",
		});
		return { c, oldAddress, secondId: second.id };
	}

	it("refuses when the account's address moved between the read and the write", async () => {
		const { c, secondId } = await seedSecondCarrier();
		const moved = `moved-${SUFFIX}@test.example`;
		// What a confirmed change commits: the account AND its bound Person.
		hook.before = async () => {
			await testDb
				.update(user)
				.set({ email: moved })
				.where(eq(user.id, c.memberUserId));
			await testDb
				.update(people)
				.set({ email: moved })
				.where(eq(people.id, c.personId));
		};

		const bound = await bindVerifiedPerson({
			personId: secondId,
			userId: c.memberUserId,
		});

		expect(bound).toBe(false);
		const [second] = await testDb
			.select({ userId: people.userId })
			.from(people)
			.where(eq(people.id, secondId));
		expect(second?.userId).toBeNull();
	});

	it("still binds when nothing moved (control)", async () => {
		const c = await seedClub();
		club = c;
		const [account] = await testDb
			.select({ email: user.email })
			.from(user)
			.where(eq(user.id, c.memberUserId));
		// Unbind the seeded Person so the ordinary bind has something to do.
		await testDb
			.update(people)
			.set({ userId: null })
			.where(eq(people.id, c.personId));
		hook.before = async () => {};

		expect(
			await bindVerifiedPerson({
				personId: c.personId,
				userId: c.memberUserId,
			}),
		).toBe(true);
		const [p] = await testDb
			.select({ userId: people.userId, email: people.email })
			.from(people)
			.where(eq(people.id, c.personId));
		expect(p).toEqual({ userId: c.memberUserId, email: account?.email });
	});
});
