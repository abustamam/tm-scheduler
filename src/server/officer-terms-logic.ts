// Officer-term DB logic (#100), kept OUT of any createServerFn module so `#/db`
// (→ `pg` → `Buffer`) never leaks into the client bundle. `officer_terms` is the
// source of truth for who holds which office; a membership's CURRENT office(s)
// are DERIVED here as its open terms (term_end IS NULL). A membership may hold
// several offices at once (one open row each) and closed terms are retained as
// history. See members-logic.ts for the same split rationale.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "#/db";
import { members, officerTerms } from "#/db/schema";
import { type OfficerPosition, officerRank } from "#/lib/officers";

// Accepts the shared `db` client or a drizzle transaction handle (`tx`) so
// callers can reconcile terms inside the same transaction that edits the member.
type DbClient =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/** Sort officer positions into canonical line-up order (President first). */
function sortByRank(positions: OfficerPosition[]): OfficerPosition[] {
	return [...positions].sort((a, b) => officerRank(a) - officerRank(b));
}

/**
 * Current office(s) for a set of memberships, keyed by membership id — derived
 * from open terms (term_end IS NULL). Each membership's positions come back in
 * canonical order; memberships with no open term are simply absent from the map
 * (callers default to an empty array).
 */
export async function currentOfficersByMember(
	membershipIds: string[],
	client: DbClient = db,
): Promise<Map<string, OfficerPosition[]>> {
	const map = new Map<string, OfficerPosition[]>();
	if (membershipIds.length === 0) return map;
	const rows = await client
		.select({
			membershipId: officerTerms.membershipId,
			position: officerTerms.position,
		})
		.from(officerTerms)
		.where(
			and(
				inArray(officerTerms.membershipId, membershipIds),
				isNull(officerTerms.termEnd),
			),
		);
	for (const r of rows) {
		const list = map.get(r.membershipId) ?? [];
		list.push(r.position);
		map.set(r.membershipId, list);
	}
	for (const [id, list] of map) map.set(id, sortByRank(list));
	return map;
}

/**
 * Current office(s) for one membership (convenience over
 * {@link currentOfficersByMember}), in canonical order.
 */
export async function currentOfficersFor(
	membershipId: string,
	client: DbClient = db,
): Promise<OfficerPosition[]> {
	const map = await currentOfficersByMember([membershipId], client);
	return map.get(membershipId) ?? [];
}

/** One club's current officers (open terms), with the member's name, ordered
 *  President → Immediate Past President then by name. Backs the printable
 *  agenda's officer grid. A member holding two offices appears once per office. */
export async function currentOfficersForClub(
	clubId: string,
	client: DbClient = db,
): Promise<{ position: OfficerPosition; name: string }[]> {
	const rows = await client
		.select({
			position: officerTerms.position,
			name: members.name,
			status: members.status,
		})
		.from(officerTerms)
		.innerJoin(members, eq(members.id, officerTerms.membershipId))
		.where(and(eq(members.clubId, clubId), isNull(officerTerms.termEnd)));
	return rows
		.filter((r) => r.status !== "inactive")
		.sort(
			(a, b) =>
				officerRank(a.position) - officerRank(b.position) ||
				a.name.localeCompare(b.name),
		)
		.map((r) => ({ position: r.position, name: r.name }));
}

/**
 * Make a membership's OPEN offices exactly `desired`: open a term for each
 * desired office not already open, and CLOSE (set term_end = now, retaining
 * history) each open office no longer desired. Idempotent — a no-op when the
 * open set already equals `desired`. Runs on whatever client/tx is passed so it
 * can share the caller's transaction. Returns what changed (for activity logs).
 */
export async function reconcileOfficerTerms(
	client: DbClient,
	membershipId: string,
	desired: OfficerPosition[],
): Promise<{ added: OfficerPosition[]; closed: OfficerPosition[] }> {
	const desiredSet = new Set(desired);
	const open = await client
		.select({ id: officerTerms.id, position: officerTerms.position })
		.from(officerTerms)
		.where(
			and(
				eq(officerTerms.membershipId, membershipId),
				isNull(officerTerms.termEnd),
			),
		);
	const openPositions = new Set(open.map((r) => r.position));
	const now = new Date();

	const closed: OfficerPosition[] = [];
	for (const r of open) {
		if (!desiredSet.has(r.position)) {
			await client
				.update(officerTerms)
				.set({ termEnd: now, updatedAt: now })
				.where(eq(officerTerms.id, r.id));
			closed.push(r.position);
		}
	}

	const added: OfficerPosition[] = [];
	for (const position of desired) {
		if (!openPositions.has(position)) {
			await client
				.insert(officerTerms)
				.values({ membershipId, position, termStart: now });
			added.push(position);
		}
	}

	return { added: sortByRank(added), closed: sortByRank(closed) };
}

/**
 * Open a single office for a membership if it isn't already open (idempotent).
 * Used by imports: it only ever ADDS, so an in-app assignment is never removed.
 * Returns true when a new term was opened.
 */
export async function openOfficerTermIfAbsent(
	client: DbClient,
	membershipId: string,
	position: OfficerPosition,
	termStart: Date | null,
): Promise<boolean> {
	const [existing] = await client
		.select({ id: officerTerms.id })
		.from(officerTerms)
		.where(
			and(
				eq(officerTerms.membershipId, membershipId),
				eq(officerTerms.position, position),
				isNull(officerTerms.termEnd),
			),
		)
		.limit(1);
	if (existing) return false;
	await client
		.insert(officerTerms)
		.values({ membershipId, position, termStart });
	return true;
}
