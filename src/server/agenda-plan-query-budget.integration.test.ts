/**
 * Planning 52 dates costs what planning one costs (#808).
 *
 * `plan()` runs on the MCP preview, on every render of the confirm page, and
 * again inside the apply transaction **while the club's advisory lock is held**
 * — where `lock.ts` allows a 5s wait and `src/db/index.ts` takes a pool of 10
 * shared by the whole app. A per-date lookup would put 52 round trips inside
 * that lock, which is the shape that starves unrelated requests rather than
 * merely being slow.
 *
 * This invariant has NO surface in the returned plan: the naive loop and the
 * single grouping pass produce byte-identical results, so an assertion about
 * the result cannot fail. For a redundant query the observable is the QUERY —
 * see `src/test/query-spy.ts`.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/agenda-plan-query-budget.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubMeetingRecurrence,
	clubs,
	meetings,
	roleDefinitions,
} from "#/db/schema";
import { zonedWallTimeToUtc } from "#/lib/datetime";
import { MAX_BATCH } from "#/lib/meeting-recurrence";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";
import { readsOf, statementsDuring } from "#/test/query-spy";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { plan } = await import("#/server/agenda-plan");

/** 52 consecutive Tuesdays from a fixed date, so nothing moves with the clock. */
function tuesdays(count: number): string[] {
	const out: string[] = [];
	const d = new Date("2027-03-02T00:00:00Z");
	for (let i = 0; i < count; i++) {
		out.push(d.toISOString().slice(0, 10));
		d.setUTCDate(d.getUTCDate() + 7);
	}
	return out;
}

describe.skipIf(!hasTestDb)("the agenda planner's query budget", () => {
	let seed: SeededClub;
	let club: { clubId: string; timezone: string };

	beforeEach(async () => {
		seed = await seedClub();
		const [row] = await testDb
			.select({ timezone: clubs.timezone })
			.from(clubs)
			.where(eq(clubs.id, seed.clubId));
		club = {
			clubId: seed.clubId,
			timezone: row?.timezone ?? "America/Chicago",
		};
		await testDb.insert(clubMeetingRecurrence).values({
			clubId: seed.clubId,
			mode: "interval",
			weekday: 2,
			intervalWeeks: 1,
			anchorDate: "2027-03-02",
			timeOfDay: "19:00",
			enabled: false,
		});
		// Half the dates already have a meeting, so both branches of the planner
		// are exercised by the 52-date run rather than only the cheap one.
		const existing = tuesdays(MAX_BATCH).filter((_, i) => i % 2 === 0);
		await testDb.insert(meetings).values(
			existing.map((date) => ({
				clubId: seed.clubId,
				scheduledAt: zonedWallTimeToUtc(`${date}T19:00`, club.timezone),
				theme: "Old",
			})),
		);
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("issues the same number of statements for 1 date and for 52", async () => {
		const dates = tuesdays(MAX_BATCH);
		const one = await statementsDuring(() =>
			plan(testDb, club, [{ date: dates[0] as string, theme: "Harvest" }]),
		);
		const many = await statementsDuring(() =>
			plan(
				testDb,
				club,
				dates.map((date) => ({ date, theme: "Harvest" })),
			),
		);

		// Non-empty first: a driver change that broke the spy would report zero
		// statements and make the comparison below pass vacuously.
		expect(one.length).toBeGreaterThan(0);
		expect(readsOf(one, "meetings").length).toBeGreaterThan(0);
		expect(readsOf(one, "clubs").length).toBeGreaterThan(0);

		expect(
			many.length,
			`52 dates issued ${many.length} statements against ${one.length} for one. The planner must group the club's meetings in memory rather than looking each date up.`,
		).toBe(one.length);
	});

	it("reads the club once and the meetings once, whatever the batch", async () => {
		// The budget a reviewer can count: the club row (LEFT JOINed to its
		// standing rule) and the club's meetings. Role definitions are
		// deliberately NOT read here — a plan says "create a meeting on that
		// date" and the slots are generated at APPLY time, so reading the
		// template on every render would be work thrown away every time.
		const statements = await statementsDuring(() =>
			plan(
				testDb,
				club,
				tuesdays(MAX_BATCH).map((date) => ({ date, theme: "Harvest" })),
			),
		);
		expect(readsOf(statements, "clubs")).toHaveLength(1);
		expect(readsOf(statements, "meetings")).toHaveLength(1);
		expect(readsOf(statements, "role_definitions")).toHaveLength(0);
		expect(statements).toHaveLength(2);
	});

	it("the spy can SEE a role_definitions read, so the zero above means something", () => {
		// The control the assertion above needs, and it is not optional.
		// `statementsDuring` spies on the POOL, so a table read only ever inside a
		// transaction is invisible to it — and a `toHaveLength(0)` on such a table
		// passes whether or not the read happened. A control for a NEIGHBOURING
		// table is not a control for this one.
		//
		// So prove the pattern matches a real read of THIS table through THIS
		// harness. With this case green, the zero above is a measurement; without
		// it, the zero is just a regex that never matched anything.
		return statementsDuring(() =>
			testDb
				.select({ id: roleDefinitions.id })
				.from(roleDefinitions)
				.where(eq(roleDefinitions.clubId, seed.clubId)),
		).then((statements) => {
			expect(readsOf(statements, "role_definitions")).toHaveLength(1);
		});
	});

	it("plans all 52 correctly while doing it", async () => {
		// The budget is only worth asserting if the cheap version is also RIGHT.
		// A planner that issued two queries and classified everything as a create
		// would satisfy every count above.
		const dates = tuesdays(MAX_BATCH);
		const { plan: p, blocking } = await plan(
			testDb,
			club,
			dates.map((date) => ({ date, theme: "Harvest" })),
		);
		expect(blocking).toStrictEqual([]);
		expect(p.lines).toHaveLength(MAX_BATCH);
		expect(p.lines.filter((l) => l.action === "update")).toHaveLength(26);
		expect(p.lines.filter((l) => l.action === "create")).toHaveLength(26);
	});
});
