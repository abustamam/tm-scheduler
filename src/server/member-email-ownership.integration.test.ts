/**
 * DB-backed tests for who owns which email column (#306 → #755 → #756).
 *
 * The rule this file exists to hold: **a roster edit writes `members.email` and
 * nothing else.** `people.email` is the verified identity address — only a bind
 * against a magic-link-proved address writes it — so a club officer typing into
 * the roster form cannot move it, cannot be refused when they try, and has
 * nothing to be warned about.
 *
 * That is the inversion. The previous shape reconciled `people.email` from the
 * membership under a blast-radius guard, which worked but put the identity key
 * behind a predicate that had to be repeated at every writer; the enumeration
 * was wrong three review rounds running. There is no enumeration now.
 *
 * Read the companions for the other half: `account-link-logic.integration.test.ts`
 * (what the sign-in auto-link will and will not bind) and
 * `account-invite-logic.integration.test.ts` (the invite and the claim, and the
 * end-to-end typo repair).
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

const { applyMemberEdit } = await import("./members-logic");
const { linkPersonToUser } = await import("./account-link-logic");

describe.skipIf(!hasTestDb)("member email ownership (#756)", () => {
	let club: SeededClub;
	/** Extra `user` rows minted by a test. `cleanup` only removes the ids it is
	 *  handed, so track them or they leak into the next run (CLAUDE.md). */
	let extraUserIds: string[];
	/** Extra clubs seeded by a test, cleaned up in reverse. */
	let extraClubs: SeededClub[];

	beforeEach(async () => {
		club = await seedClub();
		extraUserIds = [];
		extraClubs = [];
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
		personEmail?: string | null;
		memberEmail?: string | null;
		/** Set to make the Person a signed-in account (ADR-0008 people.user_id). */
		personUserId?: string | null;
	}): Promise<{ memberId: string; personId: string }> {
		const personId = await seedPerson({
			name: "Recon Person",
			email: opts.personEmail ?? null,
			userId: opts.personUserId ?? null,
		});
		const [member] = await testDb
			.insert(members)
			.values({
				clubId: club.clubId,
				personId,
				name: "Recon Person",
				email: opts.memberEmail ?? null,
				clubRole: "member",
			})
			.returning({ id: members.id });
		if (!member) throw new Error("member insert failed");
		return { memberId: member.id, personId };
	}

	/** Put the same human on a SECOND club's roster (ADR-0008: one Person row). */
	async function alsoInAnotherClub(personId: string, email: string | null) {
		const other = await seedClub();
		extraClubs.push(other);
		await testDb.insert(members).values({
			clubId: other.clubId,
			personId,
			name: "Recon Person",
			email,
			clubRole: "member",
		});
		return other;
	}

	function edit(memberId: string, email: string | null) {
		return applyMemberEdit({
			actorMemberId: null,
			clubId: club.clubId,
			memberId,
			name: "Recon Person",
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

	async function memberEmail(memberId: string): Promise<string | null> {
		const [row] = await testDb
			.select({ email: members.email })
			.from(members)
			.where(eq(members.id, memberId));
		return row?.email ?? null;
	}

	it("does not rewrite an UNLINKED, SINGLE-CLUB Person's address", async () => {
		// THE discriminating case, and the reason it is first. Most of this file's
		// assertions hold under #755's guard as well — it refused the write for an
		// account holder and for a multi-club Person — so they are regression pins,
		// not the gate. This is the one fixture where the two models disagree on
		// every assertion: an unlinked Person held by one club was exactly what
		// #755's blast-radius predicate ALLOWED the roster form to overwrite, and
		// #756 says the form may not touch the column at all.
		const stale = `stale-${randomUUID()}@test.example`;
		const corrected = `corrected-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({
			personEmail: stale,
			memberEmail: stale,
		});

		await edit(memberId, corrected);

		expect(await memberEmail(memberId)).toBe(corrected);
		expect(await personEmail(personId)).toBe(stale);
	});

	it("writes the roster address and leaves the Person's untouched", async () => {
		const seeded = `seeded-${randomUUID()}@test.example`;
		const corrected = `corrected-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({
			personEmail: seeded,
			memberEmail: seeded,
		});

		await edit(memberId, corrected);

		expect(await memberEmail(memberId)).toBe(corrected);
		expect(await personEmail(personId)).toBe(seeded);
	});

	it("leaves an ACCOUNT HOLDER's proven address untouched", async () => {
		// REGRESSION PIN, not the gate: #755's guard refused this write too, so it
		// passes under both models. Kept because the REASON changed — it used to be
		// a refusal the admin had to be warned about, and is now simply not
		// something the form reaches. A work address on the membership and a
		// personal one on the Person is an ordinary, permanent state.
		const proven = `proven-${randomUUID()}@test.example`;
		const userId = await seedUser(proven);
		const { memberId, personId } = await seedMember({
			personEmail: proven,
			memberEmail: proven,
			personUserId: userId,
		});

		await edit(memberId, `work-${randomUUID()}@test.example`);

		expect(await personEmail(personId)).toBe(proven);
	});

	it("leaves the Person untouched when another club holds them too", async () => {
		// Regression pin — #755's blast-radius guard refused this one as well.
		const shared = `shared-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({
			personEmail: shared,
			memberEmail: shared,
		});
		await alsoInAnotherClub(personId, shared);

		await edit(memberId, `mine-${randomUUID()}@test.example`);

		expect(await personEmail(personId)).toBe(shared);
	});

	it("never SEEDS a person-level address that was not there before", async () => {
		// The state the migration leaves behind, and the one that must stay put: a
		// null `people.email` on an unlinked Person. Filling it from the roster is
		// what made a typed string an identity key in the first place.
		const { memberId, personId } = await seedMember({
			personEmail: null,
			memberEmail: null,
		});

		await edit(memberId, `typed-${randomUUID()}@test.example`);

		expect(await personEmail(personId)).toBeNull();
	});

	it("clearing the membership email leaves the Person's intact", async () => {
		const addr = `keep-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({
			personEmail: addr,
			memberEmail: addr,
		});

		await edit(memberId, null);

		expect(await memberEmail(memberId)).toBeNull();
		expect(await personEmail(personId)).toBe(addr);
	});

	it("trims the roster address before it is stored", async () => {
		// The read side normalises, but a padded value still reaches every screen
		// that renders the roster, and `applyMemberEdit` is exported and called
		// with the zod validator bypassed.
		const addr = `padded-${randomUUID()}@test.example`;
		const { memberId } = await seedMember({});

		await edit(memberId, `  ${addr}  `);

		expect(await memberEmail(memberId)).toBe(addr);
	});

	it("a corrected address makes sign-in linking resolve the membership", async () => {
		// The incident, end to end from the roster form: the member was created
		// under a typo, the admin fixes it, and the NEXT sign-in binds. Nothing
		// person-level is written until that bind happens.
		const corrected = `fixed-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({
			personEmail: null,
			memberEmail: `typo-${randomUUID()}@test.example`,
		});

		await edit(memberId, corrected);
		const userId = await seedUser(corrected);

		expect((await linkPersonToUser(userId)).linkedPersonIds).toEqual([
			personId,
		]);
		expect(await personEmail(personId)).toBe(corrected);
	});

	it("records the roster before/after in the activity log, and no sync verdict", async () => {
		// `personEmailSynced` was a three-state signal reporting whether the
		// person-level write landed. There is no person-level write, so a reader
		// finding the key at all would be reading a stale contract.
		const before = `before-${randomUUID()}@test.example`;
		const after = `after-${randomUUID()}@test.example`;
		const { memberId } = await seedMember({
			personEmail: before,
			memberEmail: before,
		});

		await edit(memberId, after);

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
		const detail = row?.detail as {
			before?: { email?: string | null };
			after?: { email?: string | null };
		} & Record<string, unknown>;
		expect(detail?.before?.email).toBe(before);
		expect(detail?.after?.email).toBe(after);
		expect(Object.hasOwn(detail ?? {}, "personEmailSynced")).toBe(false);
	});
});
