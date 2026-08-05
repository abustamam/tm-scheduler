/**
 * DB-backed tests for the Pathways project picker (#418).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/project-picker.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { user } from "#/db/auth-schema";
import {
	bcmProjectProgress,
	clubs,
	members,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
	pathwaysProjects,
	people,
} from "#/db/schema";
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	listProjectOptions,
	resolveProjectDisplay,
	resolveMemberSubject,
	viewerMaySeeProgress,
} = await import("./project-picker-logic");

// Other suites share these tables, so this one inserts its own paths. 8701 is a
// REAL allowlisted code and 9901 is not — the pair is the point of the first
// test. Course codes are globally unique, so the real one can't be re-inserted
// here; the suite adopts whatever 8701 row already exists (seeded or not).
const SUITE_TAG = randomUUID().slice(0, 8);

let clubId: string;
let personId: string;
let memberId: string;
let realPathId: string;
let realPathSeeded: boolean;
let fakePathId: string;
let enrollmentId: string;
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
	name: string,
	isRequired: boolean,
) {
	const [row] = await testDb
		.insert(pathwaysProjects)
		.values({ pathId, level, name: `${name} ${SUITE_TAG}`, isRequired })
		.returning({ id: pathwaysProjects.id });
	projectIds[name] = row.id;
	return row.id;
}

describe.skipIf(!hasTestDb)("project picker (#418)", () => {
	beforeAll(async () => {
		const [club] = await testDb
			.insert(clubs)
			.values({ name: `Picker ${SUITE_TAG}`, slug: `picker-${SUITE_TAG}` })
			.returning({ id: clubs.id });
		clubId = club.id;

		const subject = await makeMember(clubId);
		personId = subject.personId;
		memberId = subject.memberId;

		// An allowlisted path — adopt the shared 8701 row if the catalog is seeded.
		const [existing] = await testDb
			.select({ id: pathwaysPaths.id })
			.from(pathwaysPaths)
			.where(eq(pathwaysPaths.courseCode, "8701"));
		realPathSeeded = existing !== undefined;
		if (existing) {
			realPathId = existing.id;
		} else {
			const [created] = await testDb
				.insert(pathwaysPaths)
				.values({ courseCode: "8701", name: "Presentation Mastery" })
				.returning({ id: pathwaysPaths.id });
			realPathId = created.id;
		}

		// A NON-allowlisted course, exactly as a Base Camp sync of a non-path
		// enrollment would leave behind: a real row in a global table with no
		// club scoping.
		const [fake] = await testDb
			.insert(pathwaysPaths)
			.values({
				courseCode: `9901-${SUITE_TAG}`,
				name: `Pathways Mentor Program ${SUITE_TAG}`,
			})
			.returning({ id: pathwaysPaths.id });
		fakePathId = fake.id;

		await addProject(realPathId, 1, "Ice Breaker", true);
		await addProject(realPathId, 1, "Some Elective", false);
		await addProject(realPathId, 2, "Managing Time", true);
		await addProject(fakePathId, 1, "Mentor Orientation", true);

		// Enrolled in BOTH — the allowlist, not the enrollment, is what excludes
		// the non-path course.
		const [enr] = await testDb
			.insert(pathEnrollments)
			.values({ personId, pathId: realPathId })
			.returning({ id: pathEnrollments.id });
		enrollmentId = enr.id;
		await testDb
			.insert(pathEnrollments)
			.values({ personId, pathId: fakePathId });
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
		await testDb.delete(clubs).where(eq(clubs.id, clubId));
		if (createdUserIds.length > 0) {
			await testDb.delete(user).where(inArray(user.id, createdUserIds));
		}
	});

	// `pathways_paths` is global (no club_id) and any club's sync can insert into
	// it. Without the allowlist, one member enrolled in the Pathways Mentor
	// Program would make it a pickable "path" for every club on the platform.
	it("offers enrolled paths but never a non-allowlisted course", async () => {
		const paths = await listProjectOptions(personId, {
			includeProgress: false,
		});
		expect(paths.map((p) => p.pathId)).toContain(realPathId);
		expect(paths.map((p) => p.pathId)).not.toContain(fakePathId);
	});

	it("offers nothing for a member with no declared path", async () => {
		const other = await makeMember(clubId);
		expect(
			await listProjectOptions(other.personId, { includeProgress: false }),
		).toEqual([]);
	});

	it("drops a path once its enrollment is archived", async () => {
		const leaver = await makeMember(clubId);
		await testDb
			.insert(pathEnrollments)
			.values({ personId: leaver.personId, pathId: realPathId });
		expect(
			await listProjectOptions(leaver.personId, { includeProgress: false }),
		).toHaveLength(1);

		await testDb
			.update(pathEnrollments)
			.set({ archivedAt: new Date() })
			.where(eq(pathEnrollments.personId, leaver.personId));
		expect(
			await listProjectOptions(leaver.personId, { includeProgress: false }),
		).toEqual([]);
	});

	describe("completion marks", () => {
		beforeAll(async () => {
			await testDb.insert(bcmProjectProgress).values({
				enrollmentId,
				projectId: projectIds["Ice Breaker"],
				complete: true,
			});
		});

		it("marks a completed project — and keeps it selectable", async () => {
			const [path] = await listProjectOptions(personId, {
				includeProgress: true,
			});
			const done = path.projects.find(
				(p) => p.id === projectIds["Ice Breaker"],
			);
			expect(done?.complete).toBe(true);
			// Repeats are real: path_level_progress.completed may exceed total
			// precisely because members redo projects. So a completed project is
			// still LISTED — the tick informs, it never filters.
			for (const id of Object.values(projectIds)) {
				if (id === projectIds["Mentor Orientation"]) continue;
				expect(path.projects.map((p) => p.id)).toContain(id);
			}
		});

		// The public club page is a soft honor-system name-pick, and which
		// projects someone has FINISHED is a personal educational record.
		it("hides completion from an anonymous caller, same options otherwise", async () => {
			const [anon] = await listProjectOptions(personId, {
				includeProgress: false,
			});
			const [known] = await listProjectOptions(personId, {
				includeProgress: true,
			});
			expect(anon.projects.map((p) => p.id)).toEqual(
				known.projects.map((p) => p.id),
			);
			expect(anon.projects.every((p) => !p.complete)).toBe(true);
			expect(known.projects.some((p) => p.complete)).toBe(true);
		});

		it("opens on the level Base Camp approved through, not the mirror", async () => {
			await testDb.insert(pathLevelProgress).values({
				enrollmentId,
				level: 1,
				completed: 4,
				total: 4,
				approved: true,
			});
			const [path] = await listProjectOptions(personId, {
				includeProgress: true,
			});
			expect(path.defaultLevel).toBe(2);
		});
	});

	describe("viewerMaySeeProgress", () => {
		it("lets the member see their own", async () => {
			const userId = await makeUser();
			const self = await makeMember(clubId, userId);
			expect(
				await viewerMaySeeProgress({
					userId,
					clubId,
					personId: self.personId,
				}),
			).toBe(true);
		});

		it("lets a club admin see a member's", async () => {
			const userId = await makeUser();
			const admin = await makeMember(clubId, userId);
			await testDb
				.update(members)
				.set({ clubRole: "admin" })
				.where(eq(members.id, admin.memberId));
			expect(await viewerMaySeeProgress({ userId, clubId, personId })).toBe(
				true,
			);
		});

		it("refuses a fellow member who is not an admin", async () => {
			const userId = await makeUser();
			await makeMember(clubId, userId);
			expect(await viewerMaySeeProgress({ userId, clubId, personId })).toBe(
				false,
			);
		});

		it("refuses an admin of a different club", async () => {
			const [other] = await testDb
				.insert(clubs)
				.values({
					name: `Other ${SUITE_TAG}`,
					slug: `other-picker-${SUITE_TAG}`,
				})
				.returning({ id: clubs.id });
			const userId = await makeUser();
			const elsewhere = await makeMember(other.id, userId);
			await testDb
				.update(members)
				.set({ clubRole: "admin" })
				.where(eq(members.id, elsewhere.memberId));

			expect(await viewerMaySeeProgress({ userId, clubId, personId })).toBe(
				false,
			);
			await testDb.delete(clubs).where(eq(clubs.id, other.id));
		});
	});

	it("resolves a member to their person and their OWN club", async () => {
		expect(await resolveMemberSubject(memberId)).toEqual({ personId, clubId });
		expect(await resolveMemberSubject(randomUUID())).toBeNull();
	});

	describe("resolveProjectDisplay", () => {
		// Every display surface — agenda, print, deck, run sheet, reporting —
		// reads the free-text triple, so a picked project has to produce it.
		it("returns the catalog's path, project and level label", async () => {
			const display = await resolveProjectDisplay(projectIds["Managing Time"]);
			expect(display.projectName).toBe(`Managing Time ${SUITE_TAG}`);
			expect(display.projectLevel).toBe("Level 2");
			expect(display.pathwayPath).toBeTruthy();
		});

		it("rejects an unknown id", async () => {
			await expect(resolveProjectDisplay(randomUUID())).rejects.toThrow(
				"no longer exists",
			);
		});

		// The picker only offers allowlisted paths, but this is a plain uuid over
		// the wire and the claim path is anonymous — so the id is re-checked.
		it("rejects a project on a non-allowlisted course", async () => {
			await expect(
				resolveProjectDisplay(projectIds["Mentor Orientation"]),
			).rejects.toThrow("no longer exists");
		});

		/**
		 * #526. `applyProjectDisplay` writes these three onto the speech AFTER
		 * `speakerDetailsSchema` has run, so an unbounded catalog name is a way
		 * around a cap the schema advertises. The catalog is genuinely unbounded
		 * at ingest — `pathways-ingest-logic.ts` types the payload as
		 * `z.array(z.unknown())`, so only the array LENGTHS are checked and the
		 * name strings inside are not.
		 *
		 * Asserts the ABSOLUTE cap, not `<= SPEAKER_LIMITS.projectName`, which
		 * would pass for every value of that constant including one that
		 * reintroduces the bypass.
		 */
		it("clamps a catalog name that exceeds the speaker-detail cap", async () => {
			const id = await addProject(realPathId, 1, "z".repeat(5_000), false);
			const display = await resolveProjectDisplay(id);
			// CODE POINTS, not `.length` — `cap` bounds code points, so an
			// all-astral name legitimately returns up to 2x that in UTF-16 units
			// and a `.length` assertion would be measuring the wrong thing.
			// The ceiling is ABSOLUTE (120, the shipped cap) rather than
			// `<= SPEAKER_LIMITS.projectName`, which passes for every value of
			// that constant including one that reopens the bypass.
			expect([...display.projectName].length).toBeLessThanOrEqual(120);
			expect(display.projectName.length).toBeGreaterThan(0);
			// Truncated by CODE POINT, so it can never emit a lone surrogate.
			expect(
				/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
					display.projectName,
				),
			).toBe(false);
		});

		/**
		 * The READ half. `getProjectOptions` is PUBLIC/no-session, and clamping
		 * only where a picked project is WRITTEN would still let an oversized
		 * catalog name be materialised into an anonymous JSON payload.
		 *
		 * Without this the write-side clamp can be deleted from the option list
		 * and every other test stays green — verified by mutation.
		 */
		it("caps catalog names on the PUBLIC option list too", async () => {
			await addProject(realPathId, 1, "q".repeat(5_000), false);
			const paths = await listProjectOptions(personId, {
				includeProgress: false,
			});
			const names = paths.flatMap((p) => [
				p.name,
				...p.projects.map((x) => x.name),
			]);
			expect(names.length).toBeGreaterThan(0);
			for (const n of names) {
				// ABSOLUTE ceilings (the shipped caps), by CODE POINT.
				expect([...n].length).toBeLessThanOrEqual(120);
			}
			// And the hostile one really is in this payload, so the loop is not
			// passing over an empty or unrelated set.
			expect(names.some((n) => n.startsWith("qqq"))).toBe(true);
		});

		it("leaves an ordinary catalog name untouched", async () => {
			// The clamp must not shorten anything real — the longest name in the
			// live catalog is 56 characters against a 120 cap. Without this, a cap
			// of 1 would satisfy the bound above and silently elide every project
			// name in the app.
			const display = await resolveProjectDisplay(projectIds["Managing Time"]);
			expect(display.projectName).toBe(`Managing Time ${SUITE_TAG}`);
			expect(display.projectName).not.toContain("…");
		});
	});
});
