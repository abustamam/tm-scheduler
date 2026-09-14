/**
 * DB-backed tests for account-linking on sign-in (#188, re-keyed by #756).
 *
 * The match key is `members.email` — the club's own contact record — NOT
 * `people.email`. `people.email` is now the VERIFIED identity address: the bind
 * writes it from the address a magic link just proved, and nothing else does.
 * So a club-scoped actor can no longer type a value that decides who a Person
 * becomes; the worst they can do is point their own club's contact row at
 * themselves, which is a row they already own.
 *
 * Binding from a membership address needs the Person to be held by exactly ONE
 * club, because `members.email` is a column any officer of any of that Person's
 * clubs controls. That is the whole blast-radius rule, and it lives at this one
 * read site.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/account-link-logic.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members, people, user } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)(
	"linkPersonToUser (account link on sign-in)",
	() => {
		let club: SeededClub;
		/** Extra clubs seeded by a test, cleaned up before the primary one. */
		let extraClubs: SeededClub[];
		/** Club-less Person rows a test minted directly. `cleanup` cascades from a
		 *  CLUB, so anything it does not reach must be tracked and deleted here or
		 *  it leaks into the next run (CLAUDE.md). */
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

		/** Insert a Better-Auth user row and return its id. */
		async function seedUser(email: string): Promise<string> {
			const id = randomUUID();
			await testDb
				.insert(user)
				.values({ id, name: "Signed-in", email, emailVerified: true });
			userIds.push(id);
			return id;
		}

		/** A Person plus a membership on `clubId` (default: the seeded club).
		 *  `personEmail` is the person-level column the new model reserves for a
		 *  verified address; `memberEmail` is the club's contact record. */
		async function seedMember(opts: {
			clubId?: string;
			personEmail?: string | null;
			memberEmail?: string | null;
			personUserId?: string | null;
			personId?: string;
		}): Promise<{ personId: string; memberId: string }> {
			let personId = opts.personId;
			if (!personId) {
				const [row] = await testDb
					.insert(people)
					.values({
						name: "Roster Person",
						email: opts.personEmail ?? null,
						userId: opts.personUserId ?? null,
					})
					.returning({ id: people.id });
				if (!row) throw new Error("Failed to insert person");
				personId = row.id;
				personIds.push(personId);
			}
			const [member] = await testDb
				.insert(members)
				.values({
					clubId: opts.clubId ?? club.clubId,
					personId,
					name: "Roster Person",
					email: opts.memberEmail ?? null,
					clubRole: "member",
				})
				.returning({ id: members.id });
			if (!member) throw new Error("Failed to insert member");
			return { personId, memberId: member.id };
		}

		async function personRow(personId: string) {
			const [row] = await testDb
				.select({ userId: people.userId, email: people.email })
				.from(people)
				.where(eq(people.id, personId));
			return row ?? null;
		}

		it("links an unlinked Person whose membership email matches the signed-in user", async () => {
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const email = `match-${randomUUID()}@test.example`;
			const { personId } = await seedMember({ memberEmail: email });
			const userId = await seedUser(email);

			const result = await linkPersonToUser(userId);

			expect(result.linkedPersonIds).toEqual([personId]);
			expect((await personRow(personId))?.userId).toBe(userId);
		});

		it("stamps the VERIFIED address onto the Person when it binds", async () => {
			// The bind is the only writer of `people.email`, and this is what makes
			// the column mean "an address this human proved they own" rather than
			// "whatever an officer last typed".
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const email = `stamp-${randomUUID()}@test.example`;
			const { personId } = await seedMember({ memberEmail: email });
			const userId = await seedUser(email);

			await linkPersonToUser(userId);

			expect((await personRow(personId))?.email).toBe(email);
		});

		it("ordering: Person provisioned AFTER the user already signed in links on a later sign-in", async () => {
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const email = `later-${randomUUID()}@test.example`;
			// User exists first, no roster row yet — early sign-ins are a no-op.
			const userId = await seedUser(email);
			expect((await linkPersonToUser(userId)).linkedPersonIds).toEqual([]);

			const { personId } = await seedMember({ memberEmail: email });
			const result = await linkPersonToUser(userId);
			expect(result.linkedPersonIds).toEqual([personId]);
			expect((await personRow(personId))?.userId).toBe(userId);
		});

		it("matches the membership email case-insensitively", async () => {
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const token = randomUUID();
			const { personId } = await seedMember({
				memberEmail: `Mixed.Case-${token}@Test.Example`,
			});
			const userId = await seedUser(`mixed.case-${token}@test.example`);

			expect((await linkPersonToUser(userId)).linkedPersonIds).toEqual([
				personId,
			]);
		});

		it("matches a PADDED membership address, and stores the verified one", async () => {
			// The CSV importer and the guest pipeline both write `members.email`
			// without a trim, so the read side has to normalise or a stray space
			// silently costs the member their sign-in.
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const email = `padded-${randomUUID()}@test.example`;
			const { personId } = await seedMember({ memberEmail: `  ${email} ` });
			const userId = await seedUser(email);

			expect((await linkPersonToUser(userId)).linkedPersonIds).toEqual([
				personId,
			]);
			expect((await personRow(personId))?.email).toBe(email);
		});

		it("no matching membership is a no-op (user still lands, just unlinked)", async () => {
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const { personId } = await seedMember({
				memberEmail: `roster-${randomUUID()}@test.example`,
			});
			const userId = await seedUser(`other-${randomUUID()}@test.example`);

			expect((await linkPersonToUser(userId)).linkedPersonIds).toEqual([]);
			expect((await personRow(personId))?.userId).toBeNull();
		});

		it("is idempotent: repeated sign-ins don't error or change an already-linked Person", async () => {
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const email = `idem-${randomUUID()}@test.example`;
			const { personId } = await seedMember({ memberEmail: email });
			const userId = await seedUser(email);

			expect((await linkPersonToUser(userId)).linkedPersonIds).toEqual([
				personId,
			]);
			// Second sign-in: nothing newly linked, the link intact.
			expect((await linkPersonToUser(userId)).linkedPersonIds).toEqual([]);
			expect((await personRow(personId))?.userId).toBe(userId);
		});

		it("never reassigns a Person who already holds an account", async () => {
			// The protection that used to be a WRITE guard (`user_id IS NULL` on
			// every writer of `people.email`) is now a read-side one, and it has to
			// hold just as hard: an officer who retypes `members.email` to their own
			// address on a member who has already signed in must not inherit them.
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const owner = `owner-${randomUUID()}@test.example`;
			const ownerId = await seedUser(owner);
			const attacker = `attacker-${randomUUID()}@test.example`;
			const { personId } = await seedMember({
				personEmail: owner,
				memberEmail: attacker,
				personUserId: ownerId,
			});
			const attackerId = await seedUser(attacker);

			expect((await linkPersonToUser(attackerId)).linkedPersonIds).toEqual([]);
			expect((await personRow(personId))?.userId).toBe(ownerId);
			expect((await personRow(personId))?.email).toBe(owner);
		});

		it("does NOT bind from a person-level address nobody has verified", async () => {
			// The inversion, stated directly. `people.email` is written at Person
			// CREATION by the CSV importer, the guest-book conversion and the
			// create-club form, all from values a club-scoped actor typed — it is a
			// dedupe hint, not a credential. Binding from it is what let a typo (and,
			// with another club on the row, a deliberate retarget) decide who a
			// Person becomes.
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const email = `person-only-${randomUUID()}@test.example`;
			const { personId } = await seedMember({
				personEmail: email,
				memberEmail: null,
			});
			const userId = await seedUser(email);

			expect((await linkPersonToUser(userId)).linkedPersonIds).toEqual([]);
			expect((await personRow(personId))?.userId).toBeNull();
		});

		it("does not auto-link a Person that TWO clubs hold", async () => {
			// `members.email` is a column any officer of any of this Person's clubs
			// controls, so it cannot be the key that binds a Person more than one
			// club relies on. Club A's officer typing their own address onto their
			// membership row would otherwise inherit club B's membership at whatever
			// role the victim held.
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const other = await seedClub();
			extraClubs.push(other);
			const attacker = `attacker-${randomUUID()}@test.example`;
			const { personId } = await seedMember({ memberEmail: attacker });
			await seedMember({ clubId: other.clubId, personId, memberEmail: null });
			const userId = await seedUser(attacker);

			expect((await linkPersonToUser(userId)).linkedPersonIds).toEqual([]);
			expect((await personRow(personId))?.userId).toBeNull();
			expect((await personRow(personId))?.email).toBeNull();
		});

		it("does not bind when one address resolves to two distinct Persons", async () => {
			// A shared household address is real (`listDuplicatePeople` exists because
			// of it), and ADR-0008 says never to auto-merge on one. Two candidates is
			// an ambiguity, and guessing is how you hand someone their spouse's club.
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const shared = `household-${randomUUID()}@test.example`;
			const a = await seedMember({ memberEmail: shared });
			const b = await seedMember({ memberEmail: shared });
			const userId = await seedUser(shared);

			expect((await linkPersonToUser(userId)).linkedPersonIds).toEqual([]);
			expect((await personRow(a.personId))?.userId).toBeNull();
			expect((await personRow(b.personId))?.userId).toBeNull();
		});

		it("a Person already linked to someone else does not block a fresh candidate", async () => {
			// The duplicate-Person case: the same human has an old linked row and a
			// new unlinked one on the same address. The linked row is not a
			// candidate, so it must not count towards the ambiguity test.
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const email = `dupe-${randomUUID()}@test.example`;
			const userId = await seedUser(email);
			await seedMember({ memberEmail: email, personUserId: userId });
			const fresh = await seedMember({ memberEmail: email });

			expect((await linkPersonToUser(userId)).linkedPersonIds).toEqual([
				fresh.personId,
			]);
		});
	},
);
