/**
 * DB-backed tests for account-linking on sign-in (#188, re-keyed by #756 and
 * again by #907).
 *
 * The match key is `people.email`, the Person's ONE address (ADR-0029). A
 * verified address binds a Person when it is their own address, nobody has
 * bound them, a club holds them (any membership, any status, any club), and no
 * OTHER Person carries it. There is no "exactly one club" arm any more: a club
 * may write the address only while it is the Person's sole holder and nobody
 * has signed in (`soleHoldingClub`), so a second club cannot re-key them, and a
 * member of two clubs can sign in.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/account-link-logic.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, members, people, user } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
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
		 *  The address is the Person's (#907): `personEmail`, else `memberEmail`
		 *  — the older name, kept so the cases below read as they did. */
		async function seedMember(opts: {
			clubId?: string;
			personEmail?: string | null;
			memberEmail?: string | null;
			personUserId?: string | null;
			personId?: string;
			status?: "active" | "inactive";
		}): Promise<{ personId: string; memberId: string }> {
			let personId = opts.personId;
			if (!personId) {
				const [row] = await testDb
					.insert(people)
					.values({
						name: "Roster Person",
						email: opts.personEmail ?? opts.memberEmail ?? null,
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
					clubRole: "member",
					status: opts.status ?? "active",
				})
				.returning({ id: members.id });
			if (!member) throw new Error("Failed to insert member");
			return { personId, memberId: member.id };
		}

		/** A second club holding the same Person. */
		async function alsoHeldBy(
			personId: string,
			opts: { status?: "active" | "inactive"; archived?: boolean } = {},
		): Promise<SeededClub> {
			const other = await seedClub();
			extraClubs.push(other);
			await seedMember({
				clubId: other.clubId,
				personId,
				status: opts.status,
			});
			if (opts.archived) {
				await testDb
					.update(clubs)
					.set({ archivedAt: new Date() })
					.where(eq(clubs.id, other.clubId));
			}
			return other;
		}

		async function personRow(personId: string) {
			const [row] = await testDb
				.select({ userId: people.userId, email: people.email })
				.from(people)
				.where(eq(people.id, personId));
			return row ?? null;
		}

		// ---------------------------------------------------------------------
		// The ordinary path
		// ---------------------------------------------------------------------

		it("links an unlinked Person whose email matches the signed-in user", async () => {
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

		it("matches the Person's email case-insensitively", async () => {
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

		it("matches an address padded with a TAB, not just spaces", async () => {
			// Postgres `trim()` strips spaces only, while JS `.trim()` strips every
			// Unicode space — so the two identity readers disagreed about a tab until
			// both sides were spelled `btrim(col, <whitespace>)`. A member matching on
			// the claim path and not on sign-in is the muted version of the lockout
			// this whole change exists to remove.
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const email = `tabbed-${randomUUID()}@test.example`;
			const { personId } = await seedMember({ memberEmail: `\t${email}\n` });
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
			// `user_id IS NULL` in the bind's own WHERE: a bound Person is never
			// re-bound, whoever signs in.
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const owner = `owner-${randomUUID()}@test.example`;
			const ownerId = await seedUser(owner);
			const attacker = `attacker-${randomUUID()}@test.example`;
			const { personId } = await seedMember({
				personEmail: owner,
				personUserId: ownerId,
			});
			const attackerId = await seedUser(attacker);

			expect((await linkPersonToUser(attackerId)).linkedPersonIds).toEqual([]);
			expect((await personRow(personId))?.userId).toBe(ownerId);
			expect((await personRow(personId))?.email).toBe(owner);
		});

		// ---------------------------------------------------------------------
		// Any club vouches — and several may (#907)
		//
		// Every membership counts, whatever its status or its club's: the arm
		// is "a club holds them", and a lapsed member is still someone a club
		// vouched for. What used to make a second club dangerous was that it
		// could type its own vouch; since #907 it cannot write the address at
		// all (`soleHoldingClub`), so the second club no longer refuses.
		// ---------------------------------------------------------------------

		it("binds a Person that TWO clubs hold (#907)", async () => {
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const email = `dual-${randomUUID()}@test.example`;
			const { personId } = await seedMember({ memberEmail: email });
			await alsoHeldBy(personId);
			const userId = await seedUser(email);

			expect((await linkPersonToUser(userId)).linkedPersonIds).toEqual([
				personId,
			]);
		});

		it("an INACTIVE membership elsewhere neither blocks nor is needed", async () => {
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const email = `lapsed-${randomUUID()}@test.example`;
			const { personId } = await seedMember({ memberEmail: email });
			await alsoHeldBy(personId, { status: "inactive" });
			const userId = await seedUser(email);

			expect((await linkPersonToUser(userId)).linkedPersonIds).toEqual([
				personId,
			]);
		});

		it("a membership in an ARCHIVED club still vouches", async () => {
			const { bindVerifiedPerson } = await import(
				"#/server/account-link-logic"
			);
			const email = `archived-${randomUUID()}@test.example`;
			const [person] = await testDb
				.insert(people)
				.values({ name: "Archived Holder", email })
				.returning({ id: people.id });
			if (!person) throw new Error("person insert failed");
			personIds.push(person.id);
			await alsoHeldBy(person.id, { archived: true });
			const userId = await seedUser(email);

			expect(await bindVerifiedPerson({ personId: person.id, userId })).toBe(
				true,
			);
		});

		it("an attacker attaching the Person to their own club cannot re-key or bind it", async () => {
			// The takeover, driven end to end against #907's model. Club A's admin
			// attaches a Person club B holds and types their OWN address onto it.
			// The roster edit refuses (`multi_club`), so the Person never carries
			// the attacker's address, and the attacker's sign-in binds nothing.
			const { bindVerifiedPerson } = await import(
				"#/server/account-link-logic"
			);
			const { applyMemberEdit } = await import("#/server/members-logic");
			const victim = `victim-${randomUUID()}@test.example`;
			const attacker = `attacker-${randomUUID()}@test.example`;
			const { personId } = await seedMember({
				memberEmail: victim,
				status: "inactive",
			});
			const attackerClub = await alsoHeldBy(personId);
			const rows = await testDb
				.select({ id: members.id, personId: members.personId })
				.from(members)
				.where(eq(members.clubId, attackerClub.clubId));
			const attachedId = rows.find((m) => m.personId === personId)?.id;
			if (!attachedId) throw new Error("attach missing");

			const edit = await applyMemberEdit({
				actorMemberId: null,
				clubId: attackerClub.clubId,
				memberId: attachedId,
				name: "Roster Person",
				email: attacker,
			});
			expect(edit.emailRefused).toBe("multi_club");
			const userId = await seedUser(attacker);

			expect(await bindVerifiedPerson({ personId, userId })).toBe(false);
			expect((await personRow(personId))?.userId).toBeNull();
			expect((await personRow(personId))?.email).toBe(victim);
		});

		it("refuses when the Person's own address is a different one", async () => {
			// The vouching arm, killed on its own. MUTATION NOTE: this must be driven
			// through `bindVerifiedPerson` DIRECTLY — routing it through
			// `linkPersonToUser` proves nothing, because the candidate query refuses
			// first for its own reasons and the bind is never reached. That is
			// exactly how the previous cut of this arm ended up untested: replacing
			// it with `sql`true`` left the whole suite green.
			const { bindVerifiedPerson } = await import(
				"#/server/account-link-logic"
			);
			const { personId } = await seedMember({
				memberEmail: `roster-${randomUUID()}@test.example`,
			});
			const userId = await seedUser(`other-${randomUUID()}@test.example`);

			expect(await bindVerifiedPerson({ personId, userId })).toBe(false);
			expect((await personRow(personId))?.userId).toBeNull();
		});

		it("refuses a Person with no memberships at all", async () => {
			// A club-less Person is nobody's member. `applyMemberRemove` leaves one
			// behind, as does undoing a guest conversion, and without the vouching
			// arm the two NOT EXISTS arms are vacuously true — so any address at all
			// would bind them.
			const { bindVerifiedPerson } = await import(
				"#/server/account-link-logic"
			);
			const nobody = `nobody-${randomUUID()}@test.example`;
			const [person] = await testDb
				.insert(people)
				.values({ name: "Club-less Person", email: nobody })
				.returning({ id: people.id });
			if (!person) throw new Error("person insert failed");
			personIds.push(person.id);
			const userId = await seedUser(nobody);

			expect(await bindVerifiedPerson({ personId: person.id, userId })).toBe(
				false,
			);
		});

		// ---------------------------------------------------------------------
		// Ambiguity across Persons
		// ---------------------------------------------------------------------

		it("does not bind when one address resolves to two distinct Persons", async () => {
			// A shared household address is real (`listDuplicatePeople` exists because
			// of it), and ADR-0008 says never to auto-merge on one.
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const shared = `household-${randomUUID()}@test.example`;
			const a = await seedMember({ memberEmail: shared });
			const b = await seedMember({ memberEmail: shared });
			const userId = await seedUser(shared);

			expect((await linkPersonToUser(userId)).linkedPersonIds).toEqual([]);
			expect((await personRow(a.personId))?.userId).toBeNull();
			expect((await personRow(b.personId))?.userId).toBeNull();
		});

		it("an ALREADY-LINKED Person still counts toward that ambiguity", async () => {
			// The spouse case, and the reason the unlinked filter cannot live inside
			// the candidate count. Alice and Bob share a household address on one
			// club's roster. Alice claims her own row explicitly, so she is linked.
			// If linked Persons stopped counting, Bob would become the sole candidate
			// on Alice's NEXT sign-in and bind to HER account — handing her his
			// membership and his roles.
			const { linkPersonToUser } = await import("#/server/account-link-logic");
			const shared = `spouses-${randomUUID()}@test.example`;
			const aliceUserId = await seedUser(shared);
			const alice = await seedMember({
				memberEmail: shared,
				personUserId: aliceUserId,
			});
			const bob = await seedMember({ memberEmail: shared });

			expect((await linkPersonToUser(aliceUserId)).linkedPersonIds).toEqual([]);
			expect((await personRow(bob.personId))?.userId).toBeNull();
			expect((await personRow(alice.personId))?.userId).toBe(aliceUserId);
		});

		it("the ambiguity arm refuses the explicit CLAIM too, not just sign-in", async () => {
			// Killed on its own, through the path that reaches the bind without the
			// candidate count: picking a name is a claim, not proof, and both spouses
			// read the same inbox.
			const { bindVerifiedPerson } = await import(
				"#/server/account-link-logic"
			);
			const shared = `claim-ambig-${randomUUID()}@test.example`;
			await seedMember({ memberEmail: shared });
			const bob = await seedMember({ memberEmail: shared });
			const userId = await seedUser(shared);

			expect(await bindVerifiedPerson({ personId: bob.personId, userId })).toBe(
				false,
			);
		});

		// ---------------------------------------------------------------------
		// The write guards itself
		// ---------------------------------------------------------------------

		it("bindVerifiedPerson refuses on its own, without the resolver's help", async () => {
			// The rule lives in the UPDATE's WHERE, not in a SELECT the caller ran
			// first. A separate read-then-write left a window in which a row
			// inserted between the two produced a bind the predicate would have
			// refused; folding it into the statement closes the round-trip gap and
			// makes the write safe for any future caller that forgets to check.
			const { bindVerifiedPerson } = await import(
				"#/server/account-link-logic"
			);
			const email = `self-guard-${randomUUID()}@test.example`;
			const { personId } = await seedMember({ memberEmail: email });
			await seedMember({ memberEmail: email.toUpperCase() });
			const userId = await seedUser(email);

			expect(await bindVerifiedPerson({ personId, userId })).toBe(false);
			expect((await personRow(personId))?.userId).toBeNull();
		});

		it("bindVerifiedPerson reads the verified address itself, not from the caller", async () => {
			// The name is only honest if the address cannot come from the caller. A
			// third call site passing a typed string would otherwise re-introduce the
			// whole defect with every guard green.
			const { bindVerifiedPerson } = await import(
				"#/server/account-link-logic"
			);
			const email = `self-read-${randomUUID()}@test.example`;
			const { personId } = await seedMember({ memberEmail: email });
			const userId = await seedUser(email);

			expect(await bindVerifiedPerson({ personId, userId })).toBe(true);
			expect((await personRow(personId))?.email).toBe(email);
		});

		it("holds the READ COMMITTED line honestly: a row committed first refuses", async () => {
			// What the statement DOES guarantee, stated as the test rather than as a
			// comment. `openBlockingTx` holds an uncommitted second Person carrying
			// the same address; the bind is not blocked by it (different rows) and
			// would succeed against its own snapshot — so this commits FIRST and
			// asserts the refusal comes from the UPDATE itself, with no caller-side
			// re-check. The uncommitted case is the phantom recorded in
			// CODING_STANDARDS, not a guarantee.
			const { bindVerifiedPerson } = await import(
				"#/server/account-link-logic"
			);
			const email = `mid-flight-${randomUUID()}@test.example`;
			const { personId } = await seedMember({ memberEmail: email });
			const userId = await seedUser(email);

			let otherId = "";
			const writer = await openBlockingTx(async (tx) => {
				const [row] = await tx
					.insert(people)
					.values({ name: "Second Holder", email })
					.returning({ id: people.id });
				otherId = row?.id ?? "";
			});
			await writer.commit();
			personIds.push(otherId);

			expect(await bindVerifiedPerson({ personId, userId })).toBe(false);
			expect((await personRow(personId))?.userId).toBeNull();
		});
	},
);
