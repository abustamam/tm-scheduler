/**
 * DB-backed tests for the roster's Pathway payload and a member who has LEFT
 * the club (#1342).
 *
 * `includeInactive` on `pathwaysByMember` means inactive, never former. It used
 * to drop the status filter, so `?formerPathways=true` put a former member's
 * paths on the payload; the page then discarded them, because a former member is
 * on no roster segment. A former member's Pathways stay on their own profile
 * (`pathwaysForMember`), for an admin.
 *
 * `roster-former-pathways.integration.test.ts` covers the inactive member (its
 * "former" fixture is an `inactive` membership, written before the `former`
 * status existed); this file adds the status that file does not seed.
 *
 * Run with a bootstrapped worktree (`bun run worktree:setup`):
 *   bunx vitest run src/server/roster-pathways-never-former.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	members,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
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
	await import("#/server/pathways-read-logic");

const TAG = randomUUID().slice(0, 8);
const createdPathIds: string[] = [];

async function enroll(personId: string, courseCode: string) {
	const [path] = await testDb
		.insert(pathwaysPaths)
		.values({ courseCode: `${courseCode}-${TAG}`, name: courseCode })
		.returning({ id: pathwaysPaths.id });
	if (!path) throw new Error("path insert failed");
	createdPathIds.push(path.id);
	const [enr] = await testDb
		.insert(pathEnrollments)
		.values({ personId, pathId: path.id })
		.returning({ id: pathEnrollments.id });
	if (!enr) throw new Error("enrollment insert failed");
	await testDb.insert(pathLevelProgress).values({
		enrollmentId: enr.id,
		level: 1,
		completed: 2,
		total: 5,
		approved: false,
	});
}

describe.skipIf(!hasTestDb)("Pathways and a member who left (#1342)", () => {
	let club: SeededClub;
	let inactiveId: string;
	let formerId: string;

	beforeAll(async () => {
		club = await seedClub();
		await enroll(club.personId, "ACTIVE");
		const inactivePersonId = await seedPerson({ name: "Ivy Inactive" });
		const formerPersonId = await seedPerson({ name: "Fern Former" });
		const [inactive, former] = await testDb
			.insert(members)
			.values([
				{
					clubId: club.clubId,
					personId: inactivePersonId,
					name: "Ivy Inactive",
					status: "inactive",
				},
				{
					clubId: club.clubId,
					personId: formerPersonId,
					name: "Fern Former",
					status: "former",
				},
			])
			.returning({ id: members.id });
		if (!inactive || !former) throw new Error("member insert failed");
		inactiveId = inactive.id;
		formerId = former.id;
		await enroll(inactivePersonId, "INACTIVE");
		await enroll(formerPersonId, "FORMER");
	});

	afterAll(async () => {
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

	const names = (paths: { pathName: string }[] | undefined) =>
		(paths ?? []).map((p) => p.pathName);

	it("pathwaysByMember with includeInactive returns the inactive member's paths and never the former member's", async () => {
		// protects=what `includeInactive` means; fails_when=the option goes back to dropping the status filter (the former member's path is returned), or narrows to active only (the inactive member's is lost); no_claim=none beyond protects
		const all = await pathwaysByMember(club.clubId, { includeInactive: true });
		expect(names(all.get(club.memberId))).toEqual(["ACTIVE"]);
		expect(names(all.get(inactiveId))).toEqual(["INACTIVE"]);
		expect(all.has(formerId)).toBe(false);
	});

	it("pathwaysByMember by default returns active members only", async () => {
		const byDefault = await pathwaysByMember(club.clubId);
		expect([...byDefault.keys()]).toEqual([club.memberId]);
	});

	it("the roster payload for an admin who opts in carries the inactive member and not the former one", async () => {
		// protects=the opt-in path end to end: guard, then the loader; fails_when=the guard is fine but the loader carries the former member's paths again (the original payload leak); no_claim=who may opt in (roster-former-pathways.integration.test.ts)
		const paths = await listClubMemberPathwaysFor(club.adminUserId, {
			clubId: club.clubId,
			includeFormer: true,
		});
		expect(names(paths[club.memberId])).toEqual(["ACTIVE"]);
		expect(names(paths[inactiveId])).toEqual(["INACTIVE"]);
		expect(paths).not.toHaveProperty(formerId);
	});

	it("the roster payload without the opt-in carries active members only", async () => {
		const paths = await listClubMemberPathwaysFor(club.adminUserId, {
			clubId: club.clubId,
		});
		expect(Object.keys(paths)).toEqual([club.memberId]);
	});

	it("a former member's Pathways stay on their profile, for an admin", async () => {
		// protects=the other half of the decision: the paths leave the roster payload, not the product; fails_when=the profile's gate is tightened to also refuse an admin; no_claim=who else may read it (roster-former-pathways.integration.test.ts)
		expect(
			names(await pathwaysForMember(club.clubId, formerId, club.adminUserId)),
		).toEqual(["FORMER"]);
		expect(
			await pathwaysForMember(club.clubId, formerId, club.memberUserId),
		).toEqual([]);
	});
});
