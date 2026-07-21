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

	/** Insert a (person, membership) pair in the seeded club. */
	async function seedMember(opts: {
		email?: string | null;
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
				email: opts.email ?? null,
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

	it("adopts an emailless self-add Person under the verified email", async () => {
		const { claimPersonForUser } = await import("./account-invite-logic");
		const { memberId, personId } = await seedMember({ email: null });
		const email = `adopt-${randomUUID()}@test.example`;
		const userId = await seedUser(email);

		expect(await claimPersonForUser({ memberId, userId })).toBe("linked");
		const row = await personRow(personId);
		expect(row?.userId).toBe(userId);
		// The verified email is written onto the previously-emailless Person.
		expect(row?.email?.toLowerCase()).toBe(email.toLowerCase());
	});

	it("refuses to adopt an emailless Person that holds an admin role (no silent escalation)", async () => {
		const { claimPersonForUser } = await import("./account-invite-logic");
		const { memberId, personId } = await seedMember({
			email: null,
			clubRole: "admin",
		});
		const userId = await seedUser(`stranger-${randomUUID()}@test.example`);

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
});
