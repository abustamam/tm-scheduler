/**
 * DB-backed tests for the roster's Pathway column and FORMER members.
 *
 * An enrollment is person-owned and carries no club (#958), so a lapsed
 * membership is the only link from a former member's Pathways record to the
 * club they left. `listClubMemberPathwaysFor` (the body of the
 * `listClubMemberPathways` server fn) sends inactive members' paths only when
 * the caller asks AND is an officer or admin of the club. Guards run for real.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/roster-former-pathways.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	impersonationSessions,
	members,
	officerTerms,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
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

const { listClubMemberPathwaysFor, pathwaysByMember, pathwaysForMember } =
	await import("./pathways-read-logic");
const { startImpersonation, endImpersonation } = await import(
	"./impersonation-logic"
);

const TAG = randomUUID().slice(0, 8);
const createdPathIds: string[] = [];
const superadmins: string[] = [];

async function enroll(personId: string, courseCode: string) {
	const [path] = await testDb
		.insert(pathwaysPaths)
		.values({ courseCode: `${courseCode}-${TAG}`, name: courseCode })
		.returning({ id: pathwaysPaths.id });
	createdPathIds.push(path.id);
	const [enr] = await testDb
		.insert(pathEnrollments)
		.values({ personId, pathId: path.id })
		.returning({ id: pathEnrollments.id });
	await testDb.insert(pathLevelProgress).values({
		enrollmentId: enr.id,
		level: 1,
		completed: 2,
		total: 5,
		approved: false,
	});
}

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

describe.skipIf(!hasTestDb)("roster Pathway column, former members", () => {
	let club: SeededClub;
	let formerMemberId: string;

	beforeAll(async () => {
		club = await seedClub();
		// The seeded plain member is ACTIVE and has a path: it must always show.
		await enroll(club.personId, "ACTIVE");
		// A former member: an inactive membership whose person has a path.
		const formerPersonId = await seedPerson({ name: "Former Member" });
		const [former] = await testDb
			.insert(members)
			.values({
				clubId: club.clubId,
				personId: formerPersonId,
				name: "Former Member",
				status: "inactive",
			})
			.returning({ id: members.id });
		formerMemberId = former.id;
		await enroll(formerPersonId, "FORMER");
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
		// Paths are club-less: the club cascade leaves them behind.
		if (createdPathIds.length > 0) {
			await testDb
				.delete(pathwaysPaths)
				.where(inArray(pathwaysPaths.id, createdPathIds));
		}
	});

	const list = (userId: string, includeFormer?: boolean) =>
		listClubMemberPathwaysFor(userId, { clubId: club.clubId, includeFormer });

	it("pathwaysByMember leaves inactive memberships out unless asked", async () => {
		const byDefault = await pathwaysByMember(club.clubId);
		expect(byDefault.has(club.memberId)).toBe(true);
		expect(byDefault.has(formerMemberId)).toBe(false);

		const all = await pathwaysByMember(club.clubId, { includeInactive: true });
		expect(all.get(formerMemberId)?.[0]?.pathName).toBe("FORMER");
	});

	it("sends no former member's paths by default, to a member or an admin", async () => {
		for (const viewer of [club.memberUserId, club.adminUserId]) {
			const paths = await list(viewer);
			expect(paths[club.memberId]?.[0]?.pathName).toBe("ACTIVE");
			expect(paths).not.toHaveProperty(formerMemberId);
		}
	});

	it("sends them to an admin who opts in", async () => {
		const paths = await list(club.adminUserId, true);
		expect(paths[formerMemberId]?.[0]?.pathName).toBe("FORMER");
		expect(paths[club.memberId]?.[0]?.pathName).toBe("ACTIVE");
	});

	it("ignores the flag from a plain member", async () => {
		const paths = await list(club.memberUserId, true);
		expect(paths).not.toHaveProperty(formerMemberId);
		expect(paths[club.memberId]?.[0]?.pathName).toBe("ACTIVE");
	});

	it("honours it for an elected officer whose stored role is member", async () => {
		const [term] = await testDb
			.insert(officerTerms)
			.values({
				membershipId: club.memberId,
				position: "secretary",
				termStart: new Date(Date.now() - 86_400_000),
			})
			.returning({ id: officerTerms.id });
		try {
			const paths = await list(club.memberUserId, true);
			expect(paths[formerMemberId]?.[0]?.pathName).toBe("FORMER");
		} finally {
			await testDb.delete(officerTerms).where(eq(officerTerms.id, term.id));
		}
	});

	it("refuses a lapsed admin outright, before any flag is read", async () => {
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, club.adminMemberId));
		try {
			await expect(list(club.adminUserId, true)).rejects.toThrow(
				"You're not a member of this club.",
			);
		} finally {
			await testDb
				.update(members)
				.set({ status: "active" })
				.where(eq(members.id, club.adminMemberId));
		}
	});

	it("honours it under Act as admin, not under View as this club", async () => {
		const su = await seedSuperadmin();

		await startImpersonation(su, { clubId: club.clubId });
		const readOnly = await list(su, true);
		expect(readOnly[club.memberId]?.[0]?.pathName).toBe("ACTIVE");
		expect(readOnly).not.toHaveProperty(formerMemberId);
		await endImpersonation(su);

		await startImpersonation(su, {
			clubId: club.clubId,
			mode: "read_write",
			reason: "checking a former member's record",
		});
		const readWrite = await list(su, true);
		expect(readWrite[formerMemberId]?.[0]?.pathName).toBe("FORMER");
		await endImpersonation(su);
	});

	describe("member page (pathwaysForMember)", () => {
		const former = (viewer: string | null) =>
			pathwaysForMember(club.clubId, formerMemberId, viewer);
		const names = (paths: { pathName: string }[]) =>
			paths.map((p) => p.pathName);

		it("serves an ACTIVE member's paths to anyone, signed in or not", async () => {
			for (const viewer of [null, club.memberUserId, club.adminUserId]) {
				expect(
					names(await pathwaysForMember(club.clubId, club.memberId, viewer)),
				).toEqual(["ACTIVE"]);
			}
		});

		it("withholds a former member's paths without a session", async () => {
			expect(await former(null)).toEqual([]);
		});

		it("withholds them from a signed-in user with no access to the club", async () => {
			expect(await former(await seedSuperadmin())).toEqual([]);
		});

		it("withholds them from a plain member", async () => {
			expect(await former(club.memberUserId)).toEqual([]);
		});

		it("serves them to an admin", async () => {
			expect(names(await former(club.adminUserId))).toEqual(["FORMER"]);
		});

		it("serves them to an elected officer whose stored role is member", async () => {
			const [term] = await testDb
				.insert(officerTerms)
				.values({
					membershipId: club.memberId,
					position: "secretary",
					termStart: new Date(Date.now() - 86_400_000),
				})
				.returning({ id: officerTerms.id });
			try {
				expect(names(await former(club.memberUserId))).toEqual(["FORMER"]);
			} finally {
				await testDb.delete(officerTerms).where(eq(officerTerms.id, term.id));
			}
		});

		it("withholds them under View as this club, serves them under Act as admin", async () => {
			const su = await seedSuperadmin();
			await startImpersonation(su, { clubId: club.clubId });
			expect(await former(su)).toEqual([]);
			await endImpersonation(su);

			await startImpersonation(su, {
				clubId: club.clubId,
				mode: "read_write",
				reason: "checking a former member's record",
			});
			expect(names(await former(su))).toEqual(["FORMER"]);
			await endImpersonation(su);
		});
	});
});
