/**
 * DB logic for Pathways sync (spec 2026-07-06). Upserts paths (by course_code),
 * resolves each member-path to a Person (stored Base Camp id first, then a
 * unique email — ADR-0008 email fallback), and mirrors per-level counts.
 * Unmatched rows are reported, never auto-created. Kept in a `-logic.ts` so
 * `#/db` never leaks into the client bundle (server-modules guard).
 */
import { eq, sql } from "drizzle-orm";
import { db } from "#/db";
import {
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

/** Resolve a Person id: stored Base Camp id → unique email → null (unmatched). */
async function resolvePersonId(row: ParsedMemberPath): Promise<string | null> {
	const byBc = await db
		.select({ id: people.id })
		.from(people)
		.where(eq(people.basecampUserId, row.basecampUserId));
	if (byBc.length === 1) return byBc[0].id;

	if (!row.email) return null;
	const byEmail = await db
		.select({ id: people.id })
		.from(people)
		.where(sql`lower(${people.email}) = ${row.email}`);
	if (byEmail.length !== 1) return null; // 0 or ambiguous → unmatched

	// First match: persist the durable Base Camp id.
	await db
		.update(people)
		.set({ basecampUserId: row.basecampUserId })
		.where(eq(people.id, byEmail[0].id));
	return byEmail[0].id;
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
	return e.id;
}

export async function syncClubProgress(
	rows: ParsedMemberPath[],
): Promise<SyncResult> {
	const result: SyncResult = { matched: 0, pathsUpserted: 0, unmatched: [] };
	const seenPaths = new Set<string>();

	for (const row of rows) {
		const personId = await resolvePersonId(row);
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
