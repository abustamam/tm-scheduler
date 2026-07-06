/**
 * DB logic for Pathways sync (spec 2026-07-06). Upserts paths (by course_code),
 * resolves each member-path to a Person (stored Base Camp id first, then a
 * unique email — ADR-0008 email fallback), and mirrors per-level counts.
 * Unmatched rows are reported, never auto-created. Kept in a `-logic.ts` so
 * `#/db` never leaks into the client bundle (server-modules guard).
 *
 * Identity match is scoped to the club being synced: a Person only matches if
 * they have a `members` row for `clubId`, joined the same way every other
 * admin write path scopes to the club (see `club.ts`'s roster query). Without
 * this, a Club A admin could paste a payload containing a Club B member's
 * email/basecampUserId and claim (or overwrite) their identity across clubs.
 * A Person who exists but isn't a member of this club is reported unmatched,
 * consistent with the existing match-or-report rule.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	members,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
	people,
} from "#/db/schema";
import type { ParsedMemberPath } from "#/lib/basecamp-progress";

export interface SyncResult {
	matched: number;
	pathsUpserted: number;
	unmatched: { name: string; email: string | null; basecampUserId: string }[];
}

/**
 * Resolve a Person id: stored Base Camp id → unique email → null (unmatched).
 * Both lookups are scoped to people who have a `members` row for `clubId` —
 * a person who isn't on this club's roster can never match, no matter how
 * their Base Camp id or email compares.
 */
async function resolvePersonId(
	clubId: string,
	row: ParsedMemberPath,
): Promise<string | null> {
	const byBc = await db
		.selectDistinct({ id: people.id })
		.from(people)
		.innerJoin(
			members,
			and(eq(members.personId, people.id), eq(members.clubId, clubId)),
		)
		.where(eq(people.basecampUserId, row.basecampUserId));
	if (byBc.length === 1) return byBc[0].id;

	if (!row.email) return null;
	const byEmail = await db
		.selectDistinct({ id: people.id, basecampUserId: people.basecampUserId })
		.from(people)
		.innerJoin(
			members,
			and(eq(members.personId, people.id), eq(members.clubId, clubId)),
		)
		.where(sql`lower(${people.email}) = ${row.email}`);
	if (byEmail.length !== 1) return null; // 0 or ambiguous → unmatched

	const person = byEmail[0];
	if (person.basecampUserId === null) {
		// First match: persist the durable Base Camp id (write-once).
		await db
			.update(people)
			.set({ basecampUserId: row.basecampUserId })
			.where(eq(people.id, person.id));
		return person.id;
	}
	// Email matches a person who already has a DIFFERENT basecamp id (byBc would
	// have matched otherwise) → identity anomaly; report as unmatched, don't clobber.
	return null;
}

async function upsertPath(row: ParsedMemberPath): Promise<string> {
	const [p] = await db
		.insert(pathwaysPaths)
		.values({ courseCode: row.courseCode, name: row.pathName })
		.onConflictDoUpdate({
			target: pathwaysPaths.courseCode,
			set: { name: row.pathName },
		})
		.returning({ id: pathwaysPaths.id });
	if (!p) throw new Error("Failed to upsert path.");
	return p.id;
}

async function upsertEnrollment(
	personId: string,
	pathId: string,
): Promise<string> {
	const [e] = await db
		.insert(pathEnrollments)
		.values({ personId, pathId })
		.onConflictDoUpdate({
			target: [pathEnrollments.personId, pathEnrollments.pathId],
			set: { lastSyncedAt: new Date() },
		})
		.returning({ id: pathEnrollments.id });
	if (!e) throw new Error("Failed to upsert enrollment.");
	return e.id;
}

export async function syncClubProgress(
	clubId: string,
	rows: ParsedMemberPath[],
): Promise<SyncResult> {
	const result: SyncResult = { matched: 0, pathsUpserted: 0, unmatched: [] };
	const seenPaths = new Set<string>();

	for (const row of rows) {
		const personId = await resolvePersonId(clubId, row);
		if (!personId) {
			result.unmatched.push({
				name: row.name,
				email: row.email,
				basecampUserId: row.basecampUserId,
			});
			continue;
		}
		const pathId = await upsertPath(row);
		if (!seenPaths.has(row.courseCode)) {
			seenPaths.add(row.courseCode);
			result.pathsUpserted += 1;
		}
		const enrollmentId = await upsertEnrollment(personId, pathId);
		for (const lvl of row.levels) {
			await db
				.insert(pathLevelProgress)
				.values({
					enrollmentId,
					level: lvl.level,
					completed: lvl.completed,
					total: lvl.total,
					approved: lvl.approved,
				})
				.onConflictDoUpdate({
					target: [pathLevelProgress.enrollmentId, pathLevelProgress.level],
					set: {
						completed: lvl.completed,
						total: lvl.total,
						approved: lvl.approved,
					},
				});
		}
		result.matched += 1;
	}
	return result;
}
