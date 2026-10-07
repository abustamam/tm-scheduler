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
	CLUB_HAS_VISITS_MESSAGE,
	CURRENT_TERM_EXISTS_MESSAGE,
	DIRECTOR_NOT_VERIFIED_MESSAGE,
	DISPLAY_NAME_REQUIRED_MESSAGE,
	NO_CURRENT_TERM_MESSAGE,
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
		});
		expect(division?.areas[1]).toMatchObject({
			clubCount: 0,
			directorCount: 0,
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
		// inserts, and one club sits in two areas of one year.
		const concurrent = await openBlockingTx(async (tx) => {
			await tx
				.select({ id: clubs.id })
				.from(clubs)
				.where(eq(clubs.id, club))
				.for("update");
			await tx
				.insert(areaClubs)
				.values({ areaId: first.areaId, clubId: club, name: "First" });
		});
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

		// The one-area-per-year rule holds for a link as much as for an add.
		const { id: elsewhere } = await addAreaClub({
			areaId: c3.areaId,
			name: "Same club, other area",
			clubNumber,
		});
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

	it("leaves the area club, its name and its visit when the club is deleted permanently", async () => {
		const { areaId } = await makeChain();
		const club = await makeClub({ archived: true });
		const [{ name }] = (await testDb
			.select({ name: clubs.name })
			.from(clubs)
			.where(eq(clubs.id, club))) as [{ name: string }];
		const { id: areaClubId } = await addAreaClub({ areaId, clubId: club });
		const visitId = await insertVisit(areaClubId);

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

	it("keeps a director's account and term when their only club is deleted permanently", async () => {
		const { areaId } = await makeChain();
		const club = await makeClub({ archived: true });
		const [{ name }] = (await testDb
			.select({ name: clubs.name })
			.from(clubs)
			.where(eq(clubs.id, club))) as [{ name: string }];

		const director = await makeUser();
		const bystander = await makeUser();
		for (const u of [director, bystander]) {
			const [person] = await testDb
				.insert(people)
				.values({ name: "P", userId: u.id })
				.returning({ id: people.id });
			if (!person) throw new Error("person");
			created.people.push(person.id);
			await testDb.insert(members).values({
				clubId: club,
				personId: person.id,
				name: "M",
				clubRole: "member",
				status: "active",
			});
		}
		const { id: termId } = await assignAreaDirector(
			{ areaId, userId: director.id, displayName: "Jamie Rivera" },
			bystander.id,
		);
		// An ENDED term holds the account too: the key is the row, not its state.
		await endAreaDirectorTerm({ termId }, bystander.id);
		await assignAreaDirector(
			{ areaId, userId: director.id, displayName: "Jamie Rivera" },
			bystander.id,
		);

		const result = await deleteClubPermanently(club, name);

		// The control: the account with nothing holding it is deleted, so a
		// `usersKept` of 1 is the director and not "nothing was deleted".
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
		const terms = await testDb
			.select({ id: areaDirectors.id, endedBy: areaDirectors.endedBy })
			.from(areaDirectors)
			.where(eq(areaDirectors.userId, director.id));
		// Both terms survive; the ended one's `ended_by` went to NULL with the
		// bystander's account (SET NULL), which is the audit column's job.
		expect(terms).toHaveLength(2);
		expect(terms.map((t) => t.endedBy)).toContain(null);
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
		for (const { areaId } of [thisYear, nextYear, lastYear]) {
			await assignAreaDirector(
				{ areaId, userId: admin.id, displayName: "Jamie" },
				admin.id,
			);
		}

		expect((await getConsoleArea(thisYear.areaId)).director?.state).toBe(
			"current",
		);
		expect((await getConsoleArea(nextYear.areaId)).director?.state).toBe(
			"upcoming",
		);
		expect((await getConsoleArea(lastYear.areaId)).director?.state).toBe(
			"ended-with-year",
		);
		// The list counts only the current one.
		const list = await listConsoleAreas();
		const counts = new Map(
			list.districts
				.find((d) => d.id === districtId)
				?.divisions.flatMap((d) => d.areas)
				.map((a) => [a.id, a.directorCount]),
		);
		expect(counts.get(thisYear.areaId)).toBe(1);
		expect(counts.get(nextYear.areaId)).toBe(0);
		expect(counts.get(lastYear.areaId)).toBe(0);
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
