// Person-identity DB logic ("one human = one Person across clubs" — see
// docs/spec + plan on this branch). Split out from any createServerFn wrapper
// so it stays directly integration-testable and its `#/db` import never leaks
// into the client bundle (the server-modules.guard.test.ts rule; see
// `members-logic.ts`). Later tasks add `mergePeople`/detection to this file.
import { inArray, sql } from "drizzle-orm";
import { db } from "#/db";
import { pathEnrollments, people, speeches } from "#/db/schema";
import { type KeeperCandidate, pickKeeper } from "#/lib/person-identity";

// A transaction handle (or the base db) — both expose the query builder we use.
type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

/**
 * The best existing Person for a create-club/dedupe email match (Rule B):
 * case-insensitive email lookup, ranked by the shared keeper heuristic
 * (`pickKeeper`) when more than one Person shares the address. Returns null on
 * no match. Runs against `conn` so a caller mid-transaction can pass its `tx`.
 */
export async function findBestPersonByEmail(
	email: string,
	conn: Conn = db,
): Promise<string | null> {
	const normalized = email.trim().toLowerCase();
	if (!normalized) return null;

	const rows = await conn
		.select({
			id: people.id,
			userId: people.userId,
			originalJoinDate: people.originalJoinDate,
		})
		.from(people)
		.where(sql`lower(${people.email}) = ${normalized}`);
	if (rows.length === 0) return null;
	if (rows.length === 1) return rows[0].id;

	const ids = rows.map((r) => r.id);
	const history = await historyCounts(conn, ids);
	const candidates: KeeperCandidate[] = rows.map((r) => ({
		id: r.id,
		linked: r.userId != null,
		historyCount: history.get(r.id) ?? 0,
		originalJoinDate: r.originalJoinDate,
	}));
	return pickKeeper(candidates)?.id ?? null;
}

/** speeches + Pathways enrollments per person id (absent ids map to 0 via the
 *  caller's `?? 0` default — this only returns ids with at least one row). */
export async function historyCounts(
	conn: Conn,
	personIds: string[],
): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	if (personIds.length === 0) return out;

	const speechCounts = await conn
		.select({ id: speeches.personId, n: sql<number>`count(*)::int` })
		.from(speeches)
		.where(inArray(speeches.personId, personIds))
		.groupBy(speeches.personId);
	const enrollmentCounts = await conn
		.select({ id: pathEnrollments.personId, n: sql<number>`count(*)::int` })
		.from(pathEnrollments)
		.where(inArray(pathEnrollments.personId, personIds))
		.groupBy(pathEnrollments.personId);

	for (const row of [...speechCounts, ...enrollmentCounts]) {
		out.set(row.id, (out.get(row.id) ?? 0) + row.n);
	}
	return out;
}
