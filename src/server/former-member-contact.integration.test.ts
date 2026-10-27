/**
 * DB-backed tests for a former member's contact on their profile (#1342).
 *
 * `getMemberProfile` is reachable by member id from every past agenda, so a
 * member who has left the club kept an email, phone and WhatsApp link one click
 * from any active member. The loader (`loadMemberProfile`) now withholds them
 * unless the caller says the viewer may reveal, and `getMemberProfile` says so
 * with `mayRevealFormerMembers`: an admin, an officer, or a superadmin under
 * "Act as admin". Here the guards run for real and the handler's glue is
 * rebuilt line for line; `club-former-contact.guard.test.ts` pins that the
 * handler really contains it.
 *
 * Run with a bootstrapped worktree (`bun run worktree:setup`):
 *   bunx vitest run src/server/former-member-contact.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	impersonationSessions,
	members,
	officerTerms,
	people,
	user,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadMemberProfile } = await import("#/server/club-logic");
const { mayRevealFormerMembers, requireClubViewAccess } = await import(
	"#/server/guards"
);
const { startImpersonation, endImpersonation } = await import(
	"#/server/impersonation-logic"
);

const superadmins: string[] = [];

async function seedSuperadmin(): Promise<string> {
	const id = randomUUID();
	await testDb.insert(user).values({
		id,
		name: "Super Admin",
		email: `super-${id}@test.example`,
		emailVerified: true,
		isSuperadmin: true,
	});
	superadmins.push(id);
	return id;
}

describe.skipIf(!hasTestDb)("a former member's contact (#1342)", () => {
	let club: SeededClub;
	let formerId: string;
	let inactiveId: string;
	let formerPersonId: string;

	beforeAll(async () => {
		club = await seedClub();
		formerPersonId = await seedPerson({
			name: "Fern Former",
			email: "fern.former@example.test",
			phone: "(415) 555-2671",
		});
		const [former, inactive] = await testDb
			.insert(members)
			.values([
				{
					clubId: club.clubId,
					personId: formerPersonId,
					name: "Fern Former",
					status: "former",
				},
				{
					clubId: club.clubId,
					personId: await seedPerson({
						name: "Ivy Inactive",
						email: "ivy.inactive@example.test",
						phone: "(415) 555-0100",
					}),
					name: "Ivy Inactive",
					status: "inactive",
				},
			])
			.returning({ id: members.id });
		if (!former || !inactive) throw new Error("member insert failed");
		formerId = former.id;
		inactiveId = inactive.id;
		// The Person's stated preference, so it is a value there is something to
		// withhold: a profile's `preferredContact` is the EFFECTIVE value, which
		// is null when the chosen method has no data.
		await testDb
			.update(people)
			.set({ preferredContact: "email" })
			.where(eq(people.id, formerPersonId));
	});

	afterAll(async () => {
		if (superadmins.length > 0) {
			await testDb
				.delete(impersonationSessions)
				.where(inArray(impersonationSessions.superadminUserId, superadmins));
			await testDb.delete(user).where(inArray(user.id, superadmins));
		}
		if (club) {
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		}
	});

	/** What `getMemberProfile`'s handler does, with the same two calls. */
	async function profileAs(userId: string, memberId: string) {
		const access = await requireClubViewAccess(userId, club.clubId);
		return loadMemberProfile(club.clubId, memberId, {
			viewerMayRevealFormer: () => mayRevealFormerMembers(access),
		});
	}

	const CONTACT_KEYS = [
		"email",
		"phone",
		"phoneRaw",
		"preferredContact",
		"contactPreferenceRefusal",
	] as const;
	const WITHHELD = {
		email: null,
		phone: null,
		phoneRaw: null,
		preferredContact: null,
		contactPreferenceRefusal: null,
	};
	const contactOf = (p: NonNullable<Awaited<ReturnType<typeof profileAs>>>) =>
		Object.fromEntries(CONTACT_KEYS.map((k) => [k, p[k]]));

	describe("a viewer who may not reveal it", () => {
		it("a plain member gets the name, status and history but no contact", async () => {
			// protects=the withholding, key by key, for the viewer the issue names; fails_when=the redaction block is removed or any one of the five contact keys is left out of it; no_claim=none beyond protects
			const p = await profileAs(club.memberUserId, formerId);
			expect(p).toMatchObject({
				id: formerId,
				name: "Fern Former",
				status: "former",
			});
			expect(contactOf(p as NonNullable<typeof p>)).toEqual(WITHHELD);
		});

		it("is the default: a caller that names no viewer gets the redacted profile", async () => {
			// protects=fail-closed; fails_when=the default flips to revealing, so a new caller of the loader that forgets the option publishes the contact; no_claim=none beyond protects
			const p = await loadMemberProfile(club.clubId, formerId);
			expect(contactOf(p as NonNullable<typeof p>)).toEqual(WITHHELD);
		});

		it("a viewer function that answers false withholds it", async () => {
			const p = await loadMemberProfile(club.clubId, formerId, {
				viewerMayRevealFormer: async () => false,
			});
			expect(contactOf(p as NonNullable<typeof p>)).toEqual(WITHHELD);
		});

		it("a superadmin under View as this club gets none either", async () => {
			const su = await seedSuperadmin();
			await startImpersonation(su, { clubId: club.clubId });
			try {
				const p = await profileAs(su, formerId);
				expect(contactOf(p as NonNullable<typeof p>)).toEqual(WITHHELD);
			} finally {
				await endImpersonation(su);
			}
		});
	});

	describe("a viewer who may", () => {
		const REVEALED = {
			email: "fern.former@example.test",
			phone: "+14155552671",
			phoneRaw: "(415) 555-2671",
			preferredContact: "email",
		};

		it("an admin sees the contact", async () => {
			const p = await profileAs(club.adminUserId, formerId);
			expect(contactOf(p as NonNullable<typeof p>)).toMatchObject(REVEALED);
		});

		it("an elected officer whose stored role is member sees it", async () => {
			const [term] = await testDb
				.insert(officerTerms)
				.values({
					membershipId: club.memberId,
					position: "secretary",
					termStart: new Date(Date.now() - 86_400_000),
				})
				.returning({ id: officerTerms.id });
			try {
				const p = await profileAs(club.memberUserId, formerId);
				expect(contactOf(p as NonNullable<typeof p>)).toMatchObject(REVEALED);
			} finally {
				await testDb.delete(officerTerms).where(eq(officerTerms.id, term.id));
			}
		});

		it("a superadmin under Act as admin sees it", async () => {
			const su = await seedSuperadmin();
			await startImpersonation(su, {
				clubId: club.clubId,
				mode: "read_write",
				reason: "checking a former member's record",
			});
			try {
				const p = await profileAs(su, formerId);
				expect(contactOf(p as NonNullable<typeof p>)).toMatchObject(REVEALED);
			} finally {
				await endImpersonation(su);
			}
		});
	});

	describe("everyone else on the roster", () => {
		it("an inactive member's contact still goes to a plain member", async () => {
			// protects=that the withholding is for FORMER only; fails_when=the predicate widens to `status !== 'active'` (the inactive member, still on the roster, loses their contact); no_claim=none beyond protects
			const p = await profileAs(club.memberUserId, inactiveId);
			expect(p).toMatchObject({
				status: "inactive",
				email: "ivy.inactive@example.test",
				phone: "+14155550100",
				phoneRaw: "(415) 555-0100",
			});
		});

		it("an active member's contact goes to a plain member, and the viewer check never runs", async () => {
			const viewerMayRevealFormer = vi.fn(async () => true);
			const p = await loadMemberProfile(club.clubId, club.memberId, {
				viewerMayRevealFormer,
			});
			expect(p?.email).toMatch(/^member-.*@test\.example$/);
			expect(viewerMayRevealFormer).not.toHaveBeenCalled();
		});

		it("a member id from another club is still not found", async () => {
			const other = await seedClub();
			try {
				expect(
					await loadMemberProfile(club.clubId, other.memberId, {
						viewerMayRevealFormer: async () => true,
					}),
				).toBeUndefined();
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});
	});
});
