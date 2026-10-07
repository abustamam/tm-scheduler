/**
 * Every server fn in `areas.ts` refuses a signed-in non-superadmin (#1116).
 *
 * Executes the REAL `createServerFn` handlers through the minimal adapter
 * `cancelled-meeting-officer-writes.integration.test.ts` uses, with the cookie
 * → session lookup faked and nothing else: `requireUser` and `requireSuperadmin`
 * both run for real, the latter reading `user.is_superadmin` from the test
 * database. The order those two run in, relative to the logic, is pinned by
 * `areas-authz.guard.test.ts`; this proves the refusal itself, once per fn.
 *
 * The control is the superadmin: the same call, from a user whose flag is set,
 * gets through. Without it a case passes on a harness that refuses everything.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:…@localhost:5432/tm_test \
 *     bunx vitest run src/server/areas-authz.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { areaDirectors, areas, districts, divisions, user } from "#/db/schema";
import { currentProgramYear } from "#/lib/dcp";
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
// `areas.ts` declares fns with a validator and one without, so the adapter
// answers both shapes.
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

const areaFns = await import("./areas");
const { NO_PERMISSION_MESSAGE } = await import("./guards");

type Fn = (input: { data: unknown }) => Promise<unknown>;

const exact = (message: string) =>
	new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

const run = randomUUID().slice(0, 8);
// At most 8 characters: the validator refuses a longer number before the gate runs.
const DISTRICT_NUMBER = `A${run.slice(0, 7)}`;

/** One valid call per fn: valid, so the validator passes and the handler runs. */
const CALLS: Record<string, () => Promise<unknown>> = {
	listConsoleAreas: () => (areaFns.listConsoleAreas as Fn)({ data: undefined }),
	getConsoleArea: () =>
		(areaFns.getConsoleArea as Fn)({ data: { areaId: randomUUID() } }),
	createDistrict: () =>
		(areaFns.createDistrict as Fn)({ data: { number: DISTRICT_NUMBER } }),
	createDivision: () =>
		(areaFns.createDivision as Fn)({
			data: { districtId: randomUUID(), programYear: 2026, letter: "B" },
		}),
	createArea: () =>
		(areaFns.createArea as Fn)({
			data: { divisionId: randomUUID(), number: "2" },
		}),
	renameDivision: () =>
		(areaFns.renameDivision as Fn)({
			data: { divisionId: randomUUID(), letter: "C" },
		}),
	renameArea: () =>
		(areaFns.renameArea as Fn)({
			data: { areaId: randomUUID(), number: "3" },
		}),
	addAreaClub: () =>
		(areaFns.addAreaClub as Fn)({
			data: { areaId: randomUUID(), name: "Some Club" },
		}),
	linkAreaClub: () =>
		(areaFns.linkAreaClub as Fn)({ data: { areaClubId: randomUUID() } }),
	removeAreaClub: () =>
		(areaFns.removeAreaClub as Fn)({ data: { areaClubId: randomUUID() } }),
	findUserForDirector: () =>
		(areaFns.findUserForDirector as Fn)({ data: { email: "a@b.example" } }),
	assignAreaDirector: () =>
		(areaFns.assignAreaDirector as Fn)({
			data: { areaId: randomUUID(), userId: "u", displayName: "Jamie" },
		}),
	endAreaDirectorTerm: () =>
		(areaFns.endAreaDirectorTerm as Fn)({ data: { termId: randomUUID() } }),
};

describe.skipIf(!hasTestDb)("areas.ts refuses a non-superadmin (#1116)", () => {
	const userIds: string[] = [];
	let memberId: string;
	let superadminId: string;

	async function makeUser(isSuperadmin: boolean) {
		const id = randomUUID();
		await testDb.insert(user).values({
			id,
			name: "",
			email: `areas-authz-${id}@test.example`,
			emailVerified: true,
			isSuperadmin,
		});
		userIds.push(id);
		return id;
	}

	beforeEach(async () => {
		memberId = await makeUser(false);
		superadminId = await makeUser(true);
		sessionUserId = memberId;
	});

	afterEach(async () => {
		sessionUserId = null;
		await testDb.delete(districts).where(eq(districts.number, DISTRICT_NUMBER));
		await testDb.delete(user).where(inArray(user.id, userIds));
		userIds.length = 0;
	});

	it("covers every fn the module exports", () => {
		// The table below is hand-written, so a fn added to `areas.ts` without a
		// row here must fail rather than go unrefused-tested.
		expect(Object.keys(CALLS).sort()).toEqual(Object.keys(areaFns).sort());
	});

	it.each(
		Object.keys(CALLS),
	)("%s refuses a signed-in non-superadmin", async (name) => {
		await expect((CALLS[name] as () => Promise<unknown>)()).rejects.toThrow(
			exact(NO_PERMISSION_MESSAGE),
		);
	});

	it("wrote nothing for the refused create", async () => {
		await expect(CALLS.createDistrict?.()).rejects.toThrow();
		const rows = await testDb
			.select({ id: districts.id })
			.from(districts)
			.where(eq(districts.number, DISTRICT_NUMBER));
		expect(rows).toHaveLength(0);
	});

	it("pins assignedBy and endedBy to the session user, whatever the client sends", async () => {
		sessionUserId = superadminId;
		const director = await makeUser(false);
		const number = `P${run.slice(0, 7)}`;
		const { id: districtId } = (await (areaFns.createDistrict as Fn)({
			data: { number },
		})) as { id: string };
		try {
			const { id: divisionId } = (await (areaFns.createDivision as Fn)({
				data: { districtId, programYear: currentProgramYear(), letter: "B" },
			})) as { id: string };
			const { id: areaId } = (await (areaFns.createArea as Fn)({
				data: { divisionId, number: "2" },
			})) as { id: string };

			// `assignedBy` / `endedBy` are not fields of either input, so a client that
			// sends them (naming the director, say) is stripped by the validator.
			const { id: termId } = (await (areaFns.assignAreaDirector as Fn)({
				data: {
					areaId,
					userId: director,
					displayName: "Jamie",
					assignedBy: director,
				},
			})) as { id: string };
			const [opened] = await testDb
				.select({ assignedBy: areaDirectors.assignedBy })
				.from(areaDirectors)
				.where(eq(areaDirectors.id, termId));
			expect(opened?.assignedBy).toBe(superadminId);

			await (areaFns.endAreaDirectorTerm as Fn)({
				data: { termId, endedBy: director },
			});
			const [closed] = await testDb
				.select({ endedBy: areaDirectors.endedBy })
				.from(areaDirectors)
				.where(eq(areaDirectors.id, termId));
			expect(closed?.endedBy).toBe(superadminId);
		} finally {
			const divs = await testDb
				.select({ id: divisions.id })
				.from(divisions)
				.where(eq(divisions.districtId, districtId));
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
			await testDb.delete(districts).where(eq(districts.id, districtId));
		}
	});

	it("lets a superadmin through the same call, and refuses nobody signed in", async () => {
		sessionUserId = superadminId;
		await expect(CALLS.createDistrict?.()).resolves.toMatchObject({
			id: expect.any(String),
		});
		const rows = await testDb
			.select({ id: districts.id })
			.from(districts)
			.where(eq(districts.number, DISTRICT_NUMBER));
		expect(rows).toHaveLength(1);

		sessionUserId = null;
		await expect(CALLS.listConsoleAreas?.()).rejects.toThrow(
			"You need to be signed in to do that.",
		);
	});
});
