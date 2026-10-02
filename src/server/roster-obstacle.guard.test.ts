/**
 * `rosterConflictFor` is the EXACT COMPLEMENT of the bind's own predicate.
 *
 * Why this file exists. The two are written separately — one is a WHERE clause
 * inside an UPDATE, the other three SELECTs — and every surface that refuses
 * before acting (`prepareMemberInvite`, the roster edit form, the superadmin
 * admin-email repair) asks the SELECT while the actual decision is made by the
 * WHERE. When an earlier cut let them drift by one arm, the invite reported
 * `ready` for a member no roster row vouched for, Better-Auth minted a real
 * account, and the claim then refused — the silent half-failure this whole
 * release exists to delete, reappearing inside the code written to delete it.
 *
 * A behavioural test of either one alone cannot see that. This one asserts them
 * against EACH OTHER over a matrix of roster shapes: for every fixture, the bind
 * lands if and only if the explainer says there is no obstacle. A new arm added
 * to one and not the other fails here.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/roster-obstacle.guard.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, members, people, user } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("rosterConflictFor complements the bind", () => {
	let club: SeededClub;
	let extraClubs: SeededClub[];
	let personIds: string[];
	let userIds: string[];

	beforeEach(async () => {
		club = await seedClub();
		extraClubs = [];
		personIds = [];
		userIds = [];
	});
	afterEach(async () => {
		for (const c of extraClubs) {
			await cleanup(c.clubId, [c.adminUserId, c.memberUserId]);
		}
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		if (personIds.length > 0) {
			await testDb.delete(people).where(inArray(people.id, personIds));
		}
		if (userIds.length > 0) {
			await testDb.delete(user).where(inArray(user.id, userIds));
		}
	});

	async function seedUser(email: string): Promise<string> {
		const id = randomUUID();
		await testDb
			.insert(user)
			.values({ id, name: "Signed-in", email, emailVerified: true });
		userIds.push(id);
		return id;
	}

	async function newPerson(email: string | null = null): Promise<string> {
		const [row] = await testDb
			.insert(people)
			.values({ name: "Matrix Person", email })
			.returning({ id: people.id });
		if (!row) throw new Error("person insert failed");
		personIds.push(row.id);
		return row.id;
	}

	async function setEmail(personId: string, email: string | null) {
		await testDb.update(people).set({ email }).where(eq(people.id, personId));
	}

	async function addMembership(opts: {
		personId: string;
		clubId?: string;
		status?: "active" | "inactive";
	}): Promise<void> {
		await testDb.insert(members).values({
			clubId: opts.clubId ?? club.clubId,
			personId: opts.personId,
			name: "Matrix Person",
			status: opts.status ?? "active",
		});
	}

	async function otherClub(archived = false): Promise<string> {
		const other = await seedClub();
		extraClubs.push(other);
		if (archived) {
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, other.clubId));
		}
		return other.clubId;
	}

	/**
	 * Every roster shape the rule distinguishes (#907). `expected` is what the
	 * explainer must say; the bind must land exactly when it is null.
	 */
	const SHAPES: Array<{
		name: string;
		expected: "no_vouching_row" | "shared_address" | null;
		build: (personId: string, address: string) => Promise<void>;
	}> = [
		{
			name: "one club, the Person carries the address",
			expected: null,
			build: async (personId, address) => {
				await setEmail(personId, address);
				await addMembership({ personId });
			},
		},
		{
			name: "the Person carries it padded and in another case",
			expected: null,
			build: async (personId, address) => {
				await setEmail(personId, `  ${address.toUpperCase()}\t`);
				await addMembership({ personId });
			},
		},
		{
			name: "one club, the Person carries a DIFFERENT address",
			expected: "no_vouching_row",
			build: async (personId) => {
				await setEmail(personId, `other-${randomUUID()}@t.example`);
				await addMembership({ personId });
			},
		},
		{
			name: "one club, the Person carries NO address",
			expected: "no_vouching_row",
			build: async (personId) => addMembership({ personId }),
		},
		{
			name: "the address, but no memberships at all",
			expected: "no_vouching_row",
			build: async (personId, address) => setEmail(personId, address),
		},
		{
			name: "TWO clubs hold the Person (the arm #907 removed)",
			expected: null,
			build: async (personId, address) => {
				await setEmail(personId, address);
				await addMembership({ personId });
				await addMembership({ personId, clubId: await otherClub() });
			},
		},
		{
			name: "only an INACTIVE membership, in an ARCHIVED club",
			expected: null,
			build: async (personId, address) => {
				await setEmail(personId, address);
				await addMembership({
					personId,
					clubId: await otherClub(true),
					status: "inactive",
				});
			},
		},
		{
			name: "ANOTHER Person in this club carries the address",
			expected: "shared_address",
			build: async (personId, address) => {
				await setEmail(personId, address);
				await addMembership({ personId });
				await addMembership({ personId: await newPerson(address) });
			},
		},
		{
			name: "another, already-SIGNED-IN Person carries it",
			expected: "shared_address",
			build: async (personId, address) => {
				await setEmail(personId, address);
				await addMembership({ personId });
				const other = await newPerson(address);
				await addMembership({ personId: other });
				await testDb
					.update(people)
					.set({ userId: await seedUser(`bound-${randomUUID()}@t.example`) })
					.where(eq(people.id, other));
			},
		},
		{
			name: "another Person in NO club carries it",
			expected: "shared_address",
			build: async (personId, address) => {
				await setEmail(personId, address);
				await addMembership({ personId });
				await newPerson(` ${address.toUpperCase()}`);
			},
		},
	];

	for (const shape of SHAPES) {
		it(`${shape.name} → ${shape.expected ?? "binds"}`, async () => {
			const { bindVerifiedPerson, rosterConflictFor } = await import(
				"#/server/account-link-logic"
			);
			const address = `matrix-${randomUUID()}@test.example`;
			const personId = await newPerson();
			await shape.build(personId, address);
			const userId = await seedUser(address);

			const obstacle = await rosterConflictFor(personId, address);
			const bound = await bindVerifiedPerson({ personId, userId });

			// The explainer said the right thing…
			expect(obstacle, "the explainer named the wrong obstacle").toBe(
				shape.expected,
			);
			// …and — the point of this file — the bind AGREES with it.
			expect(
				bound,
				obstacle
					? `the explainer says "${obstacle}" but the bind LANDED — the two predicates have drifted`
					: "the explainer says the bind is permitted but it REFUSED — the two predicates have drifted",
			).toBe(obstacle === null);
		});
	}

	it("covers every obstacle the type declares", () => {
		// A new `RosterObstacle` member with no fixture would leave the complement
		// unverified for exactly the case it was added to describe.
		const covered = new Set(SHAPES.map((s) => s.expected).filter(Boolean));
		expect([...covered].sort()).toEqual(["no_vouching_row", "shared_address"]);
	});
});
