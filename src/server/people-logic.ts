// Person-identity read/dedupe helpers ("one human = one Person across clubs" —
// see docs/spec + plan on this branch): the case-insensitive email → best-Person
// lookup and the history-count aggregate that feed create-club dedupe (Rule B)
// and, later, merge-candidate detection. The IRREVERSIBLE write path (the actual
// Person merge) lives in its sibling `people-merge-logic.ts`. Split out from any
// createServerFn wrapper so it stays directly integration-testable and its
// `#/db` import never leaks into the client bundle (the server-modules.guard.test.ts
// rule; see `members-logic.ts`).
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "#/db";
import { clubs, members, pathEnrollments, people, speeches } from "#/db/schema";
import { type KeeperCandidate, pickKeeper } from "#/lib/person-identity";
import { checkMergeBlocks } from "#/server/people-merge-logic";

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

// --- Duplicate detection & read-only merge preview (Task 7) ---------------
// The superadmin-facing read layer on top of the merge machinery:
// `listDuplicatePeople` groups Persons sharing a case-insensitive email (the
// same "Rule B" match `findBestPersonByEmail` uses at create-club time, here
// surfaced for a human instead of auto-resolved), `searchPeopleForMerge` lets
// an admin free-text search for a merge candidate that doesn't share an email
// (e.g. a typo'd duplicate), and `getMergePreview` shows what a merge WOULD do
// — including the block reason — without writing anything. The block check
// itself (`checkMergeBlocks`) and the actual write path (`mergePeople`) stay
// in the sibling `people-merge-logic.ts`; this module only reads.

export interface DuplicatePerson {
	id: string;
	name: string;
	email: string | null;
	linked: boolean;
	historyCount: number;
	clubs: string[];
}

export interface DuplicateGroup {
	email: string;
	people: DuplicatePerson[];
}

/** Every group of 2+ Persons sharing a case-insensitive, non-blank email. */
export async function listDuplicatePeople(): Promise<DuplicateGroup[]> {
	const dupEmails = await db
		.select({ email: sql<string>`lower(${people.email})` })
		.from(people)
		.where(
			sql`${people.email} is not null and length(trim(${people.email})) > 0`,
		)
		.groupBy(sql`lower(${people.email})`)
		.having(sql`count(*) > 1`);

	const groups: DuplicateGroup[] = [];
	for (const { email } of dupEmails) {
		groups.push({ email, people: await peopleForEmail(email) });
	}
	return groups;
}

/**
 * Free-text (name or email substring, case-insensitive) search for a merge
 * candidate. Short-circuits below 2 characters — too broad to be useful and
 * cheap to reject before hitting the database.
 */
export async function searchPeopleForMerge(
	query: string,
): Promise<DuplicatePerson[]> {
	const trimmed = query.trim().toLowerCase();
	if (trimmed.length < 2) return [];
	const q = `%${trimmed}%`;
	const rows = await db
		.select({
			id: people.id,
			name: people.name,
			email: people.email,
			userId: people.userId,
		})
		.from(people)
		.where(
			sql`lower(${people.name}) like ${q} or lower(${people.email}) like ${q}`,
		)
		.orderBy(people.name, people.id)
		.limit(25);
	return decorate(rows);
}

export interface MergePreview {
	/** A hard-block reason from `checkMergeBlocks`, or null when safe to merge. */
	block: string | null;
	keeper: DuplicatePerson;
	absorbed: DuplicatePerson;
	movedCounts: {
		memberships: number;
		collapsed: number;
		speeches: number;
		enrollments: number;
	};
}

/**
 * Read-only preview of what `mergePeople({ keeperPersonId, absorbedPersonId })`
 * would do: the block reason (if any — reuses `checkMergeBlocks` rather than
 * re-implementing it), both Persons decorated for display, and the counts a
 * real merge would move. Never writes.
 */
export async function getMergePreview(
	keeperId: string,
	absorbedId: string,
): Promise<MergePreview> {
	const rows = await db
		.select()
		.from(people)
		.where(inArray(people.id, [keeperId, absorbedId]));
	const keeper = rows.find((p) => p.id === keeperId);
	const absorbed = rows.find((p) => p.id === absorbedId);
	if (!keeper || !absorbed) throw new Error("Person not found.");

	const [keeperView, absorbedView] = await decorate([
		{
			id: keeper.id,
			name: keeper.name,
			email: keeper.email,
			userId: keeper.userId,
		},
		{
			id: absorbed.id,
			name: absorbed.name,
			email: absorbed.email,
			userId: absorbed.userId,
		},
	]);
	if (!keeperView || !absorbedView) throw new Error("Person not found.");

	// Same membership-fate accounting mergePeople does: a shared club collapses
	// into one row, an absorbed-only club is a plain re-point.
	const absorbedMemberships = await db
		.select({ clubId: members.clubId })
		.from(members)
		.where(eq(members.personId, absorbedId));
	const keeperClubIds = new Set(
		(
			await db
				.select({ clubId: members.clubId })
				.from(members)
				.where(eq(members.personId, keeperId))
		).map((m) => m.clubId),
	);
	const collapsed = absorbedMemberships.filter((m) =>
		keeperClubIds.has(m.clubId),
	).length;

	const [speechCount] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(speeches)
		.where(eq(speeches.personId, absorbedId));
	const [enrollmentCount] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(pathEnrollments)
		.where(eq(pathEnrollments.personId, absorbedId));

	return {
		block: checkMergeBlocks(keeper, absorbed),
		keeper: keeperView,
		absorbed: absorbedView,
		movedCounts: {
			memberships: absorbedMemberships.length - collapsed,
			collapsed,
			speeches: speechCount?.n ?? 0,
			enrollments: enrollmentCount?.n ?? 0,
		},
	};
}

/** All Persons sharing a (lowercased) email, decorated for display. */
async function peopleForEmail(email: string): Promise<DuplicatePerson[]> {
	const rows = await db
		.select({
			id: people.id,
			name: people.name,
			email: people.email,
			userId: people.userId,
		})
		.from(people)
		.where(sql`lower(${people.email}) = ${email}`)
		.orderBy(people.name, people.id);
	return decorate(rows);
}

/**
 * Decorate bare Person rows with what the superadmin duplicate/merge UI needs:
 * `linked` (has a sign-in account), `historyCount` (speeches + enrollments,
 * via the shared `historyCounts`), and `clubs` (the NAMES of every club this
 * Person holds a membership in). Club names are fetched in ONE batched query
 * across all the given ids (not N+1) and grouped in JS. The returned array's
 * order matches `rows`' order.
 */
async function decorate(
	rows: {
		id: string;
		name: string;
		email: string | null;
		userId: string | null;
	}[],
): Promise<DuplicatePerson[]> {
	const ids = rows.map((r) => r.id);
	if (ids.length === 0) return [];

	const [clubRows, history] = await Promise.all([
		db
			.select({ personId: members.personId, clubName: clubs.name })
			.from(members)
			.innerJoin(clubs, eq(members.clubId, clubs.id))
			.where(inArray(members.personId, ids)),
		historyCounts(db, ids),
	]);

	const clubsByPerson = new Map<string, string[]>();
	for (const row of clubRows) {
		const list = clubsByPerson.get(row.personId) ?? [];
		list.push(row.clubName);
		clubsByPerson.set(row.personId, list);
	}

	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		email: r.email,
		linked: r.userId != null,
		historyCount: history.get(r.id) ?? 0,
		clubs: clubsByPerson.get(r.id) ?? [],
	}));
}
