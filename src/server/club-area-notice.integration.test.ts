/**
 * What a club's admins are told about their Area Director (#1118): the area the
 * club sits in THIS program year and its current director.
 *
 * The notice and #1119's access guard must agree about one person on one day,
 * so the cases here are the ones where "open", "ended" and "this year" come
 * apart:
 *
 *   - in an area with a current director       → names the director
 *   - in an area with no term at all           → "not assigned yet" (null name)
 *   - in an area whose only term has ENDED     → "not assigned yet"
 *   - in no area, or only LAST year's area     → no notice at all
 *   - in this year's area, but the open term is on LAST year's area
 *                                              → "not assigned yet": an open
 *                                                term is not a current one
 *
 * `#/db` is redirected to the test database; every row is deleted by id.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:…@localhost:5432/tm_test \
 *     bunx vitest run src/server/club-area-notice.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	areaClubs,
	areaDirectors,
	areas,
	clubs,
	districts,
	divisions,
	user,
} from "#/db/schema";
import { currentProgramYear } from "#/lib/dcp";
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadClubAreaNoticeDb } = await import("./club-area-notice-logic");

const YEAR = currentProgramYear();
const created = {
	districts: [] as string[],
	clubs: [] as string[],
	users: [] as string[],
};

async function teardown() {
	if (created.districts.length > 0) {
		const divs = await testDb
			.select({ id: divisions.id })
			.from(divisions)
			.where(inArray(divisions.districtId, created.districts));
		const divIds = divs.map((d) => d.id);
		const ars = divIds.length
			? await testDb
					.select({ id: areas.id })
					.from(areas)
					.where(inArray(areas.divisionId, divIds))
			: [];
		const areaIds = ars.map((a) => a.id);
		if (areaIds.length > 0) {
			await testDb
				.delete(areaDirectors)
				.where(inArray(areaDirectors.areaId, areaIds));
			await testDb.delete(areaClubs).where(inArray(areaClubs.areaId, areaIds));
			await testDb.delete(areas).where(inArray(areas.id, areaIds));
		}
		if (divIds.length > 0) {
			await testDb.delete(divisions).where(inArray(divisions.id, divIds));
		}
		await testDb
			.delete(districts)
			.where(inArray(districts.id, created.districts));
	}
	if (created.clubs.length > 0) {
		await testDb.delete(clubs).where(inArray(clubs.id, created.clubs));
	}
	if (created.users.length > 0) {
		await testDb.delete(user).where(inArray(user.id, created.users));
	}
	created.districts.length = 0;
	created.clubs.length = 0;
	created.users.length = 0;
}

async function makeUser() {
	const id = randomUUID();
	await testDb.insert(user).values({
		id,
		name: "",
		email: `area-notice-${id}@test.example`,
		emailVerified: true,
	});
	created.users.push(id);
	return id;
}

async function makeClub() {
	const id = randomUUID();
	await testDb.insert(clubs).values({
		id,
		name: `Notice Club ${id.slice(0, 8)}`,
		slug: `notice-${id}`,
	});
	created.clubs.push(id);
	return id;
}

/** One district for the test; `area()` adds a division + area in a given year. */
async function makeWorld() {
	const number = `N${randomUUID().slice(0, 8)}`;
	const [district] = await testDb
		.insert(districts)
		.values({ number })
		.returning({ id: districts.id });
	if (!district) throw new Error("district");
	created.districts.push(district.id);
	const area = async (year: number, letter: string, areaNumber: string) => {
		const [division] = await testDb
			.insert(divisions)
			.values({ districtId: district.id, programYear: year, letter })
			.returning({ id: divisions.id });
		const [row] = await testDb
			.insert(areas)
			.values({ divisionId: division?.id as string, number: areaNumber })
			.returning({ id: areas.id });
		return row?.id as string;
	};
	return { districtNumber: number, area };
}

async function place(areaId: string, clubId: string) {
	await testDb.insert(areaClubs).values({ areaId, clubId, name: "Placed" });
}

async function openTerm(areaId: string, userId: string, displayName: string) {
	await testDb.insert(areaDirectors).values({ areaId, userId, displayName });
}

async function endedTerm(areaId: string, userId: string, displayName: string) {
	await testDb.insert(areaDirectors).values({
		areaId,
		userId,
		displayName,
		startedAt: new Date("2020-01-01T00:00:00Z"),
		endedAt: new Date("2020-06-01T00:00:00Z"),
	});
}

describe.skipIf(!hasTestDb)("club area notice (#1118)", () => {
	afterEach(teardown);

	it("names the director, area, division and district of a club in an area with a current director", async () => {
		const world = await makeWorld();
		const clubId = await makeClub();
		const areaId = await world.area(YEAR, "C", "3");
		await place(areaId, clubId);
		await openTerm(areaId, await makeUser(), "Jamie Rivera");

		expect(await loadClubAreaNoticeDb(clubId)).toEqual({
			areaLabel: "C3",
			divisionLetter: "C",
			districtNumber: world.districtNumber,
			directorName: "Jamie Rivera",
		});
	});

	it("returns a null director for a club in an area that has none yet", async () => {
		const world = await makeWorld();
		const clubId = await makeClub();
		const areaId = await world.area(YEAR, "B", "2");
		await place(areaId, clubId);

		expect(await loadClubAreaNoticeDb(clubId)).toEqual({
			areaLabel: "B2",
			divisionLetter: "B",
			districtNumber: world.districtNumber,
			directorName: null,
		});
	});

	it("returns a null director when the area's only term has ended", async () => {
		const world = await makeWorld();
		const clubId = await makeClub();
		const areaId = await world.area(YEAR, "B", "2");
		await place(areaId, clubId);
		await endedTerm(areaId, await makeUser(), "Former Director");

		const notice = await loadClubAreaNoticeDb(clubId);
		expect(notice?.areaLabel).toBe("B2");
		expect(notice?.directorName).toBeNull();
	});

	it("returns null for a club in no area, and for one placed only in last year's", async () => {
		const world = await makeWorld();
		const unplaced = await makeClub();
		expect(await loadClubAreaNoticeDb(unplaced)).toBeNull();

		const lastYearOnly = await makeClub();
		const lastYear = await world.area(YEAR - 1, "B", "2");
		await place(lastYear, lastYearOnly);
		// Even with a director holding last year's area open: nobody is current.
		await openTerm(lastYear, await makeUser(), "Last Year's Director");
		expect(await loadClubAreaNoticeDb(lastYearOnly)).toBeNull();
	});

	it("does not take an open term on last year's area for the current one", async () => {
		const world = await makeWorld();
		const clubId = await makeClub();
		const lastYear = await world.area(YEAR - 1, "B", "2");
		const thisYear = await world.area(YEAR, "C", "3");
		await place(lastYear, clubId);
		await place(thisYear, clubId);
		// The term is open but sits on last year's area, and this year's area has
		// none: the notice shows THIS year's area with no director.
		await openTerm(lastYear, await makeUser(), "Last Year's Director");

		expect(await loadClubAreaNoticeDb(clubId)).toEqual({
			areaLabel: "C3",
			divisionLetter: "C",
			districtNumber: world.districtNumber,
			directorName: null,
		});
	});

	it("reads 'current' off the clock it is given, for the area and the term alike", async () => {
		const world = await makeWorld();
		const clubId = await makeClub();
		const thisYear = await world.area(YEAR, "C", "3");
		const nextYearArea = await world.area(YEAR + 1, "D", "4");
		await place(thisYear, clubId);
		await place(nextYearArea, clubId);
		// Both years' terms are OPEN and neither is ever ended: only the year
		// check says which is current, so the clock has to reach both the area
		// lookup and the director lookup.
		await openTerm(thisYear, await makeUser(), "This Year's Director");
		await openTerm(nextYearArea, await makeUser(), "Next Year's Director");

		const sameDay = await loadClubAreaNoticeDb(clubId);
		expect(sameDay?.areaLabel).toBe("C3");
		expect(sameDay?.directorName).toBe("This Year's Director");

		// July 15 of the next program year, in local time like `programYearForDate`.
		const nextYear = await loadClubAreaNoticeDb(
			clubId,
			new Date(YEAR + 1, 6, 15),
		);
		expect(nextYear?.areaLabel).toBe("D4");
		expect(nextYear?.directorName).toBe("Next Year's Director");

		// And two years on, nothing is current: no area, so no notice.
		expect(
			await loadClubAreaNoticeDb(clubId, new Date(YEAR + 2, 6, 15)),
		).toBeNull();
	});
});
