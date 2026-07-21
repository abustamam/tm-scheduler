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
		// people.email null but members.email set (what applyMemberEdit produces).
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

	it("prepareMemberInvite copies the membership email up when the Person has none", async () => {
		const { prepareMemberInvite } = await import("./account-invite-logic");
		// Person has no email, but the membership row does (e.g. a self-add later
		// given contact) — the invite should use it and persist it on the Person.
		const [person] = await testDb
			.insert(people)
			.values({ name: "No Email Person", email: null })
			.returning({ id: people.id });
		if (!person) throw new Error("person insert failed");
		const memberEmail = `membership-${randomUUID()}@test.example`;
		const [member] = await testDb
			.insert(members)
			.values({
				clubId: club.clubId,
				personId: person.id,
				name: "No Email Person",
				email: memberEmail,
			})
			.returning({ id: members.id });
		if (!member) throw new Error("member insert failed");

		const prep = await prepareMemberInvite({
			clubId: club.clubId,
			memberId: member.id,
		});
		expect(prep.outcome).toBe("ready");
		expect(prep.email).toBe(memberEmail);
		expect((await personRow(person.id))?.email).toBe(memberEmail);
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
