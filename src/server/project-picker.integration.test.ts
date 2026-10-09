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
	guests,
	meetings,
	members,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
	pathwaysProjects,
	people,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import { hasTestDb, testDb } from "#/test/db";
import { readsOf, statementsDuring } from "#/test/query-spy";

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

	// #1160: the speeches a person has already given or booked, per project.
	describe("given and booked (#1160)", () => {
		const DAY = 24 * 60 * 60 * 1000;
		const HOUR = 60 * 60 * 1000;
		const ICE = "Ice Breaker";
		const ELECTIVE = "Some Elective";
		const TIME = "Managing Time";

		let chicagoClubId: string;
		let laClubId: string;
		let speakerRoleChicago: string;
		let speakerRoleLa: string;
		let meetingSeq = 0;

		beforeAll(async () => {
			const make = async (
				tag: string,
				timezone: string,
			): Promise<{ clubId: string; roleId: string }> => {
				const [club] = await testDb
					.insert(clubs)
					.values({
						name: `${tag} ${SUITE_TAG}`,
						slug: `${tag}-${SUITE_TAG}`,
						timezone,
					})
					.returning({ id: clubs.id });
				const [role] = await testDb
					.insert(roleDefinitions)
					.values({
						clubId: club.id,
						name: "Speaker",
						category: "speaker",
						isSpeakerRole: true,
					})
					.returning({ id: roleDefinitions.id });
				return { clubId: club.id, roleId: role.id };
			};
			const chicago = await make("pk-chi", "America/Chicago");
			const la = await make("pk-la", "America/Los_Angeles");
			chicagoClubId = chicago.clubId;
			speakerRoleChicago = chicago.roleId;
			laClubId = la.clubId;
			speakerRoleLa = la.roleId;
		});

		afterAll(async () => {
			if (!hasTestDb) return;
			await testDb
				.delete(clubs)
				.where(inArray(clubs.id, [chicagoClubId, laClubId]));
		});

		/** A fresh enrolled speaker, so no test sees another's speeches. */
		async function speaker(): Promise<string> {
			const m = await makeMember(chicagoClubId);
			await testDb
				.insert(pathEnrollments)
				.values({ personId: m.personId, pathId: realPathId });
			return m.personId;
		}

		/** One speech on `project` at a meeting at `at`, held by `owner`. */
		async function speechAt(
			owner: { personId: string } | { guestId: string },
			project: string,
			at: Date,
			opts: { cancelled?: boolean; la?: boolean } = {},
		): Promise<void> {
			const [speech] = await testDb
				.insert(speeches)
				.values({
					...owner,
					title: "A speech",
					projectId: projectIds[project],
				})
				.returning({ id: speeches.id });
			// A unique second per meeting: (club, scheduled_at) is unique.
			meetingSeq += 1;
			const [meeting] = await testDb
				.insert(meetings)
				.values({
					clubId: opts.la ? laClubId : chicagoClubId,
					scheduledAt: new Date(at.getTime() + meetingSeq * 1000),
					status: opts.cancelled ? "cancelled" : "scheduled",
				})
				.returning({ id: meetings.id });
			await testDb.insert(roleSlots).values({
				meetingId: meeting.id,
				roleDefinitionId: opts.la ? speakerRoleLa : speakerRoleChicago,
				speechId: speech.id,
			});
		}

		const find = (
			paths: Awaited<ReturnType<typeof listProjectOptions>>,
			project: string,
		) => {
			const found = paths
				.flatMap((p) => p.projects)
				.find((p) => p.id === projectIds[project]);
			if (!found) throw new Error(`${project} missing from the picker`);
			return found;
		};

		it("lists one past speech as given, with its club's zone, and nothing booked", async () => {
			const person = await speaker();
			await speechAt(
				{ personId: person },
				ICE,
				new Date("2026-08-29T18:00:00Z"),
			);

			const row = find(
				await listProjectOptions(person, { includeProgress: true }),
				ICE,
			);
			expect(row.given).toHaveLength(1);
			expect(row.given[0].timeZone).toBe("America/Chicago");
			expect(row.given[0].at.startsWith("2026-08-29T18:00:0")).toBe(true);
			expect(row.booked).toEqual([]);
			// A project with no speech carries neither list.
			const other = find(
				await listProjectOptions(person, { includeProgress: true }),
				ELECTIVE,
			);
			expect(other.given).toEqual([]);
			expect(other.booked).toEqual([]);
		});

		it("orders repeats newest first", async () => {
			const person = await speaker();
			await speechAt(
				{ personId: person },
				ICE,
				new Date("2026-06-13T18:00:00Z"),
			);
			await speechAt(
				{ personId: person },
				ICE,
				new Date("2026-08-29T18:00:00Z"),
			);
			await speechAt(
				{ personId: person },
				ICE,
				new Date("2026-07-11T18:00:00Z"),
			);

			const row = find(
				await listProjectOptions(person, { includeProgress: true }),
				ICE,
			);
			expect(row.given.map((g) => g.at.slice(0, 10))).toEqual([
				"2026-08-29",
				"2026-07-11",
				"2026-06-13",
			]);
		});

		it("lists upcoming speeches as booked, soonest first, beside what was given", async () => {
			const person = await speaker();
			const now = Date.now();
			await speechAt({ personId: person }, ICE, new Date(now + 15 * DAY));
			await speechAt({ personId: person }, ICE, new Date(now + 8 * DAY));
			await speechAt(
				{ personId: person },
				ICE,
				new Date("2026-08-29T18:00:00Z"),
			);

			const row = find(
				await listProjectOptions(person, { includeProgress: true }),
				ICE,
			);
			expect(row.booked).toHaveLength(2);
			expect(new Date(row.booked[0].at).getTime()).toBeLessThan(
				new Date(row.booked[1].at).getTime(),
			);
			expect(new Date(row.booked[0].at).getTime()).toBeGreaterThan(now);
			expect(row.given).toHaveLength(1);
		});

		it("takes each date's zone from the meeting's own club, not the speaker's", async () => {
			const person = await speaker();
			await speechAt(
				{ personId: person },
				ICE,
				new Date("2026-08-30T03:00:00Z"),
				{ la: true },
			);
			const row = find(
				await listProjectOptions(person, { includeProgress: true }),
				ICE,
			);
			expect(row.given[0].timeZone).toBe("America/Los_Angeles");
		});

		it("never counts a cancelled meeting, a guest's speech or another person's", async () => {
			const person = await speaker();
			const rival = await speaker();
			await speechAt(
				{ personId: person },
				ICE,
				new Date("2026-08-29T18:00:00Z"),
				{ cancelled: true },
			);
			await speechAt(
				{ personId: person },
				TIME,
				new Date(Date.now() + 9 * DAY),
				{ cancelled: true },
			);
			await speechAt(
				{ personId: rival },
				ELECTIVE,
				new Date("2026-08-29T18:00:00Z"),
			);
			await speechAt({ personId: rival }, TIME, new Date(Date.now() + 9 * DAY));

			// A guest's speech has a NULL person_id. The guest row needs a Person;
			// the club delete in this block's afterAll removes the guest before the
			// outer afterAll removes any Person (guests.person_id is RESTRICT).
			const guestPerson = await makeMember(chicagoClubId);
			const [guest] = await testDb
				.insert(guests)
				.values({
					clubId: chicagoClubId,
					name: "Visitor",
					personId: guestPerson.personId,
				})
				.returning({ id: guests.id });
			await speechAt(
				{ guestId: guest.id },
				ICE,
				new Date("2026-08-29T18:00:00Z"),
			);
			await speechAt(
				{ guestId: guest.id },
				ELECTIVE,
				new Date(Date.now() + 9 * DAY),
			);

			const paths = await listProjectOptions(person, { includeProgress: true });
			for (const name of [ICE, ELECTIVE, TIME]) {
				const row = find(paths, name);
				expect(row.given, `${name} given`).toEqual([]);
				expect(row.booked, `${name} booked`).toEqual([]);
			}
		});

		it("returns empty lists and never reads speeches for an anonymous caller", async () => {
			const person = await speaker();
			await speechAt(
				{ personId: person },
				ICE,
				new Date("2026-08-29T18:00:00Z"),
			);
			await speechAt({ personId: person }, ICE, new Date(Date.now() + 8 * DAY));

			let paths: Awaited<ReturnType<typeof listProjectOptions>> = [];
			const statements = await statementsDuring(async () => {
				paths = await listProjectOptions(person, { includeProgress: false });
			});

			// Non-empty first: a dead spy would make the zero below vacuous.
			expect(statements.length).toBeGreaterThan(0);
			expect(readsOf(statements, "speeches")).toHaveLength(0);
			const all = paths.flatMap((p) => p.projects);
			expect(all.length).toBeGreaterThan(0);
			for (const p of all) {
				expect(p.given).toEqual([]);
				expect(p.booked).toEqual([]);
			}
		});

		it("reads speeches in exactly one statement, however many speeches and projects", async () => {
			const one = await speaker();
			await speechAt({ personId: one }, ICE, new Date("2026-08-29T18:00:00Z"));
			const many = await speaker();
			const now = Date.now();
			const names = [ICE, ELECTIVE, TIME];
			for (let i = 0; i < 10; i++) {
				const when =
					i < 6
						? new Date(now - (i + 1) * 7 * DAY)
						: new Date(now + (i - 5) * 7 * DAY + HOUR);
				await speechAt({ personId: many }, names[i % 3], when);
			}

			for (const [label, person, rows] of [
				["1 speech", one, 1],
				["10 speeches", many, 10],
			] as const) {
				const statements = await statementsDuring(() =>
					listProjectOptions(person, { includeProgress: true }),
				);
				expect(statements.length, "spy saw nothing").toBeGreaterThan(0);
				expect(readsOf(statements, "speeches"), label).toHaveLength(1);
				// And it is the payload those speeches produce, so one statement
				// is not one statement that returned nothing.
				const paths = await listProjectOptions(person, {
					includeProgress: true,
				});
				const total = paths
					.flatMap((p) => p.projects)
					.reduce((n, p) => n + p.given.length + p.booked.length, 0);
				expect(total, label).toBe(rows);
			}
		});
	});
});
