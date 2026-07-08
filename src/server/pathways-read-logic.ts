import { and, asc, eq, inArray, lt, ne } from "drizzle-orm";
import { db } from "#/db";
import {
	meetings,
	members,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
	pathwaysProjects,
	people,
	roleSlots,
	speeches,
} from "#/db/schema";

export interface SyncedLevel {
	level: number;
	completed: number;
	total: number;
	approved: boolean;
}

/** A DELIVERED speech whose project is in this path (Phase 2 / #101). */
export interface Win {
	level: number;
	name: string;
	speechTitle: string;
	deliveredAt: Date | null; // null for a non-speech (leadership) completion from /detail
}

/** A current-level catalog project not yet won. */
export interface UpNextProject {
	level: number;
	name: string;
	isRequired: boolean;
}

/** Grouped elective choice for the current level (from the /detail mirror). */
export interface UpNextElectives {
	chooseCount: number; // min_req_electives − electives already complete at this level
	options: string[]; // remaining (not-complete) elective project names in the pool
}

/** One /detail mirror row joined to its catalog project. */
export interface DetailProjectRow {
	courseCode: string;
	level: number;
	name: string;
	isRequired: boolean;
	complete: boolean;
	speechTitle: string | null;
	speechDate: Date | null;
}

export interface PathViewModel {
	courseCode: string;
	pathName: string;
	ringPercent: number; // 0–100 integer
	currentLevel: number | null; // lowest not-approved; null when complete
	complete: boolean;
	levels: SyncedLevel[];
	/** This person's delivered speeches whose project is in this path. */
	wins: Win[];
	/** Current-level catalog projects not already a win. Empty when complete. */
	upNext: UpNextProject[];
	/** Current-level elective choice, when the mirror is present and the level's
	 * elective requirement isn't met yet. Null on the inference fallback path. */
	upNextElectives: UpNextElectives | null;
}

export interface CatalogProject {
	level: number;
	name: string;
	isRequired: boolean;
}

interface SyncedPath {
	courseCode: string;
	pathName: string;
	levels: SyncedLevel[];
	wins: Win[];
	catalogProjects: CatalogProject[];
	/** /detail mirror rows for this path, when synced. Presence selects the bcm branch. */
	detailProjects?: DetailProjectRow[];
	/** Per-level elective requirements (pathways_path_levels), when synced. */
	pathLevels?: { level: number; minReqElectives: number }[];
}

/** Pure: shape one synced path into its display model. */
export function buildPathViewModel(path: SyncedPath): PathViewModel {
	const levels = [...path.levels].sort((a, b) => a.level - b.level);
	const done = levels.reduce((s, l) => s + Math.min(l.completed, l.total), 0);
	const total = levels.reduce((s, l) => s + l.total, 0);
	const ringPercent =
		total === 0 ? 0 : Math.min(100, Math.round((done / total) * 100));
	const firstUnapproved = levels.find((l) => !l.approved);
	const currentLevel = firstUnapproved ? firstUnapproved.level : null;
	const complete = !firstUnapproved;

	// The mirror augments: ring/levels/currentLevel/complete stay from the count
	// mirror above. Wins + up-next switch to /detail when this path has mirror rows.
	const detail = path.detailProjects;
	if (detail && detail.length > 0) {
		const wins: Win[] = detail
			.filter((p) => p.complete)
			.map((p) => ({
				level: p.level,
				name: p.name,
				speechTitle: p.speechTitle ?? "",
				deliveredAt: p.speechDate ?? null,
			}))
			.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));

		let upNext: UpNextProject[] = [];
		let upNextElectives: UpNextElectives | null = null;
		if (!complete && currentLevel !== null) {
			const completeNames = new Set(
				detail.filter((p) => p.complete).map((p) => p.name),
			);
			const currentCatalog = path.catalogProjects.filter(
				(c) => c.level === currentLevel,
			);
			upNext = currentCatalog
				.filter((c) => c.isRequired && !completeNames.has(c.name))
				.map((c) => ({ level: c.level, name: c.name, isRequired: true }));

			const currentElectives = currentCatalog.filter((c) => !c.isRequired);
			const completedElectives = currentElectives.filter((c) =>
				completeNames.has(c.name),
			).length;
			const minReq =
				path.pathLevels?.find((l) => l.level === currentLevel)
					?.minReqElectives ?? 0;
			const chooseCount = Math.max(0, minReq - completedElectives);
			if (chooseCount > 0) {
				upNextElectives = {
					chooseCount,
					options: currentElectives
						.filter((c) => !completeNames.has(c.name))
						.map((c) => c.name),
				};
			}
		}

		return {
			courseCode: path.courseCode,
			pathName: path.pathName,
			ringPercent,
			currentLevel,
			complete,
			levels,
			wins,
			upNext,
			upNextElectives,
		};
	}

	// Inference fallback (unchanged): wins from the member's own delivered
	// speeches, up-next = current-level catalog minus win-names.
	const winNames = new Set(path.wins.map((w) => w.name));
	const upNext =
		complete || currentLevel === null
			? []
			: path.catalogProjects
					.filter((cp) => cp.level === currentLevel && !winNames.has(cp.name))
					.map((cp) => ({
						level: cp.level,
						name: cp.name,
						isRequired: cp.isRequired,
					}));

	return {
		courseCode: path.courseCode,
		pathName: path.pathName,
		ringPercent,
		currentLevel,
		complete,
		levels,
		wins: path.wins,
		upNext,
		upNextElectives: null,
	};
}

interface WinRow {
	personId: string;
	courseCode: string;
	level: number;
	name: string;
	speechTitle: string;
	deliveredAt: Date;
}

/**
 * DELIVERED speeches (ADR-0009) whose `project_id` resolves to a catalog
 * project in one of `pathIds`, for one or more people. "Delivered" mirrors
 * the existing past/upcoming split used elsewhere (season-grid-logic's
 * `isPast`, members-logic's active→inactive "upcoming roles" release): a
 * `role_slots` row referencing the speech whose meeting is non-cancelled and
 * dated in the past.
 */
async function fetchDeliveredWins(
	personIds: string[],
	pathIds: string[],
): Promise<WinRow[]> {
	if (personIds.length === 0 || pathIds.length === 0) return [];
	return db
		.select({
			personId: speeches.personId,
			courseCode: pathwaysPaths.courseCode,
			level: pathwaysProjects.level,
			name: pathwaysProjects.name,
			speechTitle: speeches.title,
			deliveredAt: meetings.scheduledAt,
		})
		.from(speeches)
		.innerJoin(pathwaysProjects, eq(pathwaysProjects.id, speeches.projectId))
		.innerJoin(pathwaysPaths, eq(pathwaysPaths.id, pathwaysProjects.pathId))
		.innerJoin(roleSlots, eq(roleSlots.speechId, speeches.id))
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(
			and(
				inArray(speeches.personId, personIds),
				inArray(pathwaysProjects.pathId, pathIds),
				ne(meetings.status, "cancelled"),
				lt(meetings.scheduledAt, new Date()),
			),
		);
}

interface CatalogRow {
	pathId: string;
	level: number;
	name: string;
	isRequired: boolean;
}

/** The catalog projects (`pathwaysProjects`) for a set of path ids. */
async function fetchCatalogProjects(pathIds: string[]): Promise<CatalogRow[]> {
	if (pathIds.length === 0) return [];
	return db
		.select({
			pathId: pathwaysProjects.pathId,
			level: pathwaysProjects.level,
			name: pathwaysProjects.name,
			isRequired: pathwaysProjects.isRequired,
		})
		.from(pathwaysProjects)
		.where(inArray(pathwaysProjects.pathId, pathIds));
}

/** Read every enrolled path for a person and build view models. */
export async function pathwaysForPerson(
	personId: string,
): Promise<PathViewModel[]> {
	const rows = await db
		.select({
			pathId: pathwaysPaths.id,
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

	if (rows.length === 0) return [];

	const byPath = new Map<string, SyncedPath>();
	const courseCodeByPathId = new Map<string, string>();
	for (const r of rows) {
		let p = byPath.get(r.courseCode);
		if (!p) {
			p = {
				courseCode: r.courseCode,
				pathName: r.pathName,
				levels: [],
				wins: [],
				catalogProjects: [],
			};
			byPath.set(r.courseCode, p);
			courseCodeByPathId.set(r.pathId, r.courseCode);
		}
		p.levels.push({
			level: r.level,
			completed: r.completed,
			total: r.total,
			approved: r.approved,
		});
	}

	const pathIds = [...courseCodeByPathId.keys()];
	const [winRows, catalogRows] = await Promise.all([
		fetchDeliveredWins([personId], pathIds),
		fetchCatalogProjects(pathIds),
	]);

	for (const w of winRows) {
		const p = byPath.get(w.courseCode);
		if (!p) continue;
		p.wins.push({
			level: w.level,
			name: w.name,
			speechTitle: w.speechTitle,
			deliveredAt: w.deliveredAt,
		});
	}
	for (const c of catalogRows) {
		const courseCode = courseCodeByPathId.get(c.pathId);
		if (!courseCode) continue;
		const p = byPath.get(courseCode);
		if (!p) continue;
		p.catalogProjects.push({
			level: c.level,
			name: c.name,
			isRequired: c.isRequired,
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

/**
 * Every enrolled path for every member of a club, in ONE query per concern
 * (levels, wins, catalog), grouped by membership id — avoids an N+1 when
 * rendering the roster (mirrors the batching shape of `currentOfficersByMember`
 * in officer-terms-logic.ts). Memberships with no synced paths are simply
 * absent from the map (callers default to an empty array).
 */
export async function pathwaysByMember(
	clubId: string,
): Promise<Map<string, PathViewModel[]>> {
	const rows = await db
		.select({
			memberId: members.id,
			personId: members.personId,
			pathId: pathwaysPaths.id,
			courseCode: pathwaysPaths.courseCode,
			pathName: pathwaysPaths.name,
			level: pathLevelProgress.level,
			completed: pathLevelProgress.completed,
			total: pathLevelProgress.total,
			approved: pathLevelProgress.approved,
		})
		.from(members)
		.innerJoin(pathEnrollments, eq(pathEnrollments.personId, members.personId))
		.innerJoin(pathwaysPaths, eq(pathEnrollments.pathId, pathwaysPaths.id))
		.innerJoin(
			pathLevelProgress,
			eq(pathLevelProgress.enrollmentId, pathEnrollments.id),
		)
		.where(eq(members.clubId, clubId))
		.orderBy(asc(pathwaysPaths.sortOrder), asc(pathLevelProgress.level));

	if (rows.length === 0) return new Map();

	const byMember = new Map<string, Map<string, SyncedPath>>();
	const personIdByMember = new Map<string, string>();
	const courseCodeByPathId = new Map<string, string>();
	const personIds = new Set<string>();
	const pathIds = new Set<string>();

	for (const r of rows) {
		personIdByMember.set(r.memberId, r.personId);
		personIds.add(r.personId);
		pathIds.add(r.pathId);
		courseCodeByPathId.set(r.pathId, r.courseCode);

		let byPath = byMember.get(r.memberId);
		if (!byPath) {
			byPath = new Map<string, SyncedPath>();
			byMember.set(r.memberId, byPath);
		}
		let p = byPath.get(r.courseCode);
		if (!p) {
			p = {
				courseCode: r.courseCode,
				pathName: r.pathName,
				levels: [],
				wins: [],
				catalogProjects: [],
			};
			byPath.set(r.courseCode, p);
		}
		p.levels.push({
			level: r.level,
			completed: r.completed,
			total: r.total,
			approved: r.approved,
		});
	}

	const [winRows, catalogRows] = await Promise.all([
		fetchDeliveredWins([...personIds], [...pathIds]),
		fetchCatalogProjects([...pathIds]),
	]);

	// Group wins by personId+courseCode for O(1) lookup per member/path.
	const winsByPersonAndPath = new Map<string, Win[]>();
	for (const w of winRows) {
		const key = `${w.personId}::${w.courseCode}`;
		let list = winsByPersonAndPath.get(key);
		if (!list) {
			list = [];
			winsByPersonAndPath.set(key, list);
		}
		list.push({
			level: w.level,
			name: w.name,
			speechTitle: w.speechTitle,
			deliveredAt: w.deliveredAt,
		});
	}

	// Group catalog projects by courseCode (shared across every member on that path).
	const catalogByCourseCode = new Map<string, CatalogProject[]>();
	for (const c of catalogRows) {
		const courseCode = courseCodeByPathId.get(c.pathId);
		if (!courseCode) continue;
		let list = catalogByCourseCode.get(courseCode);
		if (!list) {
			list = [];
			catalogByCourseCode.set(courseCode, list);
		}
		list.push({ level: c.level, name: c.name, isRequired: c.isRequired });
	}

	const result = new Map<string, PathViewModel[]>();
	for (const [memberId, byPath] of byMember) {
		const personId = personIdByMember.get(memberId);
		const vms = [...byPath.values()].map((p) => {
			p.wins = winsByPersonAndPath.get(`${personId}::${p.courseCode}`) ?? [];
			p.catalogProjects = catalogByCourseCode.get(p.courseCode) ?? [];
			return buildPathViewModel(p);
		});
		result.set(memberId, vms);
	}
	return result;
}
