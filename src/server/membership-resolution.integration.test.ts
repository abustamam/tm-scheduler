/**
 * Regression (#471): `getMembership` resolved the AUTHORIZATION-bearing
 * membership with an unordered `.limit(1)`.
 *
 * `people.user_id` is not unique (ADR-0008 / #329 — duplicates predate
 * dedupe-on-write and the merge is a manual superadmin step), so one human can
 * hold two `members` rows in the SAME club through two Person rows. Every guard
 * branches on that row's `status`, `clubRole` or `id`, so an arbitrary pick
 * could flip an authorization answer between two requests for one user.
 *
 * Unlike the read surfaces #437 fixed — where an arbitrary pick showed
 * incomplete data — a wrong pick here decides whether someone is an admin.
 *
 * Every fixture writes the WEAKER membership FIRST, so an unordered scan
 * returns it and the assertions fail without the ordering. Insert order is the
 * whole point: with the strong row written first these tests pass either way.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/membership-resolution.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { user } from "#/db/auth-schema";
import { members, officerTerms, people } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { getMembership } = await import("./guards");

describe.skipIf(!hasTestDb)(
	"getMembership with duplicate Persons (#471)",
	() => {
		let club: SeededClub;
		let userId: string;
		const madePeople: string[] = [];

		beforeEach(async () => {
			club = await seedClub();
			userId = randomUUID();
			await testDb.insert(user).values({
				id: userId,
				name: "Dup Human",
				email: `${userId}@test.example`,
			});
			madePeople.length = 0;
		});

		afterEach(async () => {
			if (madePeople.length > 0) {
				await testDb.delete(people).where(inArray(people.id, madePeople));
			}
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId, userId]);
		});

		/** One more Person on the SAME account, holding its own membership here. */
		async function addMembership(opts: {
			clubRole: "admin" | "member";
			status: "active" | "inactive";
			/** Explicit id, for pinning the final tiebreaker. */
			id?: string;
			/** Explicit timestamp, so several rows can share one instant. */
			createdAt?: Date;
		}): Promise<string> {
			const [personRow] = await testDb
				.insert(people)
				.values({
					name: "Dup Human",
					email: `${randomUUID()}@test.example`,
					userId,
				})
				.returning({ id: people.id });
			madePeople.push(personRow.id);

			const [memberRow] = await testDb
				.insert(members)
				.values({
					...(opts.id ? { id: opts.id } : {}),
					...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
					clubId: club.clubId,
					personId: personRow.id,
					name: "Dup Human",
					clubRole: opts.clubRole,
					status: opts.status,
				})
				.returning({ id: members.id });
			return memberRow.id;
		}

		it("prefers an ACTIVE membership over a lapsed one", async () => {
			const lapsed = await addMembership({
				clubRole: "member",
				status: "inactive",
			});
			const active = await addMembership({
				clubRole: "member",
				status: "active",
			});

			const got = await getMembership(userId, club.clubId);
			expect(got?.id).toBe(active);
			expect(got?.id).not.toBe(lapsed);
			expect(got?.status).toBe("active");
		});

		// The reported bug: the human IS an admin of this club, and whether the app
		// agrees depended on which duplicate Postgres happened to return.
		it("prefers an ADMIN membership over a plain member one", async () => {
			const plain = await addMembership({
				clubRole: "member",
				status: "active",
			});
			const admin = await addMembership({
				clubRole: "admin",
				status: "active",
			});

			const got = await getMembership(userId, club.clubId);
			expect(got?.id).toBe(admin);
			expect(got?.id).not.toBe(plain);
			expect(got?.clubRole).toBe("admin");
		});

		// Status outranks role: an admin badge on a membership they no longer hold
		// must not beat the membership they actually have. This is the direction
		// that matters, because `canManageClub` returns `clubRole === "admin"`
		// WITHOUT checking status.
		it("prefers an active member over an INACTIVE admin", async () => {
			const staleAdmin = await addMembership({
				clubRole: "admin",
				status: "inactive",
			});
			const active = await addMembership({
				clubRole: "member",
				status: "active",
			});

			const got = await getMembership(userId, club.clubId);
			expect(got?.id).toBe(active);
			expect(got?.id).not.toBe(staleAdmin);
			expect(got?.clubRole).toBe("member");
		});

		// Effective-admin (#202) is granted by getOpenOfficerPositions(membership.id),
		// which reads ONE membership — so the officer term has to be on the row the
		// resolver returns, or the holder silently loses it.
		it("prefers the membership holding an OPEN officer term", async () => {
			const plain = await addMembership({
				clubRole: "member",
				status: "active",
			});
			const officer = await addMembership({
				clubRole: "member",
				status: "active",
			});
			await testDb.insert(officerTerms).values({
				membershipId: officer,
				position: "vp_education",
				termStart: new Date("2026-01-01"),
			});

			const got = await getMembership(userId, club.clubId);
			expect(got?.id).toBe(officer);
			expect(got?.id).not.toBe(plain);
		});

		// A CLOSED term grants nothing, so it must not pull the pick either.
		it("ignores a CLOSED officer term when ranking", async () => {
			const withClosedTerm = await addMembership({
				clubRole: "member",
				status: "active",
			});
			await testDb.insert(officerTerms).values({
				membershipId: withClosedTerm,
				position: "vp_education",
				termStart: new Date("2025-01-01"),
				termEnd: new Date("2025-12-31"),
			});
			const openTermHolder = await addMembership({
				clubRole: "member",
				status: "active",
			});
			await testDb.insert(officerTerms).values({
				membershipId: openTermHolder,
				position: "president",
				termStart: new Date("2026-01-01"),
			});

			expect((await getMembership(userId, club.clubId))?.id).toBe(
				openTermHolder,
			);
		});

		// Rows written sequentially get distinct `createdAt`s, which alone totally
		// orders them — so `members.id` would never be exercised and could be
		// deleted with the suite green. These share ONE timestamp and carry
		// explicit DESCENDING ids written in that order, so only the id clause
		// can decide, and it must decide against both heap order and insert order.
		it("is stable across calls when only the id distinguishes the rows", async () => {
			const sameInstant = new Date("2026-03-01T00:00:00.000Z");
			const descendingIds = [
				"00000000-0000-4000-8000-0000000004c3",
				"00000000-0000-4000-8000-0000000004c2",
				"00000000-0000-4000-8000-0000000004c1",
			];
			for (const memberId of descendingIds) {
				await addMembership({
					clubRole: "member",
					status: "active",
					id: memberId,
					createdAt: sameInstant,
				});
			}

			const answers = new Set([
				(await getMembership(userId, club.clubId))?.id,
				(await getMembership(userId, club.clubId))?.id,
				(await getMembership(userId, club.clubId))?.id,
			]);
			// Two queries in one request disagreeing is what flips an authz answer.
			expect(answers.size).toBe(1);
			// ...and it is the LOWEST id, not whichever the scan reached first.
			expect([...answers][0]).toBe(descendingIds[2]);
		});

		// The join must not multiply rows: an officer holding several open terms is
		// ordinary (President and VPE at once), and `.limit(1)` would hide a fan-out
		// anyway — so assert the row itself is intact and singular.
		it("returns ONE intact row for a member with several open terms", async () => {
			const officer = await addMembership({
				clubRole: "admin",
				status: "active",
			});
			await testDb.insert(officerTerms).values([
				{
					membershipId: officer,
					position: "president",
					termStart: new Date("2026-01-01"),
				},
				{
					membershipId: officer,
					position: "vp_education",
					termStart: new Date("2026-01-01"),
				},
			]);

			const got = await getMembership(userId, club.clubId);
			expect(got).toEqual({
				id: officer,
				clubId: club.clubId,
				personId: expect.any(String),
				clubRole: "admin",
				status: "active",
				// Carried on the join since #566 so the archive check costs no second
				// round-trip. A literal null, not `expect.anything()`: the whole point
				// is that the value is the club's real archive state, and a live club's
				// is null. The archived direction is covered in
				// `archive-club.integration.test.ts`, which drives the gates.
				archivedAt: null,
			});
		});

		it("still returns null when the account has no membership here", async () => {
			const [orphan] = await testDb
				.insert(people)
				.values({
					name: "Linked, unrostered",
					email: `${randomUUID()}@test.example`,
					userId,
				})
				.returning({ id: people.id });
			madePeople.push(orphan.id);

			expect(await getMembership(userId, club.clubId)).toBeNull();
		});

		it("does not leak another club's membership", async () => {
			const other = await seedClub();
			try {
				await addMembership({ clubRole: "admin", status: "active" });
				// Same human, a membership in a DIFFERENT club.
				const [otherPerson] = await testDb
					.insert(people)
					.values({
						name: "Dup Human",
						email: `${randomUUID()}@test.example`,
						userId,
					})
					.returning({ id: people.id });
				madePeople.push(otherPerson.id);
				await testDb.insert(members).values({
					clubId: other.clubId,
					personId: otherPerson.id,
					name: "Dup Human",
					clubRole: "member",
					status: "active",
				});

				const got = await getMembership(userId, club.clubId);
				expect(got?.clubId).toBe(club.clubId);
				expect(got?.clubRole).toBe("admin");
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});
	},
);
