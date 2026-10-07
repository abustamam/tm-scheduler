/**
 * DB-backed tests for the area hierarchy (#1116): the district → division →
 * area chain, the one-area-per-club-per-program-year rule, the one-open-term
 * rule, what a visit and a permanent club delete do to an area club, and the
 * verified-email director lookup. `#/db` is redirected to the test database.
 *
 * Every row carries a per-run suffix and is deleted by id afterwards: vitest
 * runs files in parallel against one shared database.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:…@localhost:5432/tm_test \
 *     bunx vitest run src/server/areas-logic.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	areaClubs,
	areaDirectors,
	areas,
	clubs,
	clubVisits,
	districts,
	divisions,
	members,
	people,
	user,
} from "#/db/schema";
import { CLUB_HAS_VISITS_MESSAGE } from "#/lib/area-limits";
import { currentProgramYear, programYearLabel } from "#/lib/dcp";
import { hasTestDb, openBlockingTx, testDb, waitForLockWait } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	addAreaClub,
	alreadyPlacedMessage,
	assignAreaDirector,
	assignAreaDirectorSchema,
	createArea,
	createDistrict,
	createDivision,
	endAreaDirectorTerm,
	findUserForDirector,
	getConsoleArea,
	linkAreaClub,
	listConsoleAreas,
	removeAreaClub,
	renameArea,
	renameDivision,
	ALREADY_IN_THIS_AREA_MESSAGE,
	ALREADY_LINKED_MESSAGE,
	ARCHIVED_CLUB_MESSAGE,
	ASSIGN_FAILED_MESSAGE,
	ASSIGN_TARGET_GONE_MESSAGE,
	assignDirectorFailure,
	CLUB_NUMBER_CHANGED_MESSAGE,
	CURRENT_TERM_EXISTS_MESSAGE,
	DIRECTOR_NOT_VERIFIED_MESSAGE,
	DISPLAY_NAME_REQUIRED_MESSAGE,
	NO_CURRENT_TERM_MESSAGE,
	pastYearAreaMessage,
} = await import("./areas-logic");
const { deleteClubPermanently } = await import("./onboarding-logic");

const YEAR = currentProgramYear();
const created = {
	districts: [] as string[],
	clubs: [] as string[],
	people: [] as string[],
	users: [] as string[],
};

async function teardown() {
	if (created.districts.length > 0) {
		const divs = await testDb
			.select({ id: divisions.id })
			.from(divisions)
			.where(inArray(divisions.districtId, created.districts));
		const ars = divs.length
			? await testDb
					.select({ id: areas.id })
					.from(areas)
					.where(
						inArray(
							areas.divisionId,
							divs.map((d) => d.id),
						),
					)
			: [];
		const areaIds = ars.map((a) => a.id);
		if (areaIds.length > 0) {
			const acs = await testDb
				.select({ id: areaClubs.id })
				.from(areaClubs)
				.where(inArray(areaClubs.areaId, areaIds));
			if (acs.length > 0) {
				await testDb.delete(clubVisits).where(
					inArray(
						clubVisits.areaClubId,
						acs.map((a) => a.id),
					),
				);
			}
			await testDb
				.delete(areaDirectors)
				.where(inArray(areaDirectors.areaId, areaIds));
			await testDb.delete(areaClubs).where(inArray(areaClubs.areaId, areaIds));
			await testDb.delete(areas).where(inArray(areas.id, areaIds));
		}
		if (divs.length > 0) {
			await testDb.delete(divisions).where(
				inArray(
					divisions.id,
					divs.map((d) => d.id),
				),
			);
		}
		await testDb
			.delete(districts)
			.where(inArray(districts.id, created.districts));
	}
	if (created.clubs.length > 0) {
		await testDb.delete(clubs).where(inArray(clubs.id, created.clubs));
	}
	if (created.people.length > 0) {
		await testDb.delete(people).where(inArray(people.id, created.people));
	}
	if (created.users.length > 0) {
		await testDb.delete(user).where(inArray(user.id, created.users));
	}
	for (const k of Object.keys(created) as (keyof typeof created)[]) {
		created[k].length = 0;
	}
}

const run = () => randomUUID().slice(0, 8);

async function makeDistrict() {
	const { id } = await createDistrict({ number: `T${run()}` });
	created.districts.push(id);
	return id;
}

/** A district with one division in `year` and one area in it. */
async function makeChain(opts?: {
	districtId?: string;
	year?: number;
	letter?: string;
	number?: string;
}) {
	const districtId = opts?.districtId ?? (await makeDistrict());
	const year = opts?.year ?? YEAR;
	const letter = opts?.letter ?? "B";
	// A past year is refused by `createDivision`, so history is inserted directly.
	const divisionId =
		year === YEAR || year === YEAR + 1
			? (await createDivision({ districtId, programYear: year, letter })).id
			: (
					await testDb
						.insert(divisions)
						.values({ districtId, programYear: year, letter })
						.returning({ id: divisions.id })
				)[0]?.id;
	if (!divisionId) throw new Error("division");
	const { id: areaId } = await createArea({
		divisionId,
		number: opts?.number ?? "2",
	});
	return { districtId, divisionId, areaId };
}

async function makeClub(opts?: { archived?: boolean; clubNumber?: string }) {
	const id = randomUUID();
	await testDb.insert(clubs).values({
		id,
		name: `Area Club ${run()}`,
		slug: `areas-1116-${id}`,
		clubNumber: opts?.clubNumber ?? null,
		archivedAt: opts?.archived ? new Date() : null,
	});
	created.clubs.push(id);
	return id;
}

/** A club number nothing else in the shared test database is likely to hold. */
const uniqueClubNumber = () =>
	String(Math.floor(10_000_000 + Math.random() * 89_999_999));

async function makeUser(opts?: { verified?: boolean; email?: string }) {
	const id = randomUUID();
	const email = opts?.email ?? `ad-${id}@test.example`;
	await testDb.insert(user).values({
		id,
		name: "",
		email,
		emailVerified: opts?.verified ?? true,
	});
	created.users.push(id);
	return { id, email };
}

async function clubRow(areaClubId: string) {
	const [row] = await testDb
		.select()
		.from(areaClubs)
		.where(eq(areaClubs.id, areaClubId));
	return row;
}

/** An open term inserted directly: `assignAreaDirector` refuses a past year. */
async function insertOpenTerm(areaId: string, userId: string, name = "Jamie") {
	const [row] = await testDb
		.insert(areaDirectors)
		.values({ areaId, userId, displayName: name })
		.returning({ id: areaDirectors.id });
	if (!row) throw new Error("term");
	return row.id;
}

/** Put `userId`'s account in `clubId`: a Person bound to it and an active member. */
async function joinClub(clubId: string, userId: string) {
	const [person] = await testDb
		.insert(people)
		.values({ name: "P", userId })
		.returning({ id: people.id });
	if (!person) throw new Error("person");
	created.people.push(person.id);
	await testDb.insert(members).values({
		clubId,
		personId: person.id,
		name: "M",
		clubRole: "member",
		status: "active",
	});
}

/** A transaction that holds a SHARE lock on a club row and has placed it in
 *  `areaId`, uncommitted. FOR SHARE, not FOR UPDATE: a placement that only
 *  takes a SHARE lock itself would not wait for it, so this is what proves the
 *  placement's lock is an UPDATE lock. */
function holdClubPlaced(clubId: string, areaId: string) {
	return openBlockingTx(async (tx) => {
		await tx
			.select({ id: clubs.id })
			.from(clubs)
			.where(eq(clubs.id, clubId))
			.for("share");
		await tx
			.insert(areaClubs)
			.values({ areaId, clubId, name: "Held by a concurrent placement" });
	});
}

async function insertVisit(areaClubId: string) {
	const [row] = await testDb
		.insert(clubVisits)
		.values({ areaClubId, round: 1, visitedOn: "2026-10-01" })
		.returning({ id: clubVisits.id });
	if (!row) throw new Error("visit");
	return row.id;
}

describe.skipIf(!hasTestDb)("area hierarchy (#1116)", () => {
	afterEach(teardown);

	it("builds the chain and lists it newest year first, with club and director counts", async () => {
		const districtId = await makeDistrict();
		const thisYear = await makeChain({ districtId, year: YEAR, letter: "C" });
		const nextYear = await makeChain({
			districtId,
			year: YEAR + 1,
			letter: "A",
		});
		await createArea({ divisionId: thisYear.divisionId, number: "10" });
		await createArea({ divisionId: thisYear.divisionId, number: "3" });
		const club = await makeClub();
		await addAreaClub({ areaId: thisYear.areaId, clubId: club });
		await addAreaClub({ areaId: thisYear.areaId, name: "Elsewhere TM" });
		const director = await makeUser();
		await assignAreaDirector(
			{
				areaId: thisYear.areaId,
				userId: director.id,
				displayName: "Jamie Rivera",
			},
			director.id,
		);

		const list = await listConsoleAreas();
		const district = list.districts.find((d) => d.id === districtId);
		expect(list.currentProgramYear).toBe(YEAR);
		expect(district?.divisions.map((d) => [d.programYear, d.letter])).toEqual([
			[YEAR + 1, "A"],
			[YEAR, "C"],
		]);
		const division = district?.divisions.find(
			(d) => d.id === thisYear.divisionId,
		);
		// "2" < "3" < "10": numeric order, not string order.
		expect(division?.areas.map((a) => a.label)).toEqual(["C2", "C3", "C10"]);
		expect(division?.areas[0]).toMatchObject({
			id: thisYear.areaId,
			clubCount: 2,
			directorCount: 1,
			directorState: "current",
		});
		expect(division?.areas[1]).toMatchObject({
			clubCount: 0,
			directorCount: 0,
			directorState: null,
		});
		expect(
			district?.divisions.find((d) => d.id === nextYear.divisionId)?.areas[0],
		).toMatchObject({ clubCount: 0, directorCount: 0 });
	});

	it("refuses a division outside this program year and the next", async () => {
		const districtId = await makeDistrict();
		const now = new Date(YEAR, 9, 1);
		await expect(
			createDivision({ districtId, programYear: YEAR - 1, letter: "A" }, now),
		).rejects.toThrow(
			`A division's program year must be ${programYearLabel(YEAR)} or ${programYearLabel(YEAR + 1)}`,
		);
		await expect(
			createDivision({ districtId, programYear: YEAR + 2, letter: "A" }, now),
		).rejects.toThrow(/program year must be/);
		await expect(
			createDivision({
				districtId: randomUUID(),
				programYear: YEAR,
				letter: "A",
			}),
		).rejects.toThrow("District not found");
		await expect(
			createArea({ divisionId: randomUUID(), number: "1" }),
		).rejects.toThrow("Division not found");
	});

	it("refuses a duplicate district number, division letter or area number, and renames within them", async () => {
		const number = `T${run()}`;
		const { id: districtId } = await createDistrict({ number });
		created.districts.push(districtId);
		await expect(createDistrict({ number })).rejects.toThrow(
			`District ${number} already exists`,
		);

		const { divisionId, areaId } = await makeChain({
			districtId,
			letter: "B",
			number: "2",
		});
		await expect(
			createDivision({ districtId, programYear: YEAR, letter: "B" }),
		).rejects.toThrow(`Division B already exists in District ${number}`);
		// The same letter in the next year is a different division.
		await createDivision({ districtId, programYear: YEAR + 1, letter: "B" });
		await expect(createArea({ divisionId, number: "2" })).rejects.toThrow(
			`Area B2 already exists for ${programYearLabel(YEAR)}`,
		);

		const { id: otherArea } = await createArea({ divisionId, number: "3" });
		await expect(
			renameArea({ areaId: otherArea, number: "2" }),
		).rejects.toThrow("Area B2 already exists");
		await renameArea({ areaId: otherArea, number: "4" });
		await renameArea({ areaId, number: "9" });
		await expect(
			renameArea({ areaId: randomUUID(), number: "1" }),
		).rejects.toThrow("Area not found");

		const { id: otherDivision } = await createDivision({
			districtId,
			programYear: YEAR,
			letter: "C",
		});
		await expect(
			renameDivision({ divisionId: otherDivision, letter: "B" }),
		).rejects.toThrow(`Division B already exists in District ${number}`);
		await renameDivision({ divisionId: otherDivision, letter: "D" });
		await expect(
			renameDivision({ divisionId: randomUUID(), letter: "E" }),
		).rejects.toThrow("Division not found");

		const area = await getConsoleArea(areaId);
		expect(area.label).toBe("B9");
	});

	it("places a club once per program year and allows it in two different years", async () => {
		const districtId = await makeDistrict();
		const b2 = await makeChain({ districtId, letter: "B", number: "2" });
		const c3 = await makeChain({ districtId, letter: "C", number: "3" });
		const nextYear = await makeChain({
			districtId,
			year: YEAR + 1,
			letter: "B",
			number: "2",
		});
		const club = await makeClub();

		await addAreaClub({ areaId: b2.areaId, clubId: club });
		await expect(
			addAreaClub({ areaId: c3.areaId, clubId: club }),
		).rejects.toThrow(alreadyPlacedMessage("B2", YEAR));
		await expect(
			addAreaClub({ areaId: b2.areaId, clubId: club }),
		).rejects.toThrow(ALREADY_IN_THIS_AREA_MESSAGE);
		// A different year is a different placement.
		await addAreaClub({ areaId: nextYear.areaId, clubId: club });

		const placed = await testDb
			.select({ id: areaClubs.id })
			.from(areaClubs)
			.where(eq(areaClubs.clubId, club));
		expect(placed).toHaveLength(2);
		expect(alreadyPlacedMessage("B2", 2026)).toBe(
			"This club is already in Area B2 for 2026–27",
		);
	});

	it("makes a second placement of one club wait for the first, then refuses it", async () => {
		const districtId = await makeDistrict();
		const first = await makeChain({ districtId, letter: "B", number: "2" });
		const second = await makeChain({ districtId, letter: "C", number: "3" });
		const club = await makeClub();

		// A concurrent placement that has locked the club and inserted its row but
		// not committed: invisible to the second placement's check, so only the
		// lock stands between them. Without it the second reads "not placed" and
		// inserts, and one club sits in two areas of one year. The writer holds a
		// SHARE lock, so a placement that merely took a SHARE lock of its own would
		// not wait and would fail this.
		const concurrent = await holdClubPlaced(club, first.areaId);
		let committed = false;
		try {
			const outcome = addAreaClub({ areaId: second.areaId, clubId: club }).then(
				() => "placed",
				(err: unknown) => (err instanceof Error ? err.message : String(err)),
			);
			// Parked on the club's row lock, behind THIS writer.
			await waitForLockWait('from "clubs"', concurrent.pid);
			await concurrent.commit();
			committed = true;
			expect(await outcome).toBe(alreadyPlacedMessage("B2", YEAR));
		} finally {
			if (!committed) await concurrent.commit();
		}

		const placed = await testDb
			.select({ areaId: areaClubs.areaId })
			.from(areaClubs)
			.where(eq(areaClubs.clubId, club));
		expect(placed).toEqual([{ areaId: first.areaId }]);
	});

	it("refuses an archived club, when added and when linked", async () => {
		const { areaId } = await makeChain();
		const archived = await makeClub({ archived: true });
		await expect(addAreaClub({ areaId, clubId: archived })).rejects.toThrow(
			ARCHIVED_CLUB_MESSAGE,
		);

		const clubNumber = uniqueClubNumber();
		const archivedNumbered = await makeClub({ archived: true, clubNumber });
		const { id: rowId } = await addAreaClub({
			areaId,
			name: "Typed By Hand",
			clubNumber,
		});
		await expect(linkAreaClub({ areaClubId: rowId })).rejects.toThrow(
			ARCHIVED_CLUB_MESSAGE,
		);
		expect((await clubRow(rowId))?.clubId).toBeNull();
		const placed = await testDb
			.select({ id: areaClubs.id })
			.from(areaClubs)
			.where(eq(areaClubs.clubId, archivedNumbered));
		expect(placed).toHaveLength(0);
	});

	it("refuses a name-only row typed with the number of a club already placed this year", async () => {
		const districtId = await makeDistrict();
		const b2 = await makeChain({ districtId, letter: "B", number: "2" });
		const c3 = await makeChain({ districtId, letter: "C", number: "3" });
		const nextYear = await makeChain({
			districtId,
			year: YEAR + 1,
			letter: "B",
			number: "2",
		});
		const clubNumber = uniqueClubNumber();
		const club = await makeClub({ clubNumber });
		await addAreaClub({ areaId: b2.areaId, clubId: club });

		// The same club under another spelling, in another area, and in the same one.
		await expect(
			addAreaClub({
				areaId: c3.areaId,
				name: "Spelled Differently",
				clubNumber,
			}),
		).rejects.toThrow(alreadyPlacedMessage("B2", YEAR));
		await expect(
			addAreaClub({
				areaId: b2.areaId,
				name: "Spelled Differently",
				clubNumber,
			}),
		).rejects.toThrow(ALREADY_IN_THIS_AREA_MESSAGE);
		const rows = await testDb
			.select({ id: areaClubs.id })
			.from(areaClubs)
			.where(inArray(areaClubs.areaId, [b2.areaId, c3.areaId]));
		expect(rows).toHaveLength(1);

		// Next year the club is free, so the same typed row is fine there.
		const { id: nextRow } = await addAreaClub({
			areaId: nextYear.areaId,
			name: "Spelled Differently",
			clubNumber,
		});
		expect((await clubRow(nextRow))?.clubId).toBeNull();
		// A number no GavelUp club carries, and an archived club's unplaced number,
		// are plain name-only rows.
		await addAreaClub({
			areaId: c3.areaId,
			name: "Not on GavelUp",
			clubNumber: uniqueClubNumber(),
		});
		const archivedNumber = uniqueClubNumber();
		await makeClub({ archived: true, clubNumber: archivedNumber });
		await addAreaClub({
			areaId: c3.areaId,
			name: "Was on GavelUp",
			clubNumber: archivedNumber,
		});
	});

	it("makes a name-only row wait for a concurrent placement of the club it names", async () => {
		const districtId = await makeDistrict();
		const first = await makeChain({ districtId, letter: "B", number: "2" });
		const second = await makeChain({ districtId, letter: "C", number: "3" });
		const clubNumber = uniqueClubNumber();
		const club = await makeClub({ clubNumber });

		const concurrent = await holdClubPlaced(club, first.areaId);
		let committed = false;
		try {
			const outcome = addAreaClub({
				areaId: second.areaId,
				name: "Spelled Differently",
				clubNumber,
			}).then(
				() => "placed",
				(err: unknown) => (err instanceof Error ? err.message : String(err)),
			);
			await waitForLockWait('from "clubs"', concurrent.pid);
			await concurrent.commit();
			committed = true;
			expect(await outcome).toBe(alreadyPlacedMessage("B2", YEAR));
		} finally {
			if (!committed) await concurrent.commit();
		}
		const rows = await testDb
			.select({ id: areaClubs.id })
			.from(areaClubs)
			.where(eq(areaClubs.areaId, second.areaId));
		expect(rows).toHaveLength(0);
	});

	it("makes a link wait for a concurrent placement of the club, then refuses it", async () => {
		const districtId = await makeDistrict();
		const first = await makeChain({ districtId, letter: "B", number: "2" });
		const second = await makeChain({ districtId, letter: "C", number: "3" });
		const clubNumber = uniqueClubNumber();
		const club = await makeClub({ clubNumber });
		const { id: rowId } = await addAreaClub({
			areaId: second.areaId,
			name: "Typed By Hand",
			clubNumber,
		});

		const concurrent = await holdClubPlaced(club, first.areaId);
		let committed = false;
		try {
			const outcome = linkAreaClub({ areaClubId: rowId }).then(
				() => "linked",
				(err: unknown) => (err instanceof Error ? err.message : String(err)),
			);
			await waitForLockWait('from "clubs"', concurrent.pid);
			await concurrent.commit();
			committed = true;
			expect(await outcome).toBe(alreadyPlacedMessage("B2", YEAR));
		} finally {
			if (!committed) await concurrent.commit();
		}
		expect((await clubRow(rowId))?.clubId).toBeNull();
	});

	it("refuses a link when the club's number changed while it waited for the lock", async () => {
		const { areaId } = await makeChain();
		const clubNumber = uniqueClubNumber();
		const club = await makeClub({ clubNumber });
		const { id: rowId } = await addAreaClub({
			areaId,
			name: "Typed By Hand",
			clubNumber,
		});

		// The club is renumbered by a writer that has not committed: the link finds
		// the club by the OLD number, then waits for the lock, then must not link a
		// club that no longer carries it.
		const renumber = await openBlockingTx(async (tx) => {
			await tx
				.update(clubs)
				.set({ clubNumber: uniqueClubNumber() })
				.where(eq(clubs.id, club));
		});
		let committed = false;
		try {
			const outcome = linkAreaClub({ areaClubId: rowId }).then(
				() => "linked",
				(err: unknown) => (err instanceof Error ? err.message : String(err)),
			);
			await waitForLockWait('from "clubs"', renumber.pid);
			await renumber.commit();
			committed = true;
			expect(await outcome).toBe(CLUB_NUMBER_CHANGED_MESSAGE);
		} finally {
			if (!committed) await renumber.commit();
		}
		expect((await clubRow(rowId))?.clubId).toBeNull();
	});

	it("refuses removing an area club that has a visit, in the logic and in the database", async () => {
		const { areaId } = await makeChain();
		const club = await makeClub();
		const { id: areaClubId } = await addAreaClub({ areaId, clubId: club });
		const visitId = await insertVisit(areaClubId);

		await expect(removeAreaClub({ areaClubId })).rejects.toThrow(
			CLUB_HAS_VISITS_MESSAGE,
		);
		expect(await clubRow(areaClubId)).toBeDefined();
		const [visit] = await testDb
			.select({ id: clubVisits.id })
			.from(clubVisits)
			.where(eq(clubVisits.id, visitId));
		expect(visit).toBeDefined();

		// The database refuses it on its own: RESTRICT, not the console's check.
		await expect(
			testDb.delete(areaClubs).where(eq(areaClubs.id, areaClubId)),
		).rejects.toMatchObject({ cause: { code: "23503" } });
		expect(await clubRow(areaClubId)).toBeDefined();

		// A row with no visit goes.
		const { id: bare } = await addAreaClub({ areaId, name: "No visits TM" });
		await removeAreaClub({ areaClubId: bare });
		expect(await clubRow(bare)).toBeUndefined();
		await expect(removeAreaClub({ areaClubId: bare })).rejects.toThrow(
			"Club not found in this area",
		);
	});

	it("links a name-only row to the GavelUp club with the same club number", async () => {
		const districtId = await makeDistrict();
		const b2 = await makeChain({ districtId, letter: "B", number: "2" });
		const c3 = await makeChain({ districtId, letter: "C", number: "3" });
		const clubNumber = uniqueClubNumber();
		const club = await makeClub({ clubNumber });
		const clubName = (
			await testDb
				.select({ name: clubs.name })
				.from(clubs)
				.where(eq(clubs.id, club))
		)[0]?.name;

		const { id: matching } = await addAreaClub({
			areaId: b2.areaId,
			name: "Typed by hand",
			clubNumber,
		});
		const { id: unmatched } = await addAreaClub({
			areaId: b2.areaId,
			name: "Nobody has this number",
			clubNumber: uniqueClubNumber(),
		});
		const { id: unnumbered } = await addAreaClub({
			areaId: b2.areaId,
			name: "No number at all",
		});

		// The page is told which club to offer, and for which rows.
		const before = await getConsoleArea(b2.areaId);
		const byId = new Map(before.clubs.map((c) => [c.id, c]));
		expect(byId.get(matching)?.linkOffer).toEqual({
			clubId: club,
			name: clubName,
		});
		expect(byId.get(unmatched)?.linkOffer).toBeNull();
		expect(byId.get(unnumbered)?.linkOffer).toBeNull();

		await expect(linkAreaClub({ areaClubId: unmatched })).rejects.toThrow(
			/No GavelUp club has club number/,
		);
		await expect(linkAreaClub({ areaClubId: unnumbered })).rejects.toThrow(
			"This club has no club number to match",
		);

		await linkAreaClub({ areaClubId: matching });
		const row = await clubRow(matching);
		expect(row).toMatchObject({ clubId: club, name: clubName, clubNumber });
		await expect(linkAreaClub({ areaClubId: matching })).rejects.toThrow(
			ALREADY_LINKED_MESSAGE,
		);
		await expect(linkAreaClub({ areaClubId: randomUUID() })).rejects.toThrow(
			"Club not found in this area",
		);

		// The one-area-per-year rule holds for a link as much as for an add. Adding
		// the second row is itself refused now, so lay it down by hand.
		const [elsewhereRow] = await testDb
			.insert(areaClubs)
			.values({
				areaId: c3.areaId,
				name: "Same club, other area",
				clubNumber,
			})
			.returning({ id: areaClubs.id });
		const elsewhere = elsewhereRow?.id as string;
		await expect(linkAreaClub({ areaClubId: elsewhere })).rejects.toThrow(
			alreadyPlacedMessage("B2", YEAR),
		);
		expect((await clubRow(elsewhere))?.clubId).toBeNull();

		const after = await getConsoleArea(b2.areaId);
		expect(after.clubs.find((c) => c.id === matching)?.linkOffer).toBeNull();
	});

	it("offers only live clubs that are in no area of this program year", async () => {
		const districtId = await makeDistrict();
		const b2 = await makeChain({ districtId, letter: "B", number: "2" });
		const nextYear = await makeChain({
			districtId,
			year: YEAR + 1,
			letter: "B",
			number: "2",
		});
		const placed = await makeClub();
		const free = await makeClub();
		const archived = await makeClub({ archived: true });
		await addAreaClub({ areaId: b2.areaId, clubId: placed });

		const ids = (a: Awaited<ReturnType<typeof getConsoleArea>>) =>
			a.availableClubs.map((c) => c.id);
		const thisYear = ids(await getConsoleArea(b2.areaId));
		expect(thisYear).toContain(free);
		expect(thisYear).not.toContain(placed);
		expect(thisYear).not.toContain(archived);
		// Placed this year, free next year.
		expect(ids(await getConsoleArea(nextYear.areaId))).toContain(placed);
	});

	it("offers a link only to a live club that is in no area of this program year", async () => {
		const districtId = await makeDistrict();
		const b2 = await makeChain({ districtId, letter: "B", number: "2" });
		const c3 = await makeChain({ districtId, letter: "C", number: "3" });
		const free = uniqueClubNumber();
		const archived = uniqueClubNumber();
		const placedElsewhere = uniqueClubNumber();
		const freeClub = await makeClub({ clubNumber: free });
		await makeClub({ archived: true, clubNumber: archived });
		const placedClub = await makeClub({ clubNumber: placedElsewhere });
		await addAreaClub({ areaId: c3.areaId, clubId: placedClub });

		const rows = new Map<string, string>();
		for (const [label, clubNumber] of [
			["free", free],
			["archived", archived],
			["placed", placedElsewhere],
		] as const) {
			// A name-only row typed with the number of a club placed elsewhere is
			// refused up front, so lay that one down by hand.
			const [row] = await testDb
				.insert(areaClubs)
				.values({ areaId: b2.areaId, name: label, clubNumber })
				.returning({ id: areaClubs.id });
			rows.set(label, row?.id as string);
		}

		const detail = await getConsoleArea(b2.areaId);
		const offer = (label: string) =>
			detail.clubs.find((c) => c.id === rows.get(label))?.linkOffer;
		expect(offer("free")).toMatchObject({ clubId: freeClub });
		expect(offer("archived")).toBeNull();
		expect(offer("placed")).toBeNull();
	});

	it("leaves the area club, its name and its visit when the club is deleted permanently", async () => {
		const { areaId } = await makeChain();
		const club = await makeClub();
		const [{ name }] = (await testDb
			.select({ name: clubs.name })
			.from(clubs)
			.where(eq(clubs.id, club))) as [{ name: string }];
		const { id: areaClubId } = await addAreaClub({ areaId, clubId: club });
		const visitId = await insertVisit(areaClubId);
		// A club must be archived before it can be deleted permanently, and an
		// archived club cannot be placed, so it is archived after the placement.
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, club));

		await deleteClubPermanently(club, name);

		expect(
			await testDb
				.select({ id: clubs.id })
				.from(clubs)
				.where(eq(clubs.id, club)),
		).toHaveLength(0);
		expect(await clubRow(areaClubId)).toMatchObject({ clubId: null, name });
		expect(
			await testDb
				.select({ id: clubVisits.id })
				.from(clubVisits)
				.where(eq(clubVisits.id, visitId)),
		).toHaveLength(1);
		const detail = await getConsoleArea(areaId);
		expect(detail.clubs).toMatchObject([
			{ id: areaClubId, clubId: null, name, visitCount: 1 },
		]);
	});

	/** A director whose only club is deleted permanently, beside a bystander who
	 *  is deleted with it (the control: a `usersKept` of 1 is the director, not
	 *  "nothing was deleted"). `endTerm` leaves the director with an ENDED term
	 *  only; otherwise a second, open one follows it. */
	async function deleteDirectorsOnlyClub(opts: { endTerm: boolean }) {
		const { areaId } = await makeChain();
		const club = await makeClub({ archived: true });
		const [{ name }] = (await testDb
			.select({ name: clubs.name })
			.from(clubs)
			.where(eq(clubs.id, club))) as [{ name: string }];
		const director = await makeUser();
		const bystander = await makeUser();
		await joinClub(club, director.id);
		await joinClub(club, bystander.id);
		const { id: termId } = await assignAreaDirector(
			{ areaId, userId: director.id, displayName: "Jamie Rivera" },
			bystander.id,
		);
		if (opts.endTerm) {
			await endAreaDirectorTerm({ termId }, bystander.id);
		} else {
			// An ENDED term holds the account too, and so does a later open one.
			await endAreaDirectorTerm({ termId }, bystander.id);
			await assignAreaDirector(
				{ areaId, userId: director.id, displayName: "Jamie Rivera" },
				bystander.id,
			);
		}

		const result = await deleteClubPermanently(club, name);

		expect(result).toMatchObject({ usersDeleted: 1, usersKept: 1 });
		expect(
			await testDb
				.select({ id: user.id })
				.from(user)
				.where(eq(user.id, director.id)),
		).toHaveLength(1);
		expect(
			await testDb
				.select({ id: user.id })
				.from(user)
				.where(eq(user.id, bystander.id)),
		).toHaveLength(0);
		return testDb
			.select({
				id: areaDirectors.id,
				endedAt: areaDirectors.endedAt,
				endedBy: areaDirectors.endedBy,
			})
			.from(areaDirectors)
			.where(eq(areaDirectors.userId, director.id));
	}

	it("keeps a director's account and terms when their only club is deleted permanently", async () => {
		const terms = await deleteDirectorsOnlyClub({ endTerm: false });
		// Both terms survive; the ended one's `ended_by` went to NULL with the
		// bystander's account (SET NULL), which is the audit column's job.
		expect(terms).toHaveLength(2);
		expect(terms.map((t) => t.endedBy)).toContain(null);
	});

	it("keeps the account of a user who holds only an ENDED term", async () => {
		const terms = await deleteDirectorsOnlyClub({ endTerm: true });
		expect(terms).toHaveLength(1);
		expect(terms[0]?.endedAt).not.toBeNull();
	});

	it("finds a user for director on an exact, verified email only", async () => {
		const email = `Lookup-${run()}@Test.Example`;
		const verified = await makeUser({ email });
		const unverified = await makeUser({ verified: false });

		// Case and surrounding space are forgiven; the address is not.
		expect(
			await findUserForDirector({ email: ` ${email.toLowerCase()} ` }),
		).toEqual({ id: verified.id, email });
		expect(await findUserForDirector({ email })).toEqual({
			id: verified.id,
			email,
		});
		expect(await findUserForDirector({ email: unverified.email })).toBeNull();
		// Near-miss: the stored address with its last character dropped.
		expect(await findUserForDirector({ email: email.slice(0, -1) })).toBeNull();
		expect(
			await findUserForDirector({ email: unverified.email.slice(0, -1) }),
		).toBeNull();
		expect(await findUserForDirector({ email: "   " })).toBeNull();
		// A stored address with stray whitespace is still that address: both sides
		// are normalised by the one shared expression.
		const padded = await makeUser({ email: ` Padded-${run()}@Test.Example ` });
		expect(
			await findUserForDirector({ email: padded.email.trim().toLowerCase() }),
		).toEqual({ id: padded.id, email: padded.email });
		// Two verified accounts that differ only by case: neither is "the" match.
		const twin = `Twin-${run()}@Test.Example`;
		await makeUser({ email: twin });
		await makeUser({ email: twin.toLowerCase() });
		expect(await findUserForDirector({ email: twin })).toBeNull();
		// No `name`: it is "" for a magic-link account.
		expect(Object.keys((await findUserForDirector({ email })) ?? {})).toEqual([
			"id",
			"email",
		]);
	});

	it("opens one term per area: a second is refused with the message, not a 500", async () => {
		const { areaId } = await makeChain();
		const first = await makeUser();
		const second = await makeUser();

		const { id: termId } = await assignAreaDirector(
			{ areaId, userId: first.id, displayName: "  Jamie Rivera  " },
			first.id,
		);
		const [term] = await testDb
			.select()
			.from(areaDirectors)
			.where(eq(areaDirectors.id, termId));
		expect(term).toMatchObject({
			areaId,
			userId: first.id,
			displayName: "Jamie Rivera",
			endedAt: null,
			assignedBy: first.id,
		});

		await expect(
			assignAreaDirector(
				{ areaId, userId: second.id, displayName: "Pat Lee" },
				first.id,
			),
		).rejects.toThrow(CURRENT_TERM_EXISTS_MESSAGE);

		// The database itself refuses it: a unique violation, not the check above.
		await expect(
			testDb
				.insert(areaDirectors)
				.values({ areaId, userId: second.id, displayName: "Pat Lee" }),
		).rejects.toMatchObject({ cause: { code: "23505" } });
	});

	it("serializes two concurrent assignments to one area", async () => {
		const { areaId } = await makeChain();
		const a = await makeUser();
		const b = await makeUser();

		const results = await Promise.allSettled([
			assignAreaDirector({ areaId, userId: a.id, displayName: "A" }, a.id),
			assignAreaDirector({ areaId, userId: b.id, displayName: "B" }, a.id),
		]);

		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const refused = results.find((r) => r.status === "rejected");
		expect(refused?.status === "rejected" && String(refused.reason)).toContain(
			CURRENT_TERM_EXISTS_MESSAGE,
		);
	});

	it("ends a term, then allows a new one, and refuses ending it twice", async () => {
		const { areaId } = await makeChain();
		const first = await makeUser();
		const second = await makeUser();
		const admin = await makeUser();

		const { id: termId } = await assignAreaDirector(
			{ areaId, userId: first.id, displayName: "First" },
			admin.id,
		);
		await endAreaDirectorTerm({ termId }, admin.id);
		const [ended] = await testDb
			.select()
			.from(areaDirectors)
			.where(eq(areaDirectors.id, termId));
		expect(ended?.endedBy).toBe(admin.id);
		expect(ended?.endedAt).not.toBeNull();
		expect(ended?.endedAt && ended.endedAt >= ended.startedAt).toBe(true);
		await expect(endAreaDirectorTerm({ termId }, admin.id)).rejects.toThrow(
			NO_CURRENT_TERM_MESSAGE,
		);

		await assignAreaDirector(
			{ areaId, userId: second.id, displayName: "Second" },
			admin.id,
		);
		const detail = await getConsoleArea(areaId);
		expect(detail.director).toMatchObject({
			displayName: "Second",
			email: second.email,
			state: "current",
		});
		expect(detail.pastTerms).toMatchObject([
			{ id: termId, displayName: "First", state: "ended" },
		]);
	});

	it("refuses a term that ends before it starts, at the database", async () => {
		const { areaId } = await makeChain();
		const u = await makeUser();
		await expect(
			testDb.insert(areaDirectors).values({
				areaId,
				userId: u.id,
				displayName: "Backwards",
				startedAt: new Date("2026-09-02T00:00:00Z"),
				endedAt: new Date("2026-09-01T00:00:00Z"),
			}),
		).rejects.toMatchObject({ cause: { code: "23514" } });
	});

	it("needs a display name, and a verified account", async () => {
		const { areaId } = await makeChain();
		const verified = await makeUser();
		const unverified = await makeUser({ verified: false });

		for (const displayName of ["", "   "]) {
			const parsed = assignAreaDirectorSchema.safeParse({
				areaId,
				userId: verified.id,
				displayName,
			});
			expect(parsed.success).toBe(false);
		}
		await expect(
			assignAreaDirector(
				{ areaId, userId: verified.id, displayName: "   " },
				verified.id,
			),
		).rejects.toThrow(DISPLAY_NAME_REQUIRED_MESSAGE);
		await expect(
			assignAreaDirector(
				{ areaId, userId: unverified.id, displayName: "Unverified" },
				verified.id,
			),
		).rejects.toThrow(DIRECTOR_NOT_VERIFIED_MESSAGE);
		await expect(
			assignAreaDirector(
				{ areaId, userId: "no-such-user", displayName: "Nobody" },
				verified.id,
			),
		).rejects.toThrow(DIRECTOR_NOT_VERIFIED_MESSAGE);
		await expect(
			assignAreaDirector(
				{ areaId: randomUUID(), userId: verified.id, displayName: "Lost" },
				verified.id,
			),
		).rejects.toThrow("Area not found");
	});

	it("shows an open term by where it stands: current, upcoming, or ended with its year", async () => {
		const districtId = await makeDistrict();
		const thisYear = await makeChain({ districtId, letter: "B", number: "2" });
		const nextYear = await makeChain({
			districtId,
			year: YEAR + 1,
			letter: "B",
			number: "2",
		});
		const lastYear = await makeChain({
			districtId,
			year: YEAR - 1,
			letter: "B",
			number: "2",
		});
		const admin = await makeUser();
		await assignAreaDirector(
			{ areaId: thisYear.areaId, userId: admin.id, displayName: "Jamie" },
			admin.id,
		);
		await assignAreaDirector(
			{ areaId: nextYear.areaId, userId: admin.id, displayName: "Jamie" },
			admin.id,
		);
		// A past year takes no new director, so its open term is history laid down by hand.
		await insertOpenTerm(lastYear.areaId, admin.id);

		expect((await getConsoleArea(thisYear.areaId)).director?.state).toBe(
			"current",
		);
		expect((await getConsoleArea(nextYear.areaId)).director?.state).toBe(
			"upcoming",
		);
		expect((await getConsoleArea(lastYear.areaId)).director?.state).toBe(
			"ended-with-year",
		);
		// The list counts every OPEN term, and says where each stands: an upcoming
		// director is not "no director".
		const list = await listConsoleAreas();
		const byArea = new Map(
			list.districts
				.find((d) => d.id === districtId)
				?.divisions.flatMap((d) => d.areas)
				.map((a) => [a.id, a]),
		);
		expect(byArea.get(thisYear.areaId)).toMatchObject({
			directorCount: 1,
			directorState: "current",
		});
		expect(byArea.get(nextYear.areaId)).toMatchObject({
			directorCount: 1,
			directorState: "upcoming",
		});
		expect(byArea.get(lastYear.areaId)).toMatchObject({
			directorCount: 1,
			directorState: "ended-with-year",
		});
	});

	it("refuses a new Area Director on a past year's area, and writes nothing", async () => {
		const lastYear = await makeChain({ year: YEAR - 1 });
		const admin = await makeUser();
		await expect(
			assignAreaDirector(
				{ areaId: lastYear.areaId, userId: admin.id, displayName: "Jamie" },
				admin.id,
			),
		).rejects.toThrow(pastYearAreaMessage(YEAR - 1));
		const terms = await testDb
			.select({ id: areaDirectors.id })
			.from(areaDirectors)
			.where(eq(areaDirectors.areaId, lastYear.areaId));
		expect(terms).toHaveLength(0);
	});

	it("answers an account deleted under the insert with a plain message, not the driver's text", async () => {
		const { areaId } = await makeChain();
		const admin = await makeUser();
		const doomed = await makeUser();

		// The account still reads as verified when the check runs; its delete then
		// commits while the insert waits on the foreign key's lock, so the insert
		// fails with a foreign key violation (23503).
		const deleting = await openBlockingTx(async (tx) => {
			await tx.delete(user).where(eq(user.id, doomed.id));
		});
		let committed = false;
		try {
			const outcome = assignAreaDirector(
				{ areaId, userId: doomed.id, displayName: "Doomed" },
				admin.id,
			).then(
				() => "assigned",
				(err: unknown) => (err instanceof Error ? err.message : String(err)),
			);
			await waitForLockWait("area_directors", deleting.pid);
			await deleting.commit();
			committed = true;
			expect(await outcome).toBe(ASSIGN_TARGET_GONE_MESSAGE);
		} finally {
			if (!committed) await deleting.commit();
		}
	});

	it("turns any other failure of the term insert into a plain message", () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const raw = new Error(
			'Failed query: insert into "area_directors" ("id", "user_id") values ($1, $2) params: abc,def',
		);
		const out = assignDirectorFailure(raw);
		expect(out.message).toBe(ASSIGN_FAILED_MESSAGE);
		expect(out.message).not.toContain("insert into");
		// The raw error is logged for the operator, never shown.
		expect(log).toHaveBeenCalledWith("[areas] assignAreaDirector failed", raw);
		log.mockRestore();
		// The two it knows, found under the driver's wrapper as the real ones are.
		expect(
			assignDirectorFailure(new Error("wrapped", { cause: { code: "23505" } }))
				.message,
		).toBe(CURRENT_TERM_EXISTS_MESSAGE);
		expect(
			assignDirectorFailure(new Error("wrapped", { cause: { code: "23503" } }))
				.message,
		).toBe(ASSIGN_TARGET_GONE_MESSAGE);
	});

	it("the database refuses the same club twice in one area, but not two name-only rows", async () => {
		const { areaId } = await makeChain();
		const club = await makeClub();
		await testDb
			.insert(areaClubs)
			.values({ areaId, clubId: club, name: "First" });
		await expect(
			testDb.insert(areaClubs).values({ areaId, clubId: club, name: "Again" }),
		).rejects.toMatchObject({
			cause: { code: "23505", constraint: "area_clubs_area_club_unique" },
		});
		// The index is partial: any number of name-only rows may share an area.
		await testDb.insert(areaClubs).values([
			{ areaId, name: "Name only A" },
			{ areaId, name: "Name only B" },
		]);
	});

	it("the database refuses a repeated visit round for one area club", async () => {
		const { areaId } = await makeChain();
		const { id: areaClubId } = await addAreaClub({ areaId, name: "Visited" });
		await insertVisit(areaClubId);
		await expect(
			testDb
				.insert(clubVisits)
				.values({ areaClubId, round: 1, visitedOn: "2026-11-01" }),
		).rejects.toMatchObject({
			cause: {
				code: "23505",
				constraint: "club_visits_area_club_round_unique",
			},
		});
		// Round 2 is a different visit.
		await testDb
			.insert(clubVisits)
			.values({ areaClubId, round: 2, visitedOn: "2026-11-01" });
	});

	it("the database refuses a visit round other than 1 or 2", async () => {
		const { areaId } = await makeChain();
		const { id: areaClubId } = await addAreaClub({ areaId, name: "Visited" });
		for (const round of [0, 3]) {
			await expect(
				testDb
					.insert(clubVisits)
					.values({ areaClubId, round, visitedOn: "2026-10-01" }),
			).rejects.toMatchObject({
				cause: { code: "23514", constraint: "club_visits_round_check" },
			});
		}
	});

	it("says so when the area is not found", async () => {
		await expect(getConsoleArea(randomUUID())).rejects.toThrow(
			"Area not found",
		);
		await expect(
			addAreaClub({ areaId: randomUUID(), name: "Lost" }),
		).rejects.toThrow("Area not found");
	});

	it("needs a name for a name-only club, and a real club for a GavelUp one", async () => {
		const { areaId } = await makeChain();
		await expect(addAreaClub({ areaId, name: "   " })).rejects.toThrow(
			"Enter the club's name",
		);
		await expect(addAreaClub({ areaId })).rejects.toThrow(
			"Enter the club's name",
		);
		await expect(addAreaClub({ areaId, clubId: randomUUID() })).rejects.toThrow(
			"Club not found",
		);
	});
});
