/**
 * DB-backed tests for members ↔ people email reconciliation (#306). When a
 * member edit sets a membership email, `applyMemberEdit` reconciles it up to
 * `people.email` — removing at the source the divergence that made the #266
 * emailless-claim takeover possible. Two arms, and the second one is the reason
 * this file exists in its current shape:
 *
 *  1. SEED — the Person has no email yet. The original #306 gap-fill.
 *  2. CORRECT — the Person is unlinked and carries the exact address THIS
 *     membership is carrying, i.e. the one it seeded. A typo is repairable.
 *
 * Arm 2 replaced a flat "never overwrites an existing Person email" rule that
 * was too broad, and was a live production incident before it was narrowed:
 * `people.email` is the auth match key (`linkPersonToUser`), the invite target
 * and the public-claim key, so a member created under a mistyped address could
 * be "corrected" on the roster and stay permanently locked out of the app,
 * landing on `NoClubScreen` while the roster displayed the right address. The
 * two protections that rule was actually reaching for survive as their own
 * cases below: a LINKED Person's verified address is never moved, and an
 * address a DIFFERENT club recorded is never clobbered.
 *
 * Tests the plain logic fn directly against the test DB (`#/db` → test DB).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/member-email-reconciliation.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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

const { applyMemberEdit } = await import("./members-logic");
const { linkPersonToUser } = await import("./account-link-logic");

describe.skipIf(!hasTestDb)("member email reconciliation (#306)", () => {
	let club: SeededClub;
	/** Extra `user` rows minted by a test. `cleanup` only removes the ids it is
	 *  handed, so track them or they leak into the next run (CLAUDE.md). */
	let extraUserIds: string[];

	beforeEach(async () => {
		club = await seedClub();
		extraUserIds = [];
	});
	afterEach(async () => {
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

	/** Insert a (person, membership) pair in the seeded club. `personEmail` sets
	 *  the Person email; `memberEmail` sets the membership email (defaults null). */
	async function seedMember(opts: {
		personEmail?: string | null;
		memberEmail?: string | null;
		/** Set to make the Person a signed-in account (ADR-0008 people.user_id). */
		personUserId?: string | null;
	}): Promise<{ memberId: string; personId: string }> {
		const [person] = await testDb
			.insert(people)
			.values({
				name: "Recon Person",
				email: opts.personEmail ?? null,
				userId: opts.personUserId ?? null,
			})
			.returning({ id: people.id });
		if (!person) throw new Error("person insert failed");
		const [member] = await testDb
			.insert(members)
			.values({
				clubId: club.clubId,
				personId: person.id,
				name: "Recon Person",
				email: opts.memberEmail ?? null,
				clubRole: "member",
			})
			.returning({ id: members.id });
		if (!member) throw new Error("member insert failed");
		return { memberId: member.id, personId: person.id };
	}

	async function personEmail(personId: string): Promise<string | null> {
		const [row] = await testDb
			.select({ email: people.email })
			.from(people)
			.where(eq(people.id, personId));
		return row?.email ?? null;
	}

	async function personUserId(personId: string): Promise<string | null> {
		const [row] = await testDb
			.select({ userId: people.userId })
			.from(people)
			.where(eq(people.id, personId));
		return row?.userId ?? null;
	}

	async function memberEmail(memberId: string): Promise<string | null> {
		const [row] = await testDb
			.select({ email: members.email })
			.from(members)
			.where(eq(members.id, memberId));
		return row?.email ?? null;
	}

	it("copies the membership email up when the Person has none", async () => {
		const { memberId, personId } = await seedMember({
			personEmail: null,
			memberEmail: null,
		});
		const email = `copyup-${randomUUID()}@test.example`;

		await applyMemberEdit({
			actorMemberId: null,
			clubId: club.clubId,
			memberId,
			name: "Recon Person",
			email,
		});

		expect(await personEmail(personId)).toBe(email);
		expect(await memberEmail(memberId)).toBe(email);
	});

	it("corrects the Person email when this membership seeded the stale value", async () => {
		// The production shape: a member created under a typo, so BOTH rows carry
		// it, and nobody has signed in as this Person. Before the correction arm
		// this assertion read `toBe(typo)` — the roster showed the fixed address
		// while `linkPersonToUser` kept matching the typo, and the member was
		// stranded on "You're not in a club yet" with no way for an admin to see
		// why, or to repair it through the UI.
		const typo = `jensivarn-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({
			personEmail: typo,
			memberEmail: typo,
		});
		const corrected = `jensivorn-${randomUUID()}@test.example`;

		await applyMemberEdit({
			actorMemberId: null,
			clubId: club.clubId,
			memberId,
			name: "Recon Person",
			email: corrected,
		});

		expect(await personEmail(personId)).toBe(corrected);
		expect(await memberEmail(memberId)).toBe(corrected);
	});

	it("a corrected address makes sign-in linking resolve the membership", async () => {
		// The correction is only worth anything if it reaches the auth match key.
		// Drives the actual user flow end to end: correct the typo, then run the
		// sign-in hook for the account that owns the corrected address and assert
		// the Person binds to it. Without the correction arm this links nothing and
		// the user lands club-less — the incident, reproduced.
		const typo = `typo-${randomUUID()}@test.example`;
		const corrected = `real-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({
			personEmail: typo,
			memberEmail: typo,
		});
		const userId = await seedUser(corrected);

		await applyMemberEdit({
			actorMemberId: null,
			clubId: club.clubId,
			memberId,
			name: "Recon Person",
			email: corrected,
		});
		const { linkedPersonIds } = await linkPersonToUser(userId);

		expect(linkedPersonIds).toContain(personId);
		expect(await personUserId(personId)).toBe(userId);
	});

	it("never moves the verified email of a Person who has an account", async () => {
		// Once someone has signed in, their address is one they PROVED they own via
		// magic link. A club admin editing a roster row must not be able to retarget
		// it — this is the protection the old blanket IS NULL guard was reaching for.
		const verified = `verified-${randomUUID()}@test.example`;
		const userId = await seedUser(verified);
		const { memberId, personId } = await seedMember({
			personEmail: verified,
			memberEmail: verified,
			personUserId: userId,
		});
		const different = `different-${randomUUID()}@test.example`;

		await applyMemberEdit({
			actorMemberId: null,
			clubId: club.clubId,
			memberId,
			name: "Recon Person",
			email: different,
		});

		expect(await personEmail(personId)).toBe(verified);
		expect(await memberEmail(memberId)).toBe(different);
	});

	it("never clobbers an address a different club recorded", async () => {
		// A Person is one row per human across every club (ADR-0008). This club's
		// membership never carried `otherClubs`, so it did not seed it and has no
		// standing to overwrite it. Without this scoping, an admin here could point
		// a shared, unlinked Person at an address they control and then take the
		// person over via `claimPersonForUser`, inheriting the other club's roster.
		const otherClubs = `other-club-${randomUUID()}@test.example`;
		const ours = `ours-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({
			personEmail: otherClubs,
			memberEmail: ours,
		});
		const attacker = `attacker-${randomUUID()}@test.example`;

		await applyMemberEdit({
			actorMemberId: null,
			clubId: club.clubId,
			memberId,
			name: "Recon Person",
			email: attacker,
		});

		expect(await personEmail(personId)).toBe(otherClubs);
		expect(await memberEmail(memberId)).toBe(attacker);
	});

	it("leaves people.email null when the edit sets no email (null edit)", async () => {
		const { memberId, personId } = await seedMember({
			personEmail: null,
			memberEmail: null,
		});

		await applyMemberEdit({
			actorMemberId: null,
			clubId: club.clubId,
			memberId,
			name: "Recon Person",
			email: null,
		});

		expect(await personEmail(personId)).toBeNull();
		expect(await memberEmail(memberId)).toBeNull();
	});
});
