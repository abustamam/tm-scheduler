/**
 * DB-backed tests for manual path enrollment (#417).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/path-enrollment.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { user } from "#/db/auth-schema";
import {
	clubs,
	members,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
	people,
} from "#/db/schema";
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// `resolveEnrollmentAuthz` delegates the not-self case to `requireClubRole`,
// which reads the session. Mocked so this suite tests the BRANCHING — self vs
// admin vs neither — rather than re-testing the guard itself.
const requireClubRole = vi.fn();
vi.mock("./guards", () => ({
	requireClubRole: (...args: unknown[]) => requireClubRole(...args),
}));

const {
	listEnrollablePaths,
	listMemberEnrollments,
	resolveEnrollmentAuthz,
	enrollInPath,
	archiveEnrollment,
	selfPersonId,
} = await import("./path-enrollment-logic");

// pathways_paths.course_code is globally unique and other suites touch the same
// shared tm_test tables, so this suite's own paths carry a unique tag. Real
// allowlisted codes (8700 etc.) are only ever READ here, never inserted.
const SUITE_TAG = randomUUID().slice(0, 8);
const tagged = (base: string) => `${base}-${SUITE_TAG}`;

let clubId: string;
let otherClubId: string;
let pathId: string;
const createdPersonIds: string[] = [];
const createdUserIds: string[] = [];

/** `people.user_id` FKs to Better-Auth's `user`, so a signed-in fixture needs a
 *  real row there — a bare uuid violates the constraint. */
async function makeUser(): Promise<string> {
	const id = randomUUID();
	await testDb
		.insert(user)
		.values({ id, name: "U", email: `${id}@example.com` });
	createdUserIds.push(id);
	return id;
}

async function makeMember(clubFor: string, userId?: string) {
	const personId = randomUUID();
	await testDb.insert(people).values({
		id: personId,
		name: "P",
		email: `${personId}@example.com`,
		userId,
	});
	createdPersonIds.push(personId);
	const [row] = await testDb
		.insert(members)
		.values({ clubId: clubFor, personId, name: "P" })
		.returning({ id: members.id });
	return { personId, memberId: row.id };
}

describe.skipIf(!hasTestDb)("manual path enrollment", () => {
	beforeAll(async () => {
		const [club] = await testDb
			.insert(clubs)
			.values({ name: `Enroll ${SUITE_TAG}`, slug: `enroll-${SUITE_TAG}` })
			.returning({ id: clubs.id });
		clubId = club.id;
		const [other] = await testDb
			.insert(clubs)
			.values({ name: `Other ${SUITE_TAG}`, slug: `other-${SUITE_TAG}` })
			.returning({ id: clubs.id });
		otherClubId = other.id;

		const [p] = await testDb
			.insert(pathwaysPaths)
			.values({ courseCode: tagged("9900"), name: "Suite Path" })
			.returning({ id: pathwaysPaths.id });
		pathId = p.id;
	});

	afterAll(async () => {
		if (!hasTestDb) return;
		if (createdPersonIds.length > 0) {
			await testDb.delete(people).where(inArray(people.id, createdPersonIds));
		}
		await testDb.delete(pathwaysPaths).where(eq(pathwaysPaths.id, pathId));
		await testDb.delete(clubs).where(inArray(clubs.id, [clubId, otherClubId]));
		if (createdUserIds.length > 0) {
			await testDb.delete(user).where(inArray(user.id, createdUserIds));
		}
	});

	// The allowlist is what stops one club's sync injecting a non-path course
	// (Pathways Mentor Program, Speechcraft) into every club's picker (#414).
	it("offers only the 11 real course codes, never a suite-invented one", async () => {
		const paths = await listEnrollablePaths();
		expect(paths.map((p) => p.courseCode)).not.toContain(tagged("9900"));
		const allowed = new Set([
			"8700",
			"8701",
			"8702",
			"8703",
			"8704",
			"8705",
			"8706",
			"8707",
			"8708",
			"8709",
			"8711",
		]);
		for (const p of paths) expect(allowed.has(p.courseCode)).toBe(true);
	});

	it("enrolls, is idempotent, and un-archives rather than duplicating", async () => {
		const { personId } = await makeMember(clubId);

		await enrollInPath(personId, pathId);
		await enrollInPath(personId, pathId); // idempotent
		expect(await listMemberEnrollments(personId)).toHaveLength(1);

		await archiveEnrollment(personId, pathId);
		expect(await listMemberEnrollments(personId)).toHaveLength(0);

		// Archived, NOT deleted — bcm_project_progress cascades off the enrollment,
		// so deleting would discard the member's completion history for that path.
		const rows = await testDb
			.select({ id: pathEnrollments.id })
			.from(pathEnrollments)
			.where(
				and(
					eq(pathEnrollments.personId, personId),
					eq(pathEnrollments.pathId, pathId),
				),
			);
		expect(rows).toHaveLength(1);

		// Re-declaring resumes the SAME row rather than making a second one.
		await enrollInPath(personId, pathId);
		expect(await listMemberEnrollments(personId)).toHaveLength(1);
		const after = await testDb
			.select({ id: pathEnrollments.id })
			.from(pathEnrollments)
			.where(eq(pathEnrollments.personId, personId));
		expect(after).toHaveLength(1);
		expect(after[0].id).toBe(rows[0].id);
	});

	// `synced` is derived from path_level_progress, which only the summary sync
	// writes — `last_synced_at` can't serve, since it defaults to now() on insert.
	it("reports a manual enrollment as unsynced until Base Camp speaks", async () => {
		const { personId } = await makeMember(clubId);
		await enrollInPath(personId, pathId);
		expect((await listMemberEnrollments(personId))[0].synced).toBe(false);

		const [enr] = await testDb
			.select({ id: pathEnrollments.id })
			.from(pathEnrollments)
			.where(eq(pathEnrollments.personId, personId));
		await testDb.insert(pathLevelProgress).values({
			enrollmentId: enr.id,
			level: 1,
			completed: 2,
			total: 4,
			approved: false,
		});
		expect((await listMemberEnrollments(personId))[0].synced).toBe(true);
	});

	describe("authorization", () => {
		it("lets a member manage their own paths without an admin check", async () => {
			const userId = await makeUser();
			const { personId, memberId } = await makeMember(clubId, userId);
			requireClubRole.mockClear();

			const res = await resolveEnrollmentAuthz({ userId, clubId, memberId });
			expect(res.personId).toBe(personId);
			// Never consulted — self short-circuits before the admin gate.
			expect(requireClubRole).not.toHaveBeenCalled();
		});

		it("lets a club admin manage another member's paths", async () => {
			const adminUserId = await makeUser();
			await makeMember(clubId, adminUserId);
			const target = await makeMember(clubId);
			requireClubRole.mockClear();
			requireClubRole.mockResolvedValue({ clubRole: "admin" });

			const res = await resolveEnrollmentAuthz({
				userId: adminUserId,
				clubId,
				memberId: target.memberId,
			});
			expect(res.personId).toBe(target.personId);
			expect(requireClubRole).toHaveBeenCalledWith(adminUserId, clubId, [
				"admin",
			]);
		});

		it("rejects a non-admin managing someone else", async () => {
			const userId = await makeUser();
			await makeMember(clubId, userId);
			const target = await makeMember(clubId);
			requireClubRole.mockClear();
			requireClubRole.mockRejectedValue(
				new Error("You don't have permission to do that."),
			);

			await expect(
				resolveEnrollmentAuthz({ userId, clubId, memberId: target.memberId }),
			).rejects.toThrow("permission");
		});

		// Never crosses club boundaries, even for an admin of the other club.
		it("rejects a member id that belongs to a different club", async () => {
			const userId = await makeUser();
			await makeMember(clubId, userId);
			const elsewhere = await makeMember(otherClubId);
			requireClubRole.mockClear();
			requireClubRole.mockResolvedValue({ clubRole: "admin" });

			await expect(
				resolveEnrollmentAuthz({
					userId,
					clubId,
					memberId: elsewhere.memberId,
				}),
			).rejects.toThrow("Member not found in this club.");
			expect(requireClubRole).not.toHaveBeenCalled();
		});
	});

	it("returns null for an account with no linked person", async () => {
		expect(await selfPersonId(randomUUID())).toBeNull();
	});
});
