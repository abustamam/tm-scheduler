/**
 * DB-backed tests for members ↔ people email reconciliation (#306). When a
 * member edit sets a membership email and the linked Person has no email yet,
 * `applyMemberEdit` copies it up to `people.email` — removing at the source the
 * divergence that made the #266 emailless-claim takeover possible. The copy-up
 * is a gap-fill only: it NEVER overwrites an existing Person email. Tests the
 * plain logic fn directly against the test DB (`#/db` → test DB).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/member-email-reconciliation.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members, people } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyMemberEdit } = await import("./members-logic");

describe.skipIf(!hasTestDb)("member email reconciliation (#306)", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	/** Insert a (person, membership) pair in the seeded club. `personEmail` sets
	 *  the Person email; `memberEmail` sets the membership email (defaults null). */
	async function seedMember(opts: {
		personEmail?: string | null;
		memberEmail?: string | null;
	}): Promise<{ memberId: string; personId: string }> {
		const [person] = await testDb
			.insert(people)
			.values({ name: "Recon Person", email: opts.personEmail ?? null })
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
			clubId: club.clubId,
			memberId,
			name: "Recon Person",
			email,
		});

		expect(await personEmail(personId)).toBe(email);
		expect(await memberEmail(memberId)).toBe(email);
	});

	it("never clobbers an existing Person email", async () => {
		const existing = `existing-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({
			personEmail: existing,
			memberEmail: existing,
		});
		const different = `different-${randomUUID()}@test.example`;

		await applyMemberEdit({
			clubId: club.clubId,
			memberId,
			name: "Recon Person",
			email: different,
		});

		// The Person email is left untouched (protects linked accounts) while the
		// membership email reflects the new value.
		expect(await personEmail(personId)).toBe(existing);
		expect(await memberEmail(memberId)).toBe(different);
	});

	it("leaves people.email null when the edit sets no email (null edit)", async () => {
		const { memberId, personId } = await seedMember({
			personEmail: null,
			memberEmail: null,
		});

		await applyMemberEdit({
			clubId: club.clubId,
			memberId,
			name: "Recon Person",
			email: null,
		});

		expect(await personEmail(personId)).toBeNull();
		expect(await memberEmail(memberId)).toBeNull();
	});
});
