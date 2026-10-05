/**
 * DB-backed tests for who may write a Person's email (#306 → #755 → #756 → #907).
 *
 * The rule this file exists to hold (#907, ADR-0029): **email is a Person fact.**
 * A roster edit writes `people.email` — the one address, and the key a sign-in
 * binds on — but only while
 *   - nobody has signed in as that Person (`user_id IS NULL`), and
 *   - the editing club is the Person's SOLE holder.
 * Both predicates sit in the UPDATE's own WHERE, so a bind landing between the
 * form's load and its save makes the write a no-op. A refused email never
 * refuses the edit: the other fields still save, and the result says why.
 *
 * And the other half, the bind (`rosterPermitsBind`): a verified address binds
 * the one unbound Person whose own address it is, if a club holds them — with
 * no "exactly one club" arm any more, which is what lets a member of two clubs
 * sign in.
 *
 * Read the companions: `account-invite-logic.integration.test.ts` (the invite
 * and the claim) and `roster-obstacle.guard.test.ts` (the explainer matches the
 * bind over every roster shape).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/member-email-ownership.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, members, people, user } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyMemberEdit, editSchema } = await import("./members-logic");
const { bindVerifiedPerson, linkPersonToUser, rosterConflictFor } =
	await import("./account-link-logic");
const { loadUserClubMemberships } = await import("./auth-context-logic");

describe.skipIf(!hasTestDb)("member email ownership (#907)", () => {
	let club: SeededClub;
	/** Extra `user` rows minted by a test. `cleanup` only removes the ids it is
	 *  handed, so track them or they leak into the next run (CLAUDE.md). */
	let extraUserIds: string[];
	/** Extra clubs seeded by a test, cleaned up in reverse. */
	let extraClubs: SeededClub[];
	/** Persons with NO membership, which no club cleanup reaches. */
	let orphanPersonIds: string[];

	beforeEach(async () => {
		club = await seedClub();
		extraUserIds = [];
		extraClubs = [];
		orphanPersonIds = [];
	});
	afterEach(async () => {
		for (const c of extraClubs) {
			await cleanup(c.clubId, [c.adminUserId, c.memberUserId]);
		}
		await cleanup(club.clubId, [
			club.adminUserId,
			club.memberUserId,
			...extraUserIds,
		]);
		for (const id of orphanPersonIds) {
			await testDb.delete(people).where(eq(people.id, id));
		}
	});

	/** A sign-in account with `email`, cleaned up with the rest of the fixture. */
	async function seedUser(email: string): Promise<string> {
		const id = randomUUID();
		await testDb
			.insert(user)
			.values({ id, name: "", email, emailVerified: true });
		extraUserIds.push(id);
		return id;
	}

	/** A (person, membership) pair in the seeded club. */
	async function seedMember(opts: {
		email?: string | null;
		/** Set to make the Person a signed-in account (ADR-0008 people.user_id). */
		userId?: string | null;
		name?: string;
	}): Promise<{ memberId: string; personId: string }> {
		const name = opts.name ?? "Recon Person";
		const personId = await seedPerson({
			name,
			email: opts.email ?? null,
			userId: opts.userId ?? null,
		});
		const [member] = await testDb
			.insert(members)
			.values({ clubId: club.clubId, personId, name, clubRole: "member" })
			.returning({ id: members.id });
		if (!member) throw new Error("member insert failed");
		return { memberId: member.id, personId };
	}

	/** Put the same human on a SECOND club's roster (ADR-0008: one Person row). */
	async function alsoInAnotherClub(personId: string): Promise<SeededClub> {
		const other = await seedClub();
		extraClubs.push(other);
		await testDb.insert(members).values({
			clubId: other.clubId,
			personId,
			name: "Recon Person",
			clubRole: "member",
		});
		return other;
	}

	function edit(
		memberId: string,
		email: string | null | undefined,
		name = "Recon Person",
	) {
		return applyMemberEdit({
			actorMemberId: null,
			clubId: club.clubId,
			memberId,
			name,
			email,
		});
	}

	async function personEmail(personId: string): Promise<string | null> {
		const [row] = await testDb
			.select({ email: people.email })
			.from(people)
			.where(eq(people.id, personId));
		return row?.email ?? null;
	}

	async function memberName(memberId: string): Promise<string | null> {
		const [row] = await testDb
			.select({ name: members.name })
			.from(members)
			.where(eq(members.id, memberId));
		return row?.name ?? null;
	}

	async function editLog(memberId: string) {
		const [row] = await testDb
			.select({ detail: activityLog.detail })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, club.clubId),
					eq(activityLog.action, "member_edit"),
					eq(activityLog.targetId, memberId),
				),
			);
		return row?.detail as {
			before?: Record<string, unknown>;
			after?: Record<string, unknown>;
		};
	}

	describe("the officer edit", () => {
		it("corrects an UNBOUND, SINGLE-CLUB Person's address (typo repair)", async () => {
			const typo = `typo-${randomUUID()}@test.example`;
			const corrected = `corrected-${randomUUID()}@test.example`;
			const { memberId, personId } = await seedMember({ email: typo });

			const res = await edit(memberId, corrected);

			expect(res.emailRefused).toBeNull();
			expect(await personEmail(personId)).toBe(corrected);
		});

		it("refuses a BOUND Person's address with `bound`, and still saves the other fields", async () => {
			const proven = `proven-${randomUUID()}@test.example`;
			const userId = await seedUser(proven);
			const { memberId, personId } = await seedMember({
				email: proven,
				userId,
			});

			const res = await edit(
				memberId,
				`other-${randomUUID()}@test.example`,
				"Renamed Person",
			);

			expect(res.emailRefused).toBe("bound");
			expect(await personEmail(personId)).toBe(proven);
			expect(await memberName(memberId)).toBe("Renamed Person");
		});

		it("refuses with `multi_club` when another club holds the Person too, and still saves the other fields", async () => {
			const shared = `shared-${randomUUID()}@test.example`;
			const { memberId, personId } = await seedMember({ email: shared });
			await alsoInAnotherClub(personId);

			const res = await edit(
				memberId,
				`mine-${randomUUID()}@test.example`,
				"Renamed Person",
			);

			expect(res.emailRefused).toBe("multi_club");
			expect(await personEmail(personId)).toBe(shared);
			expect(await memberName(memberId)).toBe("Renamed Person");
		});

		it("holds when a bind lands between load and save — the guard is in the UPDATE", async () => {
			// The form loaded an unbound Person; the member signs in before the
			// officer saves. The writer is called with the STALE input after the
			// bind, and its own WHERE must make the write a no-op.
			const addr = `racer-${randomUUID()}@test.example`;
			const { memberId, personId } = await seedMember({ email: addr });
			const userId = await seedUser(addr);
			expect(await bindVerifiedPerson({ personId, userId })).toBe(true);

			const res = await edit(memberId, `stale-${randomUUID()}@test.example`);

			expect(res.emailRefused).toBe("bound");
			expect(await personEmail(personId)).toBe(addr);
		});

		it("an UNCHANGED address on a bound Person is not refused — case and whitespace included", async () => {
			const proven = `Proven-${randomUUID()}@Test.example`;
			const userId = await seedUser(proven.toLowerCase());
			const { memberId, personId } = await seedMember({
				email: proven,
				userId,
			});

			const res = await edit(
				memberId,
				`  ${proven.toUpperCase()} `,
				"Renamed Person",
			);

			expect(res.emailRefused).toBeNull();
			expect(await personEmail(personId)).toBe(proven);
			expect(await memberName(memberId)).toBe("Renamed Person");
			// Not part of the write, so not logged as a change either.
			const detail = await editLog(memberId);
			expect(Object.hasOwn(detail?.before ?? {}, "email")).toBe(false);
			expect(Object.hasOwn(detail?.after ?? {}, "email")).toBe(false);
		});

		it("clearing obeys the same rule as changing", async () => {
			const single = await seedMember({
				email: `clear-${randomUUID()}@test.example`,
			});
			expect((await edit(single.memberId, null)).emailRefused).toBeNull();
			expect(await personEmail(single.personId)).toBeNull();

			const shared = `kept-${randomUUID()}@test.example`;
			const multi = await seedMember({ email: shared, name: "Second Person" });
			await alsoInAnotherClub(multi.personId);
			expect(
				(await edit(multi.memberId, null, "Second Person")).emailRefused,
			).toBe("multi_club");
			expect(await personEmail(multi.personId)).toBe(shared);
		});

		it("a BLANK email through the validator clears the address", async () => {
			const { memberId, personId } = await seedMember({
				email: `blank-${randomUUID()}@test.example`,
			});

			const parsed = editSchema.parse({
				clubId: club.clubId,
				memberId,
				name: "Recon Person",
				email: "   ",
			});
			expect(parsed.email).toBeNull();
			await applyMemberEdit({ ...parsed, actorMemberId: null });

			expect(await personEmail(personId)).toBeNull();
		});

		it("an OMITTED email leaves the Person's address alone", async () => {
			const addr = `kept-${randomUUID()}@test.example`;
			const { memberId, personId } = await seedMember({ email: addr });

			const res = await edit(memberId, undefined);

			expect(res.emailRefused).toBeNull();
			expect(await personEmail(personId)).toBe(addr);
		});

		it("repairs a stored address carrying a NBSP that JS trim hides (#907 review)", async () => {
			// JS `.trim()` strips U+00A0 and SQL `[[:space:]]` does not, so a skip on
			// NORMALISED equality reported success while the bind kept failing.
			const clean = `nbsp-${randomUUID()}@test.example`;
			const { memberId, personId } = await seedMember({
				email: `${clean}\u00A0`,
			});

			const res = await edit(memberId, clean);

			expect(res.emailRefused).toBeNull();
			expect(await personEmail(personId)).toBe(clean);
			const userId = await seedUser(clean);
			expect((await linkPersonToUser(userId)).linkedPersonIds).toEqual([
				personId,
			]);
		});

		it("trims the address before it is stored", async () => {
			const addr = `padded-${randomUUID()}@test.example`;
			const { memberId, personId } = await seedMember({});

			await edit(memberId, `  ${addr}  `);

			expect(await personEmail(personId)).toBe(addr);
		});

		it("records the before/after address in the activity log when it is written", async () => {
			const before = `before-${randomUUID()}@test.example`;
			const after = `after-${randomUUID()}@test.example`;
			const { memberId } = await seedMember({ email: before });

			await edit(memberId, after);

			const detail = await editLog(memberId);
			expect(detail?.before?.email).toBe(before);
			expect(detail?.after?.email).toBe(after);
		});

		it("reports an address another Person already carries (it locks out both)", async () => {
			const shared = `household-${randomUUID()}@test.example`;
			await seedMember({ email: shared, name: "First Person" });
			const { memberId } = await seedMember({ name: "Second Person" });

			const res = await edit(memberId, shared, "Second Person");

			expect(res.emailRefused).toBeNull();
			expect(res.rosterConflict).toBe("shared_address");
		});

		it("a corrected address makes the next sign-in bind the Person", async () => {
			const corrected = `fixed-${randomUUID()}@test.example`;
			const { memberId, personId } = await seedMember({
				email: `typo-${randomUUID()}@test.example`,
			});

			await edit(memberId, corrected);
			const userId = await seedUser(corrected);

			expect((await linkPersonToUser(userId)).linkedPersonIds).toEqual([
				personId,
			]);
		});
	});

	describe("the sign-in bind", () => {
		it("binds a member of TWO clubs, who then sees both", async () => {
			const addr = `multi-${randomUUID()}@test.example`;
			const { personId } = await seedMember({ email: addr });
			const other = await alsoInAnotherClub(personId);
			const userId = await seedUser(addr);

			expect((await linkPersonToUser(userId)).linkedPersonIds).toEqual([
				personId,
			]);
			const clubIds = (await loadUserClubMemberships(userId))
				.map((m: { clubId: string }) => m.clubId)
				.sort();
			expect(clubIds).toEqual([club.clubId, other.clubId].sort());
		});

		it("binds neither of two unbound Persons sharing one address, and says why", async () => {
			const shared = `Shared-${randomUUID()}@test.example`;
			const a = await seedMember({ email: shared, name: "First Person" });
			const b = await seedMember({
				email: ` ${shared.toLowerCase()} `,
				name: "Second Person",
			});
			const userId = await seedUser(shared.toLowerCase());

			expect((await linkPersonToUser(userId)).linkedPersonIds).toEqual([]);
			for (const p of [a, b]) {
				expect(await bindVerifiedPerson({ personId: p.personId, userId })).toBe(
					false,
				);
				expect(await rosterConflictFor(p.personId, shared)).toBe(
					"shared_address",
				);
			}
		});

		it("a removed member's leftover Person does not lock them out when another club re-adds them", async () => {
			// Alice is removed from club A; `applyMemberRemove` deletes her roster
			// row and leaves her Person, still carrying alice@. Club B bulk-pastes
			// her as a fresh Person. Her sign-in must bind club B's Person — the
			// leftover is on no roster and nobody's account, so it vouches for
			// nothing and is no ambiguity.
			const { applyMemberRemove, applyBulkImport } = await import(
				"./members-logic"
			);
			const alice = `alice-${randomUUID()}@test.example`;
			const left = await seedMember({ email: alice, name: "Alice Left" });
			orphanPersonIds.push(left.personId);
			await applyMemberRemove({
				actorMemberId: null,
				clubId: club.clubId,
				memberId: left.memberId,
			});
			const clubB = await seedClub();
			extraClubs.push(clubB);
			const pasted = await applyBulkImport({
				actorMemberId: null,
				clubId: clubB.clubId,
				rows: [{ name: "Alice Again", email: alice, phone: "", office: "" }],
			});
			const [fresh] = await testDb
				.select({ personId: members.personId })
				.from(members)
				.where(eq(members.id, pasted.insertedIds[0] ?? ""));
			if (!fresh) throw new Error("bulk paste missing");
			const userId = await seedUser(alice);

			expect((await linkPersonToUser(userId)).linkedPersonIds).toEqual([
				fresh.personId,
			]);
			expect(await rosterConflictFor(left.personId, alice)).toBe(
				"no_vouching_row",
			);
		});

		it("does not bind a Person no club holds, whatever their address", async () => {
			const addr = `orphan-${randomUUID()}@test.example`;
			const personId = await seedPerson({ name: "Orphan", email: addr });
			orphanPersonIds.push(personId);
			const userId = await seedUser(addr);

			expect((await linkPersonToUser(userId)).linkedPersonIds).toEqual([]);
			expect(await bindVerifiedPerson({ personId, userId })).toBe(false);
			expect(await rosterConflictFor(personId, addr)).toBe("no_vouching_row");
		});
	});
});
