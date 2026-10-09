/**
 * Who may read an area's health, and what that grants (#1119, ADR-0032).
 *
 * Executes the REAL `createServerFn` handlers through the minimal adapter
 * `areas-authz.integration.test.ts` uses, with the cookie -> session lookup
 * faked and nothing else: `requireUser`, `requireAreaDirector`,
 * `requireSuperadmin` and the club guards all run for real against the test
 * database. The ORDER the gates run in, relative to the loader, is pinned by
 * `area-access.guard.test.ts`; this proves the refusals themselves.
 *
 * The controls are the grants: the director with a current term is let through
 * the same call everyone else is refused, so no case passes on a harness that
 * refuses everything.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:…@localhost:5432/tm_test \
 *     bunx vitest run src/server/area-guards.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AreaNavEntry } from "#/components/app-shell";
import {
	areaClubs,
	areaDirectors,
	areas,
	districts,
	divisions,
	user,
} from "#/db/schema";
import { currentProgramYear } from "#/lib/dcp";
import { cleanup, hasTestDb, seedClub, testDb } from "#/test/db";

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
// A switch on the area read, so the auth context's `.catch` can be driven. It
// passes straight through to #1116's loader unless a test turns it on.
const areaRead = vi.hoisted(() => ({ failing: false }));
vi.mock("./area-terms-logic", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./area-terms-logic")>();
	return {
		...actual,
		loadCurrentAreasForUser: (
			...args: Parameters<typeof actual.loadCurrentAreasForUser>
		) =>
			areaRead.failing
				? Promise.reject(new Error("area read is down"))
				: actual.loadCurrentAreasForUser(...args),
	};
});
vi.mock("#/lib/auth", () => ({
	auth: {
		api: {
			getSession: async () =>
				sessionUserId ? { user: { id: sessionUserId } } : null,
		},
	},
}));

const { requireAreaDirector } = await import("./area-guards");
const { getAreaHealth } = await import("./area-health");
const { previewConsoleArea } = await import("./areas");
const { getAuthContext } = await import("./auth-context");
const guards = await import("./guards");
const { listMembers } = await import("./members");
const { NO_PERMISSION_MESSAGE } = guards;

type Fn = (input: { data: unknown }) => Promise<unknown>;
type AreaHealthResult = {
	health: { areaId: string; label: string; clubs: unknown[] };
	visits: Record<string, unknown>;
};
type AuthContextResult = {
	user: { id: string } | null;
	areas: AreaNavEntry[];
};

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
		email: `area-guards-${id}@test.example`,
		emailVerified: true,
		isSuperadmin,
	});
	created.users.push(id);
	return id;
}

/** One district; `area()` adds a division + area in a given year. */
async function makeWorld() {
	const [district] = await testDb
		.insert(districts)
		.values({ number: `G${randomUUID().slice(0, 7)}` })
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

/** The database's own clock: a JS `Date` is truncated to the millisecond and can
 *  land BEFORE the term's `started_at`, which the term-order check refuses. */
async function endTerm(termId: string) {
	await testDb
		.update(areaDirectors)
		.set({ endedAt: sql`now()` })
		.where(eq(areaDirectors.id, termId));
}

const exact = (message: string) =>
	new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

describe.skipIf(!hasTestDb)("requireAreaDirector (#1119)", () => {
	afterEach(teardown);

	it("passes a user with a current term on that area", async () => {
		const area = await makeWorld();
		const areaId = await area(YEAR, "B", "2");
		const userId = await makeUser();
		await openTerm(areaId, userId);

		await expect(requireAreaDirector(userId, areaId)).resolves.toBeUndefined();
	});

	it("refuses a term that has ended", async () => {
		const area = await makeWorld();
		const areaId = await area(YEAR, "B", "2");
		const userId = await makeUser();
		const termId = await openTerm(areaId, userId);
		// Control: the same call passes while the term is open.
		await expect(requireAreaDirector(userId, areaId)).resolves.toBeUndefined();

		await endTerm(termId);

		await expect(requireAreaDirector(userId, areaId)).rejects.toThrow(
			exact(NO_PERMISSION_MESSAGE),
		);
	});

	it("refuses a current term on a DIFFERENT area", async () => {
		const area = await makeWorld();
		const areaA = await area(YEAR, "B", "2");
		const areaB = await area(YEAR, "C", "3");
		const userId = await makeUser();
		await openTerm(areaA, userId);

		await expect(requireAreaDirector(userId, areaA)).resolves.toBeUndefined();
		await expect(requireAreaDirector(userId, areaB)).rejects.toThrow(
			exact(NO_PERMISSION_MESSAGE),
		);
	});

	it("refuses an open term on last year's area: the year check retires it", async () => {
		const area = await makeWorld();
		const lastYear = await area(YEAR - 1, "B", "2");
		const userId = await makeUser();
		// Open, never ended: only the year check says it is over.
		await openTerm(lastYear, userId);

		await expect(requireAreaDirector(userId, lastYear)).rejects.toThrow(
			exact(NO_PERMISSION_MESSAGE),
		);
	});

	it("refuses an open term on NEXT year's area: a division staffed in June takes effect in July", async () => {
		const area = await makeWorld();
		const thisYear = await area(YEAR, "B", "2");
		const nextYear = await area(YEAR + 1, "C", "3");
		const userId = await makeUser();
		await openTerm(thisYear, userId);
		await openTerm(nextYear, userId);
		// Control: the same user passes on this year's area, so the refusal below
		// is the year check and not a harness that refuses everything.
		await expect(
			requireAreaDirector(userId, thisYear),
		).resolves.toBeUndefined();

		await expect(requireAreaDirector(userId, nextYear)).rejects.toThrow(
			exact(NO_PERMISSION_MESSAGE),
		);
	});

	it("refuses a superadmin with no term: no ambient cross-club bypass (ADR-0016)", async () => {
		const area = await makeWorld();
		const areaId = await area(YEAR, "B", "2");
		const superadminId = await makeUser(true);
		// Someone ELSE is the area's current director, so a guard that forgot to
		// ask whose term it is would find one and pass the superadmin.
		const directorId = await makeUser();
		await openTerm(areaId, directorId);
		await expect(
			requireAreaDirector(directorId, areaId),
		).resolves.toBeUndefined();

		await expect(requireAreaDirector(superadminId, areaId)).rejects.toThrow(
			exact(NO_PERMISSION_MESSAGE),
		);
	});

	it("refuses an id that is not a uuid, with the same message and without asking the database", async () => {
		const userId = await makeUser();
		await expect(requireAreaDirector(userId, "not-a-uuid")).rejects.toThrow(
			exact(NO_PERMISSION_MESSAGE),
		);
	});

	it("refuses an area that does not exist the same way as one the caller may not read", async () => {
		const userId = await makeUser();
		await expect(requireAreaDirector(userId, randomUUID())).rejects.toThrow(
			exact(NO_PERMISSION_MESSAGE),
		);
	});
});

describe.skipIf(!hasTestDb)("getAreaHealth (#1119)", () => {
	afterEach(teardown);

	const read = (areaId: string) =>
		(getAreaHealth as Fn)({ data: { areaId } }) as Promise<AreaHealthResult>;

	it("gives a director their area's health and refuses them every other area", async () => {
		const area = await makeWorld();
		const areaA = await area(YEAR, "B", "2");
		const areaB = await area(YEAR, "C", "3");
		await testDb
			.insert(areaClubs)
			.values({ areaId: areaA, name: "Name-only Club", clubNumber: "7654321" });
		const userId = await makeUser();
		await openTerm(areaA, userId);
		sessionUserId = userId;

		const { health, visits } = await read(areaA);
		expect(visits).toEqual({});
		expect(health.areaId).toBe(areaA);
		expect(health.label).toBe("B2");
		expect(health.clubs).toHaveLength(1);

		await expect(read(areaB)).rejects.toThrow(exact(NO_PERMISSION_MESSAGE));
	});

	it("refuses an ended term, and a current term on last year's area", async () => {
		const area = await makeWorld();
		const ended = await area(YEAR, "B", "2");
		const lastYear = await area(YEAR - 1, "C", "3");
		const userId = await makeUser();
		const termId = await openTerm(ended, userId);
		await openTerm(lastYear, userId);
		sessionUserId = userId;
		// Control: the open term reads.
		await expect(read(ended)).resolves.toMatchObject({
			health: { areaId: ended },
		});

		await endTerm(termId);

		await expect(read(ended)).rejects.toThrow(exact(NO_PERMISSION_MESSAGE));
		await expect(read(lastYear)).rejects.toThrow(exact(NO_PERMISSION_MESSAGE));
	});

	it("refuses a superadmin with no term, who reads the same numbers through previewConsoleArea", async () => {
		const area = await makeWorld();
		const areaId = await area(YEAR, "B", "2");
		const superadminId = await makeUser(true);
		sessionUserId = superadminId;

		await expect(read(areaId)).rejects.toThrow(exact(NO_PERMISSION_MESSAGE));

		const preview = (await (previewConsoleArea as Fn)({
			data: { areaId },
		})) as AreaHealthResult;
		expect(preview.health.areaId).toBe(areaId);
		expect(preview.health.label).toBe("B2");
		expect(preview.visits).toEqual({});
	});

	it("refuses a director the console preview: it is the superadmin's, not the role's", async () => {
		const area = await makeWorld();
		const areaId = await area(YEAR, "B", "2");
		const userId = await makeUser();
		await openTerm(areaId, userId);
		sessionUserId = userId;
		// Control: the director's own read of the same area works.
		await expect(read(areaId)).resolves.toMatchObject({
			health: { areaId },
		});

		await expect(
			(previewConsoleArea as Fn)({ data: { areaId } }),
		).rejects.toThrow(exact(NO_PERMISSION_MESSAGE));
	});

	it("answers EVERY input that is not a lookup-able area id with the one refusal, never a schema message", async () => {
		const area = await makeWorld();
		const areaId = await area(YEAR, "B", "2");
		const userId = await makeUser();
		await openTerm(areaId, userId);
		sessionUserId = userId;
		// Control: a valid id from the same user reads.
		await expect(read(areaId)).resolves.toMatchObject({
			health: { areaId },
		});

		const invalid: unknown[] = [
			undefined,
			null,
			"not-an-object",
			{},
			{ areaId: undefined },
			{ areaId: 42 },
			{ areaId: "x".repeat(101) },
			{ areaId: "x".repeat(100_000) },
			{ areaId: "not-a-uuid" },
			{ areaId: "" },
		];
		for (const data of invalid) {
			// The validator throws before the handler runs; a client sees that as a
			// rejection, so the call is wrapped to read it the same way.
			await expect(
				Promise.resolve().then(() => (getAreaHealth as Fn)({ data })),
				JSON.stringify(data)?.slice(0, 40),
			).rejects.toThrow(exact(NO_PERMISSION_MESSAGE));
		}
	});

	it("refuses nobody signed in with the sign-in message, before it reads any area", async () => {
		const area = await makeWorld();
		const areaId = await area(YEAR, "B", "2");
		sessionUserId = null;

		await expect(read(areaId)).rejects.toThrow(
			"You need to be signed in to do that.",
		);
	});
});

describe.skipIf(!hasTestDb)("getAuthContext().areas (#1119)", () => {
	afterEach(teardown);

	const context = () =>
		(getAuthContext as Fn)({
			data: undefined,
		}) as Promise<AuthContextResult>;

	it("lists a current term, sorted by label, and not an ended one or last year's", async () => {
		const area = await makeWorld();
		const c3 = await area(YEAR, "C", "3");
		const b2 = await area(YEAR, "B", "2");
		const ended = await area(YEAR, "D", "4");
		const lastYear = await area(YEAR - 1, "E", "5");
		const userId = await makeUser();
		await openTerm(c3, userId);
		await openTerm(b2, userId);
		await endTerm(await openTerm(ended, userId));
		await openTerm(lastYear, userId);
		sessionUserId = userId;

		const { areas: listed } = await context();

		expect(listed).toEqual([
			{ id: b2, label: "B2" },
			{ id: c3, label: "C3" },
		]);
	});

	it("is empty for a user with no term, and for nobody signed in", async () => {
		const userId = await makeUser();
		sessionUserId = userId;
		expect((await context()).areas).toEqual([]);

		sessionUserId = null;
		expect((await context()).areas).toEqual([]);
	});

	it("does not list an area for a term on NEXT year's division", async () => {
		const area = await makeWorld();
		const nextYear = await area(YEAR + 1, "B", "2");
		const userId = await makeUser();
		await openTerm(nextYear, userId);
		sessionUserId = userId;

		expect((await context()).areas).toEqual([]);
	});

	it("never blanks the shell: a failing area read yields no entries and the rest of the context", async () => {
		const area = await makeWorld();
		const areaId = await area(YEAR, "B", "2");
		const userId = await makeUser();
		await openTerm(areaId, userId);
		sessionUserId = userId;
		// Control: the read works, so the empty list below is the catch and not a
		// user with no term.
		expect((await context()).areas).toEqual([{ id: areaId, label: "B2" }]);

		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		areaRead.failing = true;
		try {
			const ctx = await context();
			expect(ctx.areas).toEqual([]);
			expect(ctx.user?.id).toBe(userId);
			expect(logged).toHaveBeenCalledWith(
				expect.stringContaining("area read failed"),
				expect.any(Error),
			);
		} finally {
			areaRead.failing = false;
			logged.mockRestore();
		}
	});

	it("does not list an area for a superadmin with no term", async () => {
		const area = await makeWorld();
		await area(YEAR, "B", "2");
		const superadminId = await makeUser(true);
		sessionUserId = superadminId;

		expect((await context()).areas).toEqual([]);
	});
});

describe.skipIf(!hasTestDb)(
	"the role grants nothing but the counts (#1119)",
	() => {
		afterEach(teardown);

		/** A club in an area, and a director of that area who is not in it. */
		async function directorOutsideClub() {
			const seed = await seedClub();
			created.clubs.push(seed.clubId);
			const area = await makeWorld();
			const areaId = await area(YEAR, "B", "2");
			await testDb
				.insert(areaClubs)
				.values({ areaId, clubId: seed.clubId, name: "Test Club" });
			const directorId = await makeUser();
			await openTerm(areaId, directorId);
			return { seed, areaId, directorId };
		}

		it("refuses the director every club guard, with the same message a stranger gets", async () => {
			const { seed, directorId } = await directorOutsideClub();
			const strangerId = await makeUser();
			// Control: the club's own admin passes every one of these.
			await expect(
				guards.requireClubRole(seed.adminUserId, seed.clubId, ["admin"]),
			).resolves.toBeDefined();

			const asks = [
				(id: string) => guards.requireMembership(id, seed.clubId),
				(id: string) => guards.requireClubRole(id, seed.clubId, ["admin"]),
				(id: string) => guards.requireClubViewAccess(id, seed.clubId),
				(id: string) => guards.requireClubAdminView(id, seed.clubId),
			];
			for (const ask of asks) {
				const stranger = await ask(strangerId).then(
					() => null,
					(e: Error) => e.message,
				);
				const director = await ask(directorId).then(
					() => null,
					(e: Error) => e.message,
				);
				// Refused at all, and identically to a user with no term.
				expect(stranger).not.toBeNull();
				expect(director).toBe(stranger);
			}
		});

		it("answers a public reader for the director as it answers a signed-out visitor", async () => {
			const { seed, directorId } = await directorOutsideClub();
			const roster = () =>
				(listMembers as Fn)({ data: seed.clubId }) as Promise<unknown>;

			sessionUserId = null;
			const signedOut = await roster();
			sessionUserId = directorId;
			const asDirector = await roster();

			// Control: the roster is not empty, so equal is not "both empty".
			expect(Array.isArray(signedOut) ? signedOut.length : 0).toBeGreaterThan(
				0,
			);
			expect(JSON.stringify(asDirector)).toBe(JSON.stringify(signedOut));
		});
	},
);
