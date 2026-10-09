/**
 * Recording and clearing club visits, and one club's summary (#1120, ADR-0032),
 * against the real database.
 *
 * Executes the REAL `createServerFn` handlers through the minimal adapter the
 * other area suites use, with the cookie -> session lookup faked and nothing
 * else: `requireUser`, `requireAreaDirector`, `requireAreaDirectorTx` and the
 * logic all run for real. The ORDER the gates run in is pinned by
 * `area-visits-authz.guard.test.ts`; this proves the refusals, the date rules
 * and the writes themselves. Each refusal has its control: the same call by the
 * director who may, so no case passes on a harness that refuses everything.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:…@localhost:5432/tm_test \
 *     bunx vitest run src/server/area-visits.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	areaClubs,
	areaDirectors,
	areas,
	clubs,
	clubVisits,
	districts,
	divisions,
	user,
} from "#/db/schema";
import { currentProgramYear } from "#/lib/dcp";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	seedClub,
	testDb,
	waitForLockWait,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
// Both handler shapes: with a validator and without one.
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({
		validator: (parse: (input: unknown) => unknown) => ({
			handler:
				(handle: (input: { data: unknown }) => unknown) =>
				({ data }: { data: unknown }) =>
					handle({ data: parse(data) }),
		}),
		handler:
			(handle: (input: { data: unknown }) => unknown) =>
			({ data }: { data: unknown }) =>
				handle({ data }),
	}),
}));

let sessionUserId: string | null = null;
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => ({ headers: new Headers() }),
}));
vi.mock("#/lib/auth", () => ({
	auth: {
		api: {
			getSession: async () =>
				sessionUserId ? { user: { id: sessionUserId } } : null,
		},
	},
}));

const { recordClubVisit, clearClubVisit, getAreaClubSummary } = await import(
	"./area-visits"
);
const { recordClubVisit: recordVisitLogic, loadAreaVisits } = await import(
	"./area-visits-logic"
);
const { getAreaHealth } = await import("./area-health");
const { NO_PERMISSION_MESSAGE } = await import("./guards");
const { VISIT_IN_FUTURE_MESSAGE, outsideProgramYearMessage } = await import(
	"#/lib/area-visits"
);

type Fn = (input: { data: unknown }) => Promise<unknown>;

const YEAR = currentProgramYear();
const created = {
	districts: [] as string[],
	users: [] as string[],
	clubs: [] as string[],
};

async function teardown() {
	sessionUserId = null;
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
			const rows = await testDb
				.select({ id: areaClubs.id })
				.from(areaClubs)
				.where(inArray(areaClubs.areaId, areaIds));
			if (rows.length > 0) {
				await testDb.delete(clubVisits).where(
					inArray(
						clubVisits.areaClubId,
						rows.map((r) => r.id),
					),
				);
			}
			await testDb.delete(areaClubs).where(inArray(areaClubs.areaId, areaIds));
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
	for (const clubId of created.clubs) await cleanup(clubId, []);
	if (created.users.length > 0) {
		await testDb.delete(user).where(inArray(user.id, created.users));
	}
	created.districts.length = 0;
	created.users.length = 0;
	created.clubs.length = 0;
}

async function makeUser(isSuperadmin = false) {
	const id = randomUUID();
	await testDb.insert(user).values({
		id,
		name: "",
		email: `area-visits-${id}@test.example`,
		emailVerified: true,
		isSuperadmin,
	});
	created.users.push(id);
	return id;
}

async function makeWorld() {
	const [district] = await testDb
		.insert(districts)
		.values({ number: `V${randomUUID().slice(0, 7)}` })
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

async function openTerm(areaId: string, userId: string) {
	const [row] = await testDb
		.insert(areaDirectors)
		.values({ areaId, userId, displayName: "Jamie" })
		.returning({ id: areaDirectors.id });
	return row?.id as string;
}

async function nameOnlyClub(areaId: string, name = "Name-only Club") {
	const [row] = await testDb
		.insert(areaClubs)
		.values({ areaId, name, clubNumber: "7654321" })
		.returning({ id: areaClubs.id });
	return row?.id as string;
}

/** An area with one name-only club and a director signed in. */
async function setup() {
	const area = await makeWorld();
	const areaId = await area(YEAR, "B", "2");
	const areaClubId = await nameOnlyClub(areaId);
	const directorId = await makeUser();
	const termId = await openTerm(areaId, directorId);
	sessionUserId = directorId;
	return { area, areaId, areaClubId, directorId, termId };
}

const exact = (message: string) =>
	new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

/** A date inside this program year and not in the future: July 1 of YEAR. */
const OK_DATE = `${YEAR}-07-01`;

// `async`: the adapter runs the validator synchronously, a real client sees its
// throw as a rejection.
const record = async (areaClubId: string, round: unknown, visitedOn: unknown) =>
	(recordClubVisit as Fn)({ data: { areaClubId, round, visitedOn } });
const clear = async (areaClubId: string, round: unknown) =>
	(clearClubVisit as Fn)({ data: { areaClubId, round } });

async function visitRows(areaClubId: string) {
	return testDb
		.select({
			round: clubVisits.round,
			visitedOn: clubVisits.visitedOn,
			recordedBy: clubVisits.recordedBy,
		})
		.from(clubVisits)
		.where(eq(clubVisits.areaClubId, areaClubId))
		.orderBy(clubVisits.round);
}

describe.skipIf(!hasTestDb)(
	"recordClubVisit and clearClubVisit (#1120)",
	() => {
		afterEach(teardown);

		it("records round 1, shows it in the area's read, and records again as an edit: one row per round", async () => {
			const { areaId, areaClubId, directorId } = await setup();

			// Today in UTC: a name-only club's zone, so never "in the future".
			const today = new Date().toISOString().slice(0, 10);
			await record(areaClubId, 1, today);
			const first = (await (getAreaHealth as Fn)({ data: { areaId } })) as {
				visits: Record<string, Record<string, string>>;
			};
			expect(first.visits[areaClubId]).toEqual({ 1: today });

			// Recording the same round again edits it.
			await record(areaClubId, 1, OK_DATE);
			await record(areaClubId, 2, OK_DATE);

			const rows = await visitRows(areaClubId);
			expect(rows).toEqual([
				{ round: 1, visitedOn: OK_DATE, recordedBy: directorId },
				{ round: 2, visitedOn: OK_DATE, recordedBy: directorId },
			]);
			expect((await loadAreaVisits(areaId))[areaClubId]).toEqual({
				1: OK_DATE,
				2: OK_DATE,
			});
		});

		it("clears one round and leaves the other; clearing an unrecorded round is not an error", async () => {
			const { areaClubId } = await setup();
			await record(areaClubId, 1, OK_DATE);
			await record(areaClubId, 2, OK_DATE);

			await clear(areaClubId, 1);
			expect((await visitRows(areaClubId)).map((r) => r.round)).toEqual([2]);

			await expect(clear(areaClubId, 1)).resolves.toBeUndefined();
		});

		it("lets a name-only club ('not on GavelUp') have visits recorded", async () => {
			const { areaId, areaClubId } = await setup();
			const [row] = await testDb
				.select({ clubId: areaClubs.clubId })
				.from(areaClubs)
				.where(eq(areaClubs.id, areaClubId));
			// Control: the row really is name-only.
			expect(row?.clubId).toBeNull();

			await record(areaClubId, 2, OK_DATE);

			expect((await loadAreaVisits(areaId))[areaClubId]).toEqual({
				2: OK_DATE,
			});
		});

		it("refuses another area's director, a superadmin with no term and an ended term, on both writes", async () => {
			const { area, areaId, areaClubId, termId } = await setup();
			const otherAreaId = await area(YEAR, "C", "3");
			const otherDirector = await makeUser();
			await openTerm(otherAreaId, otherDirector);
			const superadmin = await makeUser(true);
			// Control: the area's own director records and clears.
			await record(areaClubId, 1, OK_DATE);
			await clear(areaClubId, 1);
			await record(areaClubId, 2, OK_DATE);

			for (const who of [otherDirector, superadmin]) {
				sessionUserId = who;
				await expect(record(areaClubId, 1, OK_DATE)).rejects.toThrow(
					exact(NO_PERMISSION_MESSAGE),
				);
				await expect(clear(areaClubId, 2)).rejects.toThrow(
					exact(NO_PERMISSION_MESSAGE),
				);
			}

			// An ended term: the same director, after the term is over.
			await testDb
				.update(areaDirectors)
				.set({ endedAt: sql`now()` })
				.where(eq(areaDirectors.id, termId));
			sessionUserId = (
				await testDb
					.select({ userId: areaDirectors.userId })
					.from(areaDirectors)
					.where(eq(areaDirectors.id, termId))
			)[0]?.userId as string;
			await expect(record(areaClubId, 1, OK_DATE)).rejects.toThrow(
				exact(NO_PERMISSION_MESSAGE),
			);
			await expect(clear(areaClubId, 2)).rejects.toThrow(
				exact(NO_PERMISSION_MESSAGE),
			);

			// Nothing was written or removed by a refused call.
			expect((await visitRows(areaClubId)).map((r) => r.round)).toEqual([2]);
			expect(areaId).toBeTruthy();
		});

		it("refuses a director who names ANOTHER area's club: the area is resolved from the club", async () => {
			const { area, areaClubId } = await setup();
			const otherAreaId = await area(YEAR, "C", "3");
			const otherClubId = await nameOnlyClub(otherAreaId, "Other Area Club");
			// Control: the director's own club takes the write.
			await record(areaClubId, 1, OK_DATE);

			await expect(record(otherClubId, 1, OK_DATE)).rejects.toThrow(
				exact(NO_PERMISSION_MESSAGE),
			);
			await expect(clear(otherClubId, 1)).rejects.toThrow(
				exact(NO_PERMISSION_MESSAGE),
			);
			expect(await visitRows(otherClubId)).toEqual([]);
		});

		it("re-checks inside the transaction that the club is still in the authorized area (a club that moved or was removed after the handler looked)", async () => {
			const { area, areaId, directorId } = await setup();
			const otherAreaId = await area(YEAR, "C", "3");
			const otherClubId = await nameOnlyClub(otherAreaId, "Other Area Club");

			// The logic is handed the area the handler authorized and a club that is not
			// in it, as it would be if the club had moved after the handler's lookup.
			await expect(
				recordVisitLogic(directorId, areaId, {
					areaClubId: otherClubId,
					round: 1,
					visitedOn: OK_DATE,
				}),
			).rejects.toThrow(exact(NO_PERMISSION_MESSAGE));
			expect(await visitRows(otherClubId)).toEqual([]);
		});

		it("answers an id that names no club, or is not an id, with the same refusal", async () => {
			const { areaClubId } = await setup();
			await record(areaClubId, 1, OK_DATE);

			for (const bad of [randomUUID(), "not-a-uuid", "x".repeat(500), 42]) {
				await expect(
					Promise.resolve().then(() => record(bad as string, 1, OK_DATE)),
				).rejects.toThrow(exact(NO_PERMISSION_MESSAGE));
			}
		});

		it("refuses a future date and a malformed one, with a message", async () => {
			const { areaClubId } = await setup();
			await record(areaClubId, 1, OK_DATE);
			const tomorrow = new Date(Date.now() + 2 * 86_400_000)
				.toISOString()
				.slice(0, 10);

			await expect(record(areaClubId, 1, tomorrow)).rejects.toThrow(
				exact(VISIT_IN_FUTURE_MESSAGE),
			);
			await expect(record(areaClubId, 1, "2026-02-31")).rejects.toThrow(
				"Enter the visit date",
			);
			await expect(record(areaClubId, 3, OK_DATE)).rejects.toThrow(
				"A visit is round 1 or round 2",
			);
			// The refused calls left round 1 as it was.
			expect((await visitRows(areaClubId))[0]?.visitedOn).toBe(OK_DATE);
		});

		it("uses the club's own zone for 'not in the future' when the club is on GavelUp, and UTC when it is not", async () => {
			const area = await makeWorld();
			const areaId = await area(YEAR, "B", "2");
			const seed = await seedClub();
			created.clubs.push(seed.clubId);
			// UTC+14: 23:00 UTC on the 15th is already the 16th there.
			await testDb
				.update(clubs)
				.set({ timezone: "Pacific/Kiritimati" })
				.where(eq(clubs.id, seed.clubId));
			const [linked] = await testDb
				.insert(areaClubs)
				.values({ areaId, clubId: seed.clubId, name: "Linked Club" })
				.returning({ id: areaClubs.id });
			const nameOnly = await nameOnlyClub(areaId);
			const directorId = await makeUser();
			await openTerm(areaId, directorId);
			const now = new Date(`${YEAR}-09-15T23:00:00.000Z`);
			const visitedOn = `${YEAR}-09-16`;

			await expect(
				recordVisitLogic(
					directorId,
					areaId,
					{ areaClubId: linked?.id as string, round: 1, visitedOn },
					now,
				),
			).resolves.toEqual({ round: 1, visitedOn });
			await expect(
				recordVisitLogic(
					directorId,
					areaId,
					{ areaClubId: nameOnly, round: 1, visitedOn },
					now,
				),
			).rejects.toThrow(exact(VISIT_IN_FUTURE_MESSAGE));
		});

		it("takes July 1 of the program year and refuses June 30 before it and July 1 after it", async () => {
			const { areaId, areaClubId, directorId } = await setup();
			const input = (visitedOn: string) => ({
				areaClubId,
				round: 1 as const,
				visitedOn,
			});

			// The first day of the year is inside it...
			await expect(
				record(areaClubId, 1, `${YEAR}-07-01`),
			).resolves.toMatchObject({ visitedOn: `${YEAR}-07-01` });
			// ...the day before is not, whatever zone the server runs in.
			await expect(record(areaClubId, 1, `${YEAR}-06-30`)).rejects.toThrow(
				exact(outsideProgramYearMessage(YEAR)),
			);
			// The upper bound is exclusive. It is unreachable by a real clock until
			// the year is over, so the clock is injected, well past it.
			const later = new Date(`${YEAR + 2}-01-01T00:00:00.000Z`);
			await expect(
				recordVisitLogic(directorId, areaId, input(`${YEAR + 1}-06-30`), later),
			).resolves.toMatchObject({ visitedOn: `${YEAR + 1}-06-30` });
			await expect(
				recordVisitLogic(directorId, areaId, input(`${YEAR + 1}-07-01`), later),
			).rejects.toThrow(exact(outsideProgramYearMessage(YEAR)));
		});

		it("refuses a write that was waiting on a term ending, and writes no row (the FOR SHARE re-ask)", async () => {
			const { areaClubId, termId } = await setup();
			// A concurrent endAreaDirectorTerm: its UPDATE holds the term row, not yet
			// committed, so the handler's fast check (a plain read) still sees an open
			// term and passes.
			const ending = await openBlockingTx(async (tx) => {
				await tx
					.update(areaDirectors)
					.set({ endedAt: sql`now()` })
					.where(eq(areaDirectors.id, termId));
			});
			let write: Promise<unknown> | undefined;
			try {
				write = record(areaClubId, 1, OK_DATE);
				write.catch(() => {});
				// Parked on the term row's lock, behind the ender.
				await waitForLockWait("for share", ending.pid, 5_000);
			} finally {
				await ending.commit();
			}

			await expect(write).rejects.toThrow(exact(NO_PERMISSION_MESSAGE));
			expect(await visitRows(areaClubId)).toEqual([]);
		}, 30_000);
	},
);

describe.skipIf(!hasTestDb)("getAreaClubSummary (#1120)", () => {
	afterEach(teardown);

	const summary = (areaId: string, areaClubId: string) =>
		(getAreaClubSummary as Fn)({ data: { areaId, areaClubId } }) as Promise<{
			areaId: string;
			label: string;
			club: { areaClubId: string; name: string };
			visits: Record<string, string>;
		}>;

	it("returns the club, the area label and both visit dates", async () => {
		const { areaId, areaClubId } = await setup();
		await record(areaClubId, 1, OK_DATE);

		const result = await summary(areaId, areaClubId);

		expect(result.areaId).toBe(areaId);
		expect(result.label).toBe("B2");
		expect(result.club.areaClubId).toBe(areaClubId);
		expect(result.club.name).toBe("Name-only Club");
		expect(result.visits).toEqual({ 1: OK_DATE });
	});

	it("gives a director of area A not-found for area B's club paired with A's id", async () => {
		const { area, areaId, areaClubId } = await setup();
		const otherAreaId = await area(YEAR, "C", "3");
		const otherClubId = await nameOnlyClub(otherAreaId, "Other Area Club");
		// Control: A's own club reads.
		await expect(summary(areaId, areaClubId)).resolves.toMatchObject({
			areaId,
		});

		await expect(summary(areaId, otherClubId)).rejects.toThrow(
			exact(NO_PERMISSION_MESSAGE),
		);
		// And naming area B itself is refused by the term check.
		await expect(summary(otherAreaId, otherClubId)).rejects.toThrow(
			exact(NO_PERMISSION_MESSAGE),
		);
	});

	it("refuses a superadmin with no term and nobody signed in", async () => {
		const { areaId, areaClubId } = await setup();
		sessionUserId = await makeUser(true);
		await expect(summary(areaId, areaClubId)).rejects.toThrow(
			exact(NO_PERMISSION_MESSAGE),
		);

		sessionUserId = null;
		await expect(summary(areaId, areaClubId)).rejects.toThrow(
			"You need to be signed in to do that.",
		);
	});
});
