/**
 * The `clubs_table_topics_window_check` CHECK constraint (#679).
 *
 * The window's invariants already hold in zod on the write path and are
 * re-checked by `hasTableTopicsLimits` before anything renders, so this
 * constraint is about the writer neither of those layers can reach: a seed
 * script, a support data fix, a bulk import. `(60, NULL)`, `(150, 60)` and
 * `(0, 99999)` were all storable, and a stored-but-ignored row is its own
 * failure — an admin who asked for 2:30, sees 2:30 in the form on reload, and
 * gets 1:00–2:00 on every printed sheet with nothing anywhere saying why.
 *
 * Written against the DATABASE deliberately: every one of these cases already
 * has a `safeParse` assertion in `club-agenda-settings-schema.test.ts`, and
 * that suite would pass unchanged if this constraint were never created. The
 * observable here is the driver's error, so these go through `testDb.insert`
 * and `testDb.update` rather than through any application seam — an
 * application seam is exactly what the constraint exists to be independent of.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/club-table-topics-check.integration.test.ts
 *
 * NOTE: `db:push` does not update an existing CHECK's predicate. After a change
 * to it, verify by hand:
 *   select conname, pg_get_constraintdef(oid) from pg_constraint
 *     where conrelid = 'clubs'::regclass;
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { clubs } from "#/db/schema";
import { MAX_TABLE_TOPICS_SECONDS } from "#/lib/table-topics-limits";
import { hasTestDb, testDb } from "#/test/db";

/** SQLSTATE 23514 — a check constraint rejected the row. Asserted rather than
 *  merely "it threw", so a typo in a column name (42703) cannot pass as the
 *  constraint doing its job. */
const CHECK_VIOLATION = "23514";

/** Per-run suffix: vitest runs test FILES in parallel against one shared
 *  database, so a fixed slug collides across suites. */
const RUN = randomUUID().slice(0, 8);

/** Only the ids this file created; `clubs` is shared. */
const created: string[] = [];
let n = 0;

async function insertClub(
	minSeconds: number | null,
	maxSeconds: number | null,
): Promise<string> {
	n += 1;
	const [row] = await testDb
		.insert(clubs)
		.values({
			name: `TT check ${RUN} ${n}`,
			slug: `tt-check-${RUN}-${n}`,
			tableTopicsMinSeconds: minSeconds,
			tableTopicsMaxSeconds: maxSeconds,
		})
		.returning({ id: clubs.id });
	created.push(row.id);
	return row.id;
}

function sqlState(err: unknown): unknown {
	const direct = (err as { code?: unknown } | null)?.code;
	return direct ?? (err as { cause?: { code?: unknown } } | null)?.cause?.code;
}

async function refusal(
	minSeconds: number | null,
	maxSeconds: number | null,
): Promise<unknown> {
	try {
		await insertClub(minSeconds, maxSeconds);
	} catch (err) {
		return sqlState(err);
	}
	return null;
}

describe.skipIf(!hasTestDb)("clubs Table Topics window CHECK (#679)", () => {
	afterEach(async () => {
		if (created.length === 0) return;
		await testDb.delete(clubs).where(inArray(clubs.id, created.splice(0)));
	});

	it("stores a stated window, and the cleared state", async () => {
		// The vacuity control, and it is not optional: a constraint written as
		// plain `false` would satisfy every refusal below.
		const stated = await insertClub(60, 150);
		const cleared = await insertClub(null, null);
		const rows = await testDb
			.select({
				id: clubs.id,
				min: clubs.tableTopicsMinSeconds,
				max: clubs.tableTopicsMaxSeconds,
			})
			.from(clubs)
			.where(inArray(clubs.id, [stated, cleared]));
		// Scoped to this file's own rows — `clubs` is shared with every other
		// suite running in parallel — and looked up BY ID rather than by select
		// order, which Postgres does not promise.
		const byId = new Map(rows.map((r) => [r.id, [r.min, r.max]]));
		expect(byId.get(stated)).toEqual([60, 150]);
		expect(byId.get(cleared)).toEqual([null, null]);
	});

	it("refuses a HALF-stated window, in both directions", async () => {
		expect(await refusal(60, null)).toBe(CHECK_VIOLATION);
		expect(await refusal(null, 150)).toBe(CHECK_VIOLATION);
	});

	it("refuses an inverted or equal window", async () => {
		expect(await refusal(150, 60)).toBe(CHECK_VIOLATION);
		expect(await refusal(90, 90)).toBe(CHECK_VIOLATION);
	});

	it("refuses past the ceiling, at the ABSOLUTE boundary", async () => {
		// Literals on both sides. `<= MAX_TABLE_TOPICS_SECONDS` would pass for
		// every value of the constant, and the SQL holds a frozen copy of the
		// number, so this is the assertion that catches the two disagreeing.
		expect(MAX_TABLE_TOPICS_SECONDS).toBe(600);
		expect(await refusal(60, 601)).toBe(CHECK_VIOLATION);
		expect(await refusal(0, 99999)).toBe(CHECK_VIOLATION);
		// 600 is IN. Without this the ceiling could be off by one in the SQL and
		// every refusal above would still pass.
		await expect(insertClub(60, 600)).resolves.toBeTypeOf("string");
	});

	it("refuses a negative minimum", async () => {
		// `hasTableTopicsLimits` refuses it at render, so a stored one could only
		// ever be a row the product declines to use.
		expect(await refusal(-1, 150)).toBe(CHECK_VIOLATION);
	});

	it("guards UPDATE as well as INSERT", async () => {
		// The support-data-fix shape the constraint is actually for: a valid row
		// edited into an invalid one by a writer that never sees the zod schema.
		const id = await insertClub(60, 150);
		let code: unknown = null;
		try {
			await testDb
				.update(clubs)
				.set({ tableTopicsMaxSeconds: null })
				.where(eq(clubs.id, id));
		} catch (err) {
			code = sqlState(err);
		}
		expect(code).toBe(CHECK_VIOLATION);
		// And the row is untouched — a refused UPDATE must not half-apply.
		const [row] = await testDb
			.select({
				min: clubs.tableTopicsMinSeconds,
				max: clubs.tableTopicsMaxSeconds,
			})
			.from(clubs)
			.where(eq(clubs.id, id));
		expect([row.min, row.max]).toEqual([60, 150]);
	});
});
