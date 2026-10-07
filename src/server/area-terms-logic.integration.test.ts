/**
 * The one "current" predicate (#1116): an Area Director's term is current only
 * while it is OPEN and its area's division is in the current program year.
 * #1118, #1119 and #1120 import `area-terms-logic.ts` and nothing else asks
 * the question, so these pin the three cases they depend on: open this year,
 * ended, and open in a past year (retired by the year check, never by an end).
 *
 * `#/db` is redirected to the test database; every row is deleted by id.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:…@localhost:5432/tm_test \
 *     bunx vitest run src/server/area-terms-logic.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { areaDirectors, areas, districts, divisions, user } from "#/db/schema";
import { currentProgramYear } from "#/lib/dcp";
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	isCurrentDivision,
	isCurrentTerm,
	loadCurrentAreasForUser,
	loadCurrentDirector,
} = await import("./area-terms-logic");

const YEAR = currentProgramYear();
const created = { districts: [] as string[], users: [] as string[] };

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
			await testDb.delete(areas).where(inArray(areas.id, areaIds));
		}
		if (divIds.length > 0) {
			await testDb.delete(divisions).where(inArray(divisions.id, divIds));
		}
		await testDb
			.delete(districts)
			.where(inArray(districts.id, created.districts));
	}
	if (created.users.length > 0) {
		await testDb.delete(user).where(inArray(user.id, created.users));
	}
	created.districts.length = 0;
	created.users.length = 0;
}

async function makeUser() {
	const id = randomUUID();
	await testDb.insert(user).values({
		id,
		name: "",
		email: `terms-${id}@test.example`,
		emailVerified: true,
	});
	created.users.push(id);
	return id;
}

/** One district for the test; `area()` adds a division + area in a given year. */
async function makeWorld() {
	const [district] = await testDb
		.insert(districts)
		.values({ number: `T${randomUUID().slice(0, 8)}` })
		.returning({ id: districts.id });
	if (!district) throw new Error("district");
	created.districts.push(district.id);
	return async function area(year: number, letter: string, number: string) {
		const [division] = await testDb
			.insert(divisions)
			.values({ districtId: district.id, programYear: year, letter })
			.returning({ id: divisions.id });
		const [row] = await testDb
			.insert(areas)
			.values({ divisionId: division?.id as string, number })
			.returning({ id: areas.id });
		return row?.id as string;
	};
}

async function openTerm(areaId: string, userId: string, name = "Jamie") {
	const [row] = await testDb
		.insert(areaDirectors)
		.values({ areaId, userId, displayName: name })
		.returning({ id: areaDirectors.id });
	return row?.id as string;
}

/** The predicate itself, evaluated by the database over every term of an area. */
async function currentTermIds(areaId: string, now?: Date) {
	const rows = await testDb
		.select({ id: areaDirectors.id })
		.from(areaDirectors)
		.innerJoin(areas, eq(areas.id, areaDirectors.areaId))
		.innerJoin(divisions, eq(divisions.id, areas.divisionId))
		.where(and(eq(areaDirectors.areaId, areaId), isCurrentTerm(now)));
	return rows.map((r) => r.id);
}

describe.skipIf(!hasTestDb)("area terms: what is current (#1116)", () => {
	afterEach(teardown);

	it("an open term on this year's area is current", async () => {
		const area = await makeWorld();
		const areaId = await area(YEAR, "B", "2");
		const userId = await makeUser();
		const termId = await openTerm(areaId, userId, "Jamie Rivera");

		expect(await currentTermIds(areaId)).toEqual([termId]);
		expect(await loadCurrentDirector(areaId)).toEqual({
			userId,
			displayName: "Jamie Rivera",
		});
		expect(await loadCurrentAreasForUser(userId)).toEqual([
			{ id: areaId, label: "B2" },
		]);
	});

	it("an ended term is not current", async () => {
		const area = await makeWorld();
		const areaId = await area(YEAR, "B", "2");
		const userId = await makeUser();
		const termId = await openTerm(areaId, userId);
		await testDb
			.update(areaDirectors)
			.set({ endedAt: sql`now()` })
			.where(eq(areaDirectors.id, termId));

		expect(await currentTermIds(areaId)).toEqual([]);
		expect(await loadCurrentDirector(areaId)).toBeNull();
		expect(await loadCurrentAreasForUser(userId)).toEqual([]);
	});

	it("an open term on last year's area is not current, and was never ended", async () => {
		const area = await makeWorld();
		const lastYear = await area(YEAR - 1, "B", "2");
		const nextYear = await area(YEAR + 1, "B", "2");
		const userId = await makeUser();
		const lastTerm = await openTerm(lastYear, userId);
		await openTerm(nextYear, userId);

		expect(await currentTermIds(lastYear)).toEqual([]);
		expect(await loadCurrentDirector(lastYear)).toBeNull();
		// Next year's staffing, done ahead in June, is not current yet either.
		expect(await currentTermIds(nextYear)).toEqual([]);
		expect(await loadCurrentAreasForUser(userId)).toEqual([]);
		const [row] = await testDb
			.select({ endedAt: areaDirectors.endedAt })
			.from(areaDirectors)
			.where(eq(areaDirectors.id, lastTerm));
		expect(row?.endedAt).toBeNull();
	});

	it("July 1 retires a term and starts the next year's with no write", async () => {
		const area = await makeWorld();
		const thisYear = await area(YEAR, "B", "2");
		const nextYear = await area(YEAR + 1, "B", "2");
		const userId = await makeUser();
		await openTerm(thisYear, userId);
		const nextTerm = await openTerm(nextYear, userId, "Next year");

		const afterJuly = new Date(YEAR + 1, 6, 1, 12);
		expect(await currentTermIds(thisYear, afterJuly)).toEqual([]);
		expect(await currentTermIds(nextYear, afterJuly)).toEqual([nextTerm]);
		expect(await loadCurrentDirector(thisYear, afterJuly)).toBeNull();
		expect(await loadCurrentDirector(nextYear, afterJuly)).toEqual({
			userId,
			displayName: "Next year",
		});
		expect(await loadCurrentAreasForUser(userId, afterJuly)).toEqual([
			{ id: nextYear, label: "B2" },
		]);
	});

	it("lists a user's current areas sorted by label, not by insertion order", async () => {
		const area = await makeWorld();
		const c3 = await area(YEAR, "C", "3");
		const b10 = await area(YEAR, "B", "10");
		const b2 = await area(YEAR, "A", "9");
		const userId = await makeUser();
		for (const areaId of [c3, b10, b2]) await openTerm(areaId, userId);

		expect((await loadCurrentAreasForUser(userId)).map((a) => a.label)).toEqual(
			["A9", "B10", "C3"],
		);
	});

	it("isCurrentDivision matches the division's own program year only", async () => {
		const area = await makeWorld();
		await area(YEAR, "B", "2");
		await area(YEAR + 1, "C", "2");
		const rows = await testDb
			.select({ year: divisions.programYear })
			.from(divisions)
			.where(
				and(
					inArray(divisions.districtId, created.districts),
					isCurrentDivision(),
				),
			);
		expect(rows).toEqual([{ year: YEAR }]);
	});
});
