/**
 * DB-backed tests for explicit progress marks (#419).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/progress-marks.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { user } from "#/db/auth-schema";
import {
	clubs,
	members,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPathLevels,
	pathwaysPaths,
	pathwaysProjects,
	people,
	projectCompletionMarks,
} from "#/db/schema";
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// `resolveMarkAuthz` delegates the not-self case to `requireClubRole`, which
// reads the session. Mocked so this suite tests the BRANCHING, not the guard.
const requireClubRole = vi.fn();
vi.mock("./guards", () => ({
	requireClubRole: (...args: unknown[]) => requireClubRole(...args),
}));

const {
	resolveMarkTarget,
	markProjectComplete,
	unmarkProjectComplete,
	resolveMarkAuthz,
} = await import("./progress-marks-logic");
const { pathwaysForPerson } = await import("./pathways-read-logic");

const SUITE_TAG = randomUUID().slice(0, 8);

let clubId: string;
let otherClubId: string;
let personId: string;
let memberId: string;
let enrollmentId: string;
let realPathId: string;
let realPathSeeded: boolean;
let fakePathId: string;
const projectIds: Record<string, string> = {};
const createdUserIds: string[] = [];
const createdPersonIds: string[] = [];

async function makeUser(): Promise<string> {
	const id = randomUUID();
	await testDb
		.insert(user)
		.values({ id, name: "U", email: `${id}@example.com` });
	createdUserIds.push(id);
	return id;
}

async function makeMember(clubFor: string, userId?: string) {
	const pid = randomUUID();
	await testDb
		.insert(people)
		.values({ id: pid, name: "P", email: `${pid}@example.com`, userId });
	createdPersonIds.push(pid);
	const [row] = await testDb
		.insert(members)
		.values({ clubId: clubFor, personId: pid, name: "P" })
		.returning({ id: members.id });
	return { personId: pid, memberId: row.id };
}

async function addProject(
	pathId: string,
	level: number,
	key: string,
	isRequired: boolean,
) {
	const [row] = await testDb
		.insert(pathwaysProjects)
		.values({ pathId, level, name: `${key} ${SUITE_TAG}`, isRequired })
		.returning({ id: pathwaysProjects.id });
	projectIds[key] = row.id;
	return row.id;
}

describe.skipIf(!hasTestDb)("progress marks (#419)", () => {
	beforeAll(async () => {
		const [club] = await testDb
			.insert(clubs)
			.values({ name: `Marks ${SUITE_TAG}`, slug: `marks-${SUITE_TAG}` })
			.returning({ id: clubs.id });
		clubId = club.id;
		const [other] = await testDb
			.insert(clubs)
			.values({ name: `MarksB ${SUITE_TAG}`, slug: `marks-b-${SUITE_TAG}` })
			.returning({ id: clubs.id });
		otherClubId = other.id;

		const subject = await makeMember(clubId);
		personId = subject.personId;
		memberId = subject.memberId;

		const [existing] = await testDb
			.select({ id: pathwaysPaths.id })
			.from(pathwaysPaths)
			.where(eq(pathwaysPaths.courseCode, "8707"));
		realPathSeeded = existing !== undefined;
		if (existing) {
			realPathId = existing.id;
		} else {
			const [created] = await testDb
				.insert(pathwaysPaths)
				.values({ courseCode: "8707", name: "Persuasive Influence" })
				.returning({ id: pathwaysPaths.id });
			realPathId = created.id;
		}

		// A non-allowlisted course, as a sync of a non-path enrollment would leave.
		const [fake] = await testDb
			.insert(pathwaysPaths)
			.values({
				courseCode: `9902-${SUITE_TAG}`,
				name: `Speechcraft ${SUITE_TAG}`,
			})
			.returning({ id: pathwaysPaths.id });
		fakePathId = fake.id;

		await addProject(realPathId, 1, "Ice Breaker", true);
		await addProject(realPathId, 2, "Managing Time", true);
		await addProject(fakePathId, 1, "Speechcraft Intro", true);

		const [enr] = await testDb
			.insert(pathEnrollments)
			.values({ personId, pathId: realPathId })
			.returning({ id: pathEnrollments.id });
		enrollmentId = enr.id;
	});

	afterAll(async () => {
		if (!hasTestDb) return;
		await testDb
			.delete(pathwaysProjects)
			.where(inArray(pathwaysProjects.id, Object.values(projectIds)));
		if (createdPersonIds.length > 0) {
			await testDb.delete(people).where(inArray(people.id, createdPersonIds));
		}
		await testDb.delete(pathwaysPaths).where(eq(pathwaysPaths.id, fakePathId));
		if (!realPathSeeded) {
			await testDb
				.delete(pathwaysPaths)
				.where(eq(pathwaysPaths.id, realPathId));
		}
		await testDb.delete(clubs).where(inArray(clubs.id, [clubId, otherClubId]));
		if (createdUserIds.length > 0) {
			await testDb.delete(user).where(inArray(user.id, createdUserIds));
		}
	});

	describe("resolveMarkTarget", () => {
		it("resolves a project on an enrolled path to its enrollment", async () => {
			expect(
				await resolveMarkTarget({
					personId,
					projectId: projectIds["Ice Breaker"],
				}),
			).toEqual({ enrollmentId });
		});

		// A mark hangs off an enrollment. Marking a project on a path the member
		// never declared has nowhere to go — refuse rather than silently create
		// an enrollment they didn't ask for.
		it("refuses a project on a path the member isn't enrolled in", async () => {
			const stranger = await makeMember(clubId);
			await expect(
				resolveMarkTarget({
					personId: stranger.personId,
					projectId: projectIds["Ice Breaker"],
				}),
			).rejects.toThrow("isn't on a path you're enrolled in");
		});

		it("refuses a project on a non-allowlisted course", async () => {
			await testDb
				.insert(pathEnrollments)
				.values({ personId, pathId: fakePathId });
			await expect(
				resolveMarkTarget({
					personId,
					projectId: projectIds["Speechcraft Intro"],
				}),
			).rejects.toThrow("isn't on a path you're enrolled in");
			await testDb
				.delete(pathEnrollments)
				.where(eq(pathEnrollments.pathId, fakePathId));
		});
	});

	describe("mark / unmark", () => {
		it("is idempotent and reversible", async () => {
			const projectId = projectIds["Ice Breaker"];
			await markProjectComplete({
				enrollmentId,
				projectId,
				markedByMemberId: memberId,
			});
			await markProjectComplete({
				enrollmentId,
				projectId,
				markedByMemberId: memberId,
			});
			const rows = await testDb
				.select({ id: projectCompletionMarks.id })
				.from(projectCompletionMarks)
				.where(eq(projectCompletionMarks.enrollmentId, enrollmentId));
			expect(rows).toHaveLength(1);

			await unmarkProjectComplete({ enrollmentId, projectId });
			expect(
				await testDb
					.select({ id: projectCompletionMarks.id })
					.from(projectCompletionMarks)
					.where(eq(projectCompletionMarks.enrollmentId, enrollmentId)),
			).toHaveLength(0);
		});

		it("records who made the mark", async () => {
			const projectId = projectIds["Managing Time"];
			await markProjectComplete({
				enrollmentId,
				projectId,
				markedByMemberId: memberId,
			});
			const [row] = await testDb
				.select({ by: projectCompletionMarks.markedByMemberId })
				.from(projectCompletionMarks)
				.where(eq(projectCompletionMarks.projectId, projectId));
			expect(row.by).toBe(memberId);
			await unmarkProjectComplete({ enrollmentId, projectId });
		});
	});

	// The regression this whole issue turns on: before #419 `pathwaysForPerson`
	// INNER-joined path_level_progress, so a hand-declared enrollment produced
	// no view model and the dashboard claimed the club hadn't synced.
	describe("pathwaysForPerson with no Base Camp data", () => {
		it("returns a real path for a hand-declared enrollment", async () => {
			const paths = await pathwaysForPerson(personId);
			const mine = paths.find((p) => p.courseCode === "8707");
			expect(mine).toBeDefined();
			expect(mine?.levelsSource).toBe("catalog");
			expect(mine?.hasBasecamp).toBe(false);
			expect(mine?.complete).toBe(false);
		});

		it("moves a marked project from up-next into wins", async () => {
			const projectId = projectIds["Ice Breaker"];
			const before = await pathwaysForPerson(personId);
			const beforePath = before.find((p) => p.courseCode === "8707");
			expect(beforePath?.wins.map((w) => w.projectId)).not.toContain(projectId);

			await markProjectComplete({
				enrollmentId,
				projectId,
				markedByMemberId: memberId,
			});
			const after = await pathwaysForPerson(personId);
			const afterPath = after.find((p) => p.courseCode === "8707");
			const win = afterPath?.wins.find((w) => w.projectId === projectId);
			expect(win?.markedHere).toBe(true);
			// No Base Camp per-project verdict exists, so nothing is "awaiting".
			expect(win?.awaitingProcessing).toBe(false);
			expect(afterPath?.upNext.map((p) => p.projectId)).not.toContain(
				projectId,
			);
			await unmarkProjectComplete({ enrollmentId, projectId });
		});

		it("hides the path once the enrollment is archived", async () => {
			await testDb
				.update(pathEnrollments)
				.set({ archivedAt: new Date() })
				.where(eq(pathEnrollments.id, enrollmentId));
			const paths = await pathwaysForPerson(personId);
			expect(paths.map((p) => p.courseCode)).not.toContain("8707");
			await testDb
				.update(pathEnrollments)
				.set({ archivedAt: null })
				.where(eq(pathEnrollments.id, enrollmentId));
		});

		// Base Camp's counts are real data and stay authoritative the moment they
		// exist — marks never overwrite them.
		it("switches back to Base Camp levels once a sync lands", async () => {
			await testDb.insert(pathwaysPathLevels).values({
				pathId: realPathId,
				level: 1,
				minReqElectives: 0,
			});
			await testDb.insert(pathLevelProgress).values({
				enrollmentId,
				level: 1,
				completed: 3,
				total: 4,
				approved: false,
			});
			const paths = await pathwaysForPerson(personId);
			const mine = paths.find((p) => p.courseCode === "8707");
			expect(mine?.levelsSource).toBe("basecamp");
			expect(mine?.levels.find((l) => l.level === 1)?.total).toBe(4);

			await testDb
				.delete(pathLevelProgress)
				.where(eq(pathLevelProgress.enrollmentId, enrollmentId));
			await testDb
				.delete(pathwaysPathLevels)
				.where(eq(pathwaysPathLevels.pathId, realPathId));
		});
	});

	describe("authorization", () => {
		it("lets a member mark their own without an admin check", async () => {
			const userId = await makeUser();
			const self = await makeMember(clubId, userId);
			requireClubRole.mockClear();

			const res = await resolveMarkAuthz({
				userId,
				clubId,
				memberId: self.memberId,
			});
			expect(res.personId).toBe(self.personId);
			expect(res.actorMemberId).toBe(self.memberId);
			expect(requireClubRole).not.toHaveBeenCalled();
		});

		it("lets a club admin mark for another member, and records the admin", async () => {
			const adminUserId = await makeUser();
			const admin = await makeMember(clubId, adminUserId);
			requireClubRole.mockClear();
			requireClubRole.mockResolvedValue({ clubRole: "admin" });

			const res = await resolveMarkAuthz({
				userId: adminUserId,
				clubId,
				memberId,
			});
			expect(res.personId).toBe(personId);
			expect(res.actorMemberId).toBe(admin.memberId);
			expect(requireClubRole).toHaveBeenCalledWith(adminUserId, clubId, [
				"admin",
			]);
		});

		it("rejects a non-admin marking someone else", async () => {
			const userId = await makeUser();
			await makeMember(clubId, userId);
			requireClubRole.mockClear();
			requireClubRole.mockRejectedValue(
				new Error("You don't have permission to do that."),
			);
			await expect(
				resolveMarkAuthz({ userId, clubId, memberId }),
			).rejects.toThrow("permission");
		});

		it("rejects a member id from a different club", async () => {
			const userId = await makeUser();
			await makeMember(clubId, userId);
			const elsewhere = await makeMember(otherClubId);
			requireClubRole.mockClear();
			requireClubRole.mockResolvedValue({ clubRole: "admin" });
			await expect(
				resolveMarkAuthz({ userId, clubId, memberId: elsewhere.memberId }),
			).rejects.toThrow("Member not found in this club.");
			expect(requireClubRole).not.toHaveBeenCalled();
		});
	});
});
