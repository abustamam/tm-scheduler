import { and, asc, eq } from "drizzle-orm";
import { db } from "#/db";
import {
	members,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
	people,
} from "#/db/schema";

export interface SyncedLevel {
	level: number;
	completed: number;
	total: number;
	approved: boolean;
}

export interface PathViewModel {
	courseCode: string;
	pathName: string;
	ringPercent: number; // 0–100 integer
	currentLevel: number | null; // lowest not-approved; null when complete
	complete: boolean;
	levels: SyncedLevel[];
}

interface SyncedPath {
	courseCode: string;
	pathName: string;
	levels: SyncedLevel[];
}

/** Pure: shape one synced path into its display model. */
export function buildPathViewModel(path: SyncedPath): PathViewModel {
	const levels = [...path.levels].sort((a, b) => a.level - b.level);
	const done = levels.reduce((s, l) => s + Math.min(l.completed, l.total), 0);
	const total = levels.reduce((s, l) => s + l.total, 0);
	const ringPercent =
		total === 0 ? 0 : Math.min(100, Math.round((done / total) * 100));
	const firstUnapproved = levels.find((l) => !l.approved);
	return {
		courseCode: path.courseCode,
		pathName: path.pathName,
		ringPercent,
		currentLevel: firstUnapproved ? firstUnapproved.level : null,
		complete: !firstUnapproved,
		levels,
	};
}

/** Read every enrolled path for a person and build view models. */
export async function pathwaysForPerson(
	personId: string,
): Promise<PathViewModel[]> {
	const rows = await db
		.select({
			courseCode: pathwaysPaths.courseCode,
			pathName: pathwaysPaths.name,
			level: pathLevelProgress.level,
			completed: pathLevelProgress.completed,
			total: pathLevelProgress.total,
			approved: pathLevelProgress.approved,
		})
		.from(pathEnrollments)
		.innerJoin(pathwaysPaths, eq(pathEnrollments.pathId, pathwaysPaths.id))
		.innerJoin(
			pathLevelProgress,
			eq(pathLevelProgress.enrollmentId, pathEnrollments.id),
		)
		.where(eq(pathEnrollments.personId, personId))
		.orderBy(asc(pathwaysPaths.sortOrder), asc(pathLevelProgress.level));

	const byPath = new Map<string, SyncedPath>();
	for (const r of rows) {
		let p = byPath.get(r.courseCode);
		if (!p) {
			p = { courseCode: r.courseCode, pathName: r.pathName, levels: [] };
			byPath.set(r.courseCode, p);
		}
		p.levels.push({
			level: r.level,
			completed: r.completed,
			total: r.total,
			approved: r.approved,
		});
	}
	return [...byPath.values()].map(buildPathViewModel);
}

/** Resolve the person for a roster member, then their paths. */
export async function pathwaysForMember(
	clubId: string,
	memberId: string,
): Promise<PathViewModel[]> {
	const [m] = await db
		.select({ personId: members.personId })
		.from(members)
		.where(and(eq(members.id, memberId), eq(members.clubId, clubId)));
	if (!m) return [];
	return pathwaysForPerson(m.personId);
}

/** Resolve the person for a signed-in user (people.userId link), then their paths. */
export async function pathwaysForUser(
	userId: string,
): Promise<PathViewModel[]> {
	const [p] = await db
		.select({ id: people.id })
		.from(people)
		.where(eq(people.userId, userId));
	if (!p) return [];
	return pathwaysForPerson(p.id);
}
