/**
 * DB-backed tests for account invites + "claim your name" (#266). Exercises the
 * plain logic (`claimPersonForUser`, `prepareMemberInvite`) directly against the
 * test database; `#/db` is redirected to it.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/account-invite-logic.integration.test.ts
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

describe.skipIf(!hasTestDb)("account invites + claim (#266)", () => {
	let club: SeededClub;
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

	/** Insert a Better-Auth user and track it for cleanup. */
	async function seedUser(email: string): Promise<string> {
		const id = randomUUID();
		await testDb
			.insert(user)
			.values({ id, name: "Claimer", email, emailVerified: true });
		extraUserIds.push(id);
		return id;
	}

	/** Insert a (person, membership) pair in the seeded club. `email` sets both the
	 *  person and membership email; pass `memberEmail` to set the membership email
	 *  independently (e.g. the VPE-edited case where only `members.email` is set). */
	async function seedMember(opts: {
		email?: string | null;
		memberEmail?: string | null;
		userId?: string | null;
		clubRole?: "admin" | "member";
	}): Promise<{ memberId: string; personId: string }> {
		const [person] = await testDb
			.insert(people)
			.values({
				name: "Picked Person",
				email: opts.email ?? null,
				userId: opts.userId ?? null,
			})
			.returning({ id: people.id });
		if (!person) throw new Error("person insert failed");
		const [member] = await testDb
			.insert(members)
			.values({
				clubId: club.clubId,
				personId: person.id,
				name: "Picked Person",
				email:
					(opts.memberEmail !== undefined ? opts.memberEmail : opts.email) ??
					null,
				clubRole: opts.clubRole ?? "member",
			})
			.returning({ id: members.id });
		if (!member) throw new Error("member insert failed");
		return { memberId: member.id, personId: person.id };
	}

	async function personRow(personId: string) {
		const [row] = await testDb
			.select({
				userId: people.userId,
				email: people.email,
				invitedAt: people.invitedAt,
			})
			.from(people)
			.where(eq(people.id, personId));
		return row;
	}

	// -------------------------------------------------------------------------
	// claimPersonForUser
	// -------------------------------------------------------------------------

	it("links an unlinked Person whose email matches the verified account", async () => {
		const { claimPersonForUser } = await import("./account-invite-logic");
		const email = `match-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({ email });
		const userId = await seedUser(email);

		expect(await claimPersonForUser({ memberId, userId })).toBe("linked");
		expect((await personRow(personId))?.userId).toBe(userId);
	});

	it("refuses an emailless Person on the public claim — never adopts under an arbitrary address (#266 takeover fix)", async () => {
		const { claimPersonForUser } = await import("./account-invite-logic");
		// No email on the person OR the membership → un-claimable by anyone.
		const { memberId, personId } = await seedMember({
			email: null,
			memberEmail: null,
		});
		const userId = await seedUser(`stranger-${randomUUID()}@test.example`);

		expect(await claimPersonForUser({ memberId, userId })).toBe("needs_invite");
		const row = await personRow(personId);
		expect(row?.userId).toBeNull(); // not seized
		expect(row?.email).toBeNull(); // email NOT overwritten (no lockout)
	});

	it("links via the membership email when the person has none, and stamps it onto the Person (VPE-edited case)", async () => {
		const { claimPersonForUser } = await import("./account-invite-logic");
		const email = `edited-${randomUUID()}@test.example`;
		// people.email null but members.email set — since #756 this is the ORDINARY
		// shape of an un-claimed member, not an edge case: migration 0076 cleared the
		// column for everyone who has never signed in, and nothing a club does
		// refills it. The claim is what puts a verified address there.
		const { memberId, personId } = await seedMember({
			email: null,
			memberEmail: email,
		});
		const userId = await seedUser(email);

		expect(await claimPersonForUser({ memberId, userId })).toBe("linked");
		const row = await personRow(personId);
		expect(row?.userId).toBe(userId);
		// The proven on-file email is stamped onto the Person for future auto-link.
		expect(row?.email?.toLowerCase()).toBe(email.toLowerCase());
	});

	it("refuses when the membership email does not match the verified address", async () => {
		const { claimPersonForUser } = await import("./account-invite-logic");
		const { memberId, personId } = await seedMember({
			email: null,
			memberEmail: `onfile-${randomUUID()}@test.example`,
		});
		const userId = await seedUser(`other-${randomUUID()}@test.example`);

		expect(await claimPersonForUser({ memberId, userId })).toBe(
			"email_mismatch",
		);
		expect((await personRow(personId))?.userId).toBeNull();
	});

	it("won't adopt a Person whose real email differs from the verified one", async () => {
		const { claimPersonForUser } = await import("./account-invite-logic");
		const { memberId, personId } = await seedMember({
			email: `real-${randomUUID()}@test.example`,
		});
		const userId = await seedUser(`different-${randomUUID()}@test.example`);

		expect(await claimPersonForUser({ memberId, userId })).toBe(
			"email_mismatch",
		);
		expect((await personRow(personId))?.userId).toBeNull();
	});

	it("is idempotent: claiming a Person already linked to THIS user is a no-op", async () => {
		const { claimPersonForUser } = await import("./account-invite-logic");
		const email = `idem-${randomUUID()}@test.example`;
		const userId = await seedUser(email);
		const { memberId, personId } = await seedMember({ email, userId });

		expect(await claimPersonForUser({ memberId, userId })).toBe(
			"already_yours",
		);
		expect((await personRow(personId))?.userId).toBe(userId);
	});

	it("never steals a Person already linked to a DIFFERENT account", async () => {
		const { claimPersonForUser } = await import("./account-invite-logic");
		const owner = await seedUser(`owner-${randomUUID()}@test.example`);
		const { memberId, personId } = await seedMember({
			email: `owned-${randomUUID()}@test.example`,
			userId: owner,
		});
		// An attacker signs in as themselves and tries to grab the owned Person.
		const attacker = await seedUser(`attacker-${randomUUID()}@test.example`);

		expect(await claimPersonForUser({ memberId, userId: attacker })).toBe(
			"already_other",
		);
		expect((await personRow(personId))?.userId).toBe(owner);
	});

	it("returns not_found for an unknown member", async () => {
		const { claimPersonForUser } = await import("./account-invite-logic");
		const userId = await seedUser(`x-${randomUUID()}@test.example`);
		expect(await claimPersonForUser({ memberId: randomUUID(), userId })).toBe(
			"not_found",
		);
	});

	// -------------------------------------------------------------------------
	// prepareMemberInvite
	// -------------------------------------------------------------------------

	it("prepareMemberInvite stamps invited_at and returns the person's email + club", async () => {
		const { prepareMemberInvite } = await import("./account-invite-logic");
		const email = `invitee-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({ email });

		const prep = await prepareMemberInvite({ clubId: club.clubId, memberId });
		expect(prep.outcome).toBe("ready");
		expect(prep.email).toBe(email);
		expect(prep.clubName).toBe("Test Club");
		expect((await personRow(personId))?.invitedAt).toBeInstanceOf(Date);
	});

	it("prepareMemberInvite sends to the membership email and does NOT seed the Person", async () => {
		const { prepareMemberInvite } = await import("./account-invite-logic");
		// The invite used to copy `members.email` up onto `people.email`, which made
		// it the second admin-reachable writer of the identity key: an officer whose
		// person-level write the roster form refused could press Invite one row over
		// and complete the same retarget. There is nothing to guard now — the button
		// sends a magic link and writes no identity at all.
		const { memberId, personId } = await seedMember({
			email: null,
			memberEmail: `membership-${randomUUID()}@test.example`,
		});

		const prep = await prepareMemberInvite({ clubId: club.clubId, memberId });

		expect(prep.outcome).toBe("ready");
		expect((await personRow(personId))?.email).toBeNull();
	});

	it("prepareMemberInvite sends to the membership address, not the Person's", async () => {
		const { prepareMemberInvite } = await import("./account-invite-logic");
		// `members.email` is the club's contact record AND the claim key, so the
		// link has to go where the claim will look. Sending to a stale person-level
		// value delivers a magic link that then refuses to bind — the silent
		// half-failure this change exists to remove.
		const { memberId } = await seedMember({
			email: `stale-person-${randomUUID()}@test.example`,
			memberEmail: `roster-${randomUUID()}@test.example`,
		});

		const prep = await prepareMemberInvite({ clubId: club.clubId, memberId });

		expect(prep.outcome).toBe("ready");
		expect(prep.email).toMatch(/^roster-/);
	});

	it("prepareMemberInvite returns no_email when only the PERSON carries one", async () => {
		// Deliberate, and the reason the migration clears the column: an address
		// nobody verified is not something to mail a sign-in link to. The admin adds
		// it to the roster row — the one surface they own — and invites again.
		const { prepareMemberInvite } = await import("./account-invite-logic");
		const { memberId } = await seedMember({
			email: `person-only-${randomUUID()}@test.example`,
			memberEmail: null,
		});

		expect(
			(await prepareMemberInvite({ clubId: club.clubId, memberId })).outcome,
		).toBe("no_email");
	});

	it("an officer cannot take over a Person another club also holds (#755 regression)", async () => {
		// The takeover #755 chased across four writers, re-run against the model
		// that removed the writers instead of guarding them. An officer of club A
		// types their own address onto their own membership row — the one column
		// they legitimately own — for a human club B also has on its roster, then
		// signs in. Neither half may give them the Person: the invite writes no
		// identity, and the claim refuses because two clubs hold them.
		const { prepareMemberInvite } = await import("./account-invite-logic");
		const other = await seedClub();
		try {
			const [person] = await testDb
				.insert(people)
				.values({ name: "Shared Person", email: null })
				.returning({ id: people.id });
			if (!person) throw new Error("person insert failed");
			const attacker = `attacker-${randomUUID()}@test.example`;
			const [member] = await testDb
				.insert(members)
				.values({
					clubId: club.clubId,
					personId: person.id,
					name: "Shared Person",
					email: attacker,
				})
				.returning({ id: members.id });
			if (!member) throw new Error("member insert failed");
			// The SAME human on another club's roster (ADR-0008: one Person row).
			await testDb.insert(members).values({
				clubId: other.clubId,
				personId: person.id,
				name: "Shared Person",
				email: null,
			});

			const prep = await prepareMemberInvite({
				clubId: club.clubId,
				memberId: member.id,
			});

			// The invite still goes out to this club's own address — that is this
			// club's business, and stopping it would break inviting a member whose
			// contact details only the club has.
			expect(prep.outcome).toBe("ready");
			expect((await personRow(person.id))?.email).toBeNull();

			// But the column assertion above is NOT the property that matters, and an
			// earlier cut of this test stopped there — it passed while the takeover
			// still completed one step later. Drive it to the outcome, on BOTH paths
			// that can bind a Person: the officer signs in on the address they typed
			// and must end up holding nothing.
			const { claimPersonForUser } = await import("./account-invite-logic");
			const { linkPersonToUser } = await import("./account-link-logic");
			const attackerUserId = await seedUser(attacker);

			// Sign-in auto-link — the path that now does the binding.
			expect((await linkPersonToUser(attackerUserId)).linkedPersonIds).toEqual(
				[],
			);
			// And the explicit claim, which they reach by picking the name.
			expect(
				await claimPersonForUser({
					memberId: member.id,
					userId: attackerUserId,
				}),
			).toBe("needs_invite");
			expect((await personRow(person.id))?.userId).toBeNull();
			expect((await personRow(person.id))?.email).toBeNull();
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("a shared Person with no person-level address is not claimable at all", async () => {
		// The same rule from the public claim surface directly, with no invite in
		// the story: `members.email` is a column any officer of any of this Person's
		// clubs can set to anything, so it cannot be the key that binds an account
		// to a Person more than one club holds. Single-club Persons keep the
		// fallback — that is the ordinary "the VPE gave me an email" path, asserted
		// by the sibling test above.
		const other = await seedClub();
		try {
			const [person] = await testDb
				.insert(people)
				.values({ name: "Shared Person", email: null })
				.returning({ id: people.id });
			if (!person) throw new Error("person insert failed");
			const typed = `typed-${randomUUID()}@test.example`;
			const [member] = await testDb
				.insert(members)
				.values({
					clubId: club.clubId,
					personId: person.id,
					name: "Shared Person",
					email: typed,
				})
				.returning({ id: members.id });
			if (!member) throw new Error("member insert failed");
			await testDb.insert(members).values({
				clubId: other.clubId,
				personId: person.id,
				name: "Shared Person",
				email: null,
			});
			const { claimPersonForUser } = await import("./account-invite-logic");
			const userId = await seedUser(typed);

			expect(await claimPersonForUser({ memberId: member.id, userId })).toBe(
				"needs_invite",
			);
			expect((await personRow(person.id))?.userId).toBeNull();
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("a shared Person is not claimable even when the PERSON carries the address", async () => {
		// The sibling above pins the NULL case, which is the state the migration
		// leaves behind. This one pins the other half of the same rule: a
		// person-level address is not a credential either — the CSV importer, the
		// guest-book conversion and the create-club form all write it from a value
		// somebody typed — so it cannot rescue a bind the club count refuses.
		const { claimPersonForUser } = await import("./account-invite-logic");
		const other = await seedClub();
		try {
			const typed = `typed-${randomUUID()}@test.example`;
			const { memberId, personId } = await seedMember({ email: typed });
			await testDb.insert(members).values({
				clubId: other.clubId,
				personId,
				name: "Picked Person",
				email: null,
			});
			const userId = await seedUser(typed);

			expect(await claimPersonForUser({ memberId, userId })).toBe(
				"needs_invite",
			);
			expect((await personRow(personId))?.userId).toBeNull();
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("does not claim from a person-level address when the roster disagrees", async () => {
		// `people.email` is no longer a claim key at all. A stale person-level value
		// — the typo the importer first created the row under, say — must not let
		// somebody bind a membership the club has since re-pointed elsewhere.
		const { claimPersonForUser } = await import("./account-invite-logic");
		const stale = `stale-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({
			email: stale,
			memberEmail: `roster-${randomUUID()}@test.example`,
		});
		const userId = await seedUser(stale);

		expect(await claimPersonForUser({ memberId, userId })).toBe(
			"email_mismatch",
		);
		expect((await personRow(personId))?.userId).toBeNull();
	});

	it("repairs a mistyped address end to end, with no database access", async () => {
		// The incident (#755's origin): a member created under a typo was
		// unreachable through the UI and needed a direct database write to fix. The
		// whole point of inverting the ownership is that the repair is now the
		// ordinary flow — correct the roster row, invite, click — so this drives all
		// four steps and finishes on the observable that was wrong, the member's
		// clubs resolving after they sign in.
		const { prepareMemberInvite, claimPersonForUser } = await import(
			"./account-invite-logic"
		);
		const { applyMemberEdit } = await import("./members-logic");
		const { loadUserClubMemberships } = await import("./auth-context-logic");
		const correct = `correct-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({
			email: null,
			memberEmail: `typo-${randomUUID()}@test.example`,
		});

		// 1. An admin corrects the roster row. Nothing else, no refusal, no warning.
		await applyMemberEdit({
			actorMemberId: null,
			clubId: club.clubId,
			memberId,
			name: "Picked Person",
			email: correct,
		});

		// 2. The invite goes to the corrected address.
		const prep = await prepareMemberInvite({ clubId: club.clubId, memberId });
		expect(prep.outcome).toBe("ready");
		expect(prep.email).toBe(correct);

		// 3. They click it, sign in, and claim the name they picked.
		const userId = await seedUser(correct);
		expect(await claimPersonForUser({ memberId, userId })).toBe("linked");

		// 4. The club resolves — the thing that stayed broken for two days.
		const clubs = await loadUserClubMemberships(userId);
		expect(clubs.map((c) => c.clubId)).toContain(club.clubId);
		// And the address on the Person is now one they PROVED they own.
		expect((await personRow(personId))?.email).toBe(correct);
	});

	it("prepareMemberInvite returns already_joined for a linked Person (no resend)", async () => {
		const { prepareMemberInvite } = await import("./account-invite-logic");
		const email = `joined-${randomUUID()}@test.example`;
		const userId = await seedUser(email);
		const { memberId, personId } = await seedMember({ email, userId });

		const prep = await prepareMemberInvite({ clubId: club.clubId, memberId });
		expect(prep.outcome).toBe("already_joined");
		// invited_at stays untouched for an already-joined account.
		expect((await personRow(personId))?.invitedAt).toBeNull();
	});

	it("prepareMemberInvite returns no_email when neither Person nor membership has one", async () => {
		const { prepareMemberInvite } = await import("./account-invite-logic");
		const { memberId } = await seedMember({ email: null });
		const prep = await prepareMemberInvite({ clubId: club.clubId, memberId });
		expect(prep.outcome).toBe("no_email");
	});

	it("prepareMemberInvite rejects a member from another club", async () => {
		const { prepareMemberInvite } = await import("./account-invite-logic");
		const { memberId } = await seedMember({
			email: `x-${randomUUID()}@test.example`,
		});
		await expect(
			prepareMemberInvite({ clubId: randomUUID(), memberId }),
		).rejects.toThrow(/not found/i);
	});

	// -------------------------------------------------------------------------
	// prepareMemberInvite — bulk cooldown (#307)
	// -------------------------------------------------------------------------

	it("bulk cooldown skips a recently-invited member without re-stamping invited_at", async () => {
		const { prepareMemberInvite } = await import("./account-invite-logic");
		const email = `recent-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({ email });
		// Stamp the invite as of NOW — inside the cooldown window.
		const invitedAt = new Date();
		await testDb
			.update(people)
			.set({ invitedAt })
			.where(eq(people.id, personId));

		const prep = await prepareMemberInvite({
			clubId: club.clubId,
			memberId,
			respectCooldown: true,
		});
		expect(prep.outcome).toBe("recently_invited");
		// The existing stamp is left untouched (no resend / re-stamp).
		expect((await personRow(personId))?.invitedAt?.getTime()).toBe(
			invitedAt.getTime(),
		);
	});

	it("bulk cooldown lets an expired invite through as ready", async () => {
		const { prepareMemberInvite } = await import("./account-invite-logic");
		const email = `expired-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({ email });
		// Stamp ~25h ago — outside the 24h cooldown window.
		await testDb
			.update(people)
			.set({ invitedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
			.where(eq(people.id, personId));

		const prep = await prepareMemberInvite({
			clubId: club.clubId,
			memberId,
			respectCooldown: true,
		});
		expect(prep.outcome).toBe("ready");
		expect(prep.email).toBe(email);
	});

	it("single explicit invite ignores the cooldown (deliberate resend)", async () => {
		const { prepareMemberInvite } = await import("./account-invite-logic");
		const email = `single-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({ email });
		// Recently invited, but the single path omits respectCooldown → always sends.
		await testDb
			.update(people)
			.set({ invitedAt: new Date() })
			.where(eq(people.id, personId));

		const prep = await prepareMemberInvite({ clubId: club.clubId, memberId });
		expect(prep.outcome).toBe("ready");
		expect(prep.email).toBe(email);
	});
});
