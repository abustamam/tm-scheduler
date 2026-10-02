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

	/** Insert a (person, membership) pair in the seeded club. The address is the
	 *  Person's (#907); `memberEmail`, when given, wins over `email` — kept so
	 *  the older cases below read as they did when it was a per-club column. */
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
				email:
					(opts.memberEmail !== undefined ? opts.memberEmail : opts.email) ??
					null,
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
		// No email on the Person → un-claimable by anyone.
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

	it("links on the Person's address and stamps the verified form onto it", async () => {
		const { claimPersonForUser } = await import("./account-invite-logic");
		const email = `edited-${randomUUID()}@test.example`;
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

	it("refuses when the Person's email does not match the verified address", async () => {
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

	it("prepareMemberInvite sends to the PERSON's address (#907)", async () => {
		const { prepareMemberInvite } = await import("./account-invite-logic");
		const addr = `person-${randomUUID()}@test.example`;
		const { memberId } = await seedMember({ email: addr });

		const prep = await prepareMemberInvite({ clubId: club.clubId, memberId });

		expect(prep.outcome).toBe("ready");
		expect(prep.email).toBe(addr);
	});

	it("a DUAL-CLUB member is invited and claims, now that two clubs no longer block a bind (#907)", async () => {
		// Before #907 a member two clubs held could not bind by any route, so the
		// invite refused with `multiple_clubs`. The address is now ONE column on
		// the Person that only a sole-holding club may write, so a second club
		// cannot re-key them — and the arm is gone.
		const { prepareMemberInvite, claimPersonForUser } = await import(
			"./account-invite-logic"
		);
		const other = await seedClub();
		try {
			const shared = `dual-${randomUUID()}@test.example`;
			const { memberId, personId } = await seedMember({ email: shared });
			await testDb.insert(members).values({
				clubId: other.clubId,
				personId,
				name: "Picked Person",
			});

			const prep = await prepareMemberInvite({ clubId: club.clubId, memberId });
			expect(prep.outcome).toBe("ready");
			expect(prep.email).toBe(shared);

			const userId = await seedUser(shared);
			expect(await claimPersonForUser({ memberId, userId })).toBe("linked");
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("a claim that cannot bind never says somebody else took the name", async () => {
		// `already_other` used to be the catch-all after a refused bind, so a member
		// whose roster row simply carried no address was told "This name is already
		// linked to a different account" — false, alarming, and with nothing they or
		// an officer could do about it. Reachable whenever the explainer cannot model
		// the refusal, which is precisely when the message matters most.
		const { claimPersonForUser } = await import("./account-invite-logic");
		const addr = `no-vouch-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({ email: addr });
		const userId = await seedUser(addr);
		// A second Person comes to carry the same address before the bind.
		await seedMember({ email: addr });

		const outcome = await claimPersonForUser({ memberId, userId });

		expect(outcome).not.toBe("already_other");
		expect((await personRow(personId))?.userId).toBeNull();
	});

	it("two members sharing one address cannot claim each other", async () => {
		// The household case on the explicit-pick surface. Picking a name is a
		// claim, not proof: with one address on two roster rows the app cannot tell
		// which human is at the keyboard, and the sign-in auto-link refuses for the
		// same reason. An officer giving them distinct addresses is the repair.
		const { claimPersonForUser } = await import("./account-invite-logic");
		const shared = `household-${randomUUID()}@test.example`;
		const alice = await seedMember({ email: null, memberEmail: shared });
		const bob = await seedMember({ email: null, memberEmail: shared });
		const userId = await seedUser(shared);

		expect(await claimPersonForUser({ memberId: bob.memberId, userId })).toBe(
			"roster_conflict",
		);
		expect((await personRow(bob.personId))?.userId).toBeNull();
		expect((await personRow(alice.personId))?.userId).toBeNull();
	});

	it("an officer cannot take over a Person another club also holds (#755 regression)", async () => {
		// The takeover #755 chased, re-run against #907's model. An officer of
		// club A types their OWN address onto a human club B also holds, then
		// signs in. The roster edit refuses the address (`multi_club`), so the
		// Person never carries it, and neither binding path gives it to them.
		const { prepareMemberInvite, claimPersonForUser } = await import(
			"./account-invite-logic"
		);
		const { linkPersonToUser } = await import("./account-link-logic");
		const { applyMemberEdit } = await import("./members-logic");
		const other = await seedClub();
		try {
			const { memberId, personId } = await seedMember({ email: null });
			await testDb.insert(members).values({
				clubId: other.clubId,
				personId,
				name: "Picked Person",
			});
			const attacker = `attacker-${randomUUID()}@test.example`;

			const edit = await applyMemberEdit({
				actorMemberId: null,
				clubId: club.clubId,
				memberId,
				name: "Picked Person",
				email: attacker,
			});
			expect(edit.emailRefused).toBe("multi_club");
			expect((await personRow(personId))?.email).toBeNull();

			expect(
				(await prepareMemberInvite({ clubId: club.clubId, memberId })).outcome,
			).toBe("no_email");

			const attackerUserId = await seedUser(attacker);
			expect((await linkPersonToUser(attackerUserId)).linkedPersonIds).toEqual(
				[],
			);
			expect(
				await claimPersonForUser({ memberId, userId: attackerUserId }),
			).toBe("needs_invite");
			expect((await personRow(personId))?.userId).toBeNull();
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("claimPersonForUser fails on an address that is not the Person's own (#907)", async () => {
		const { claimPersonForUser } = await import("./account-invite-logic");
		const { memberId, personId } = await seedMember({
			email: `mine-${randomUUID()}@test.example`,
		});
		const userId = await seedUser(`someone-${randomUUID()}@test.example`);

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
