import { and, asc, eq, inArray, isNull, lt, ne } from "drizzle-orm";
import { db } from "#/db";
import {
	bcmProjectProgress,
	meetings,
	members,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPathLevels,
	pathwaysPaths,
	pathwaysProjects,
	people,
	projectCompletionMarks,
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
	/** Catalog project id, when this win resolves to one — the handle the
	 *  un-mark control needs. Null on inference-fallback wins. */
	projectId: string | null;
	/** Completed by an explicit mark here (#419) — the handle for un-marking.
	 *  A project can be both marked here and complete in Base Camp. */
	markedHere: boolean;
	/**
	 * Marked complete here but NOT (yet) complete in Base Camp (#419).
	 *
	 * A first-class state, not a conflict: it is exactly "done, awaiting
	 * processing" — the working-ahead case. Only ever true where Base Camp has
	 * something to say about this enrollment; a club that never syncs has one
	 * source and never sees the distinction.
	 */
	awaitingProcessing: boolean;
}

/** A current-level catalog project not yet won. */
export interface UpNextProject {
	/** Catalog project id — the handle the "mark complete" control needs. */
	projectId: string | null;
	level: number;
	name: string;
	isRequired: boolean;
}

/** Grouped elective choice for the current level (from the /detail mirror). */
export interface UpNextElectives {
	chooseCount: number; // min_req_electives − electives already complete at this level
	options: { projectId: string | null; name: string }[]; // remaining (not-complete) electives in the pool
}

/** One /detail mirror row joined to its catalog project. */
export interface DetailProjectRow {
	projectId: string;
	courseCode: string;
	level: number;
	name: string;
	isRequired: boolean;
	complete: boolean;
	speechTitle: string | null;
	speechDate: Date | null;
}

/** One manual completion mark (#419), joined to its catalog project. */
export interface MarkRow {
	projectId: string;
	courseCode: string;
	level: number;
	name: string;
	isRequired: boolean;
	markedAt: Date;
}

export interface PathViewModel {
	courseCode: string;
	pathName: string;
	ringPercent: number; // 0–100 integer
	currentLevel: number | null; // lowest not-approved; null when complete
	complete: boolean;
	levels: SyncedLevel[];
	/**
	 * Where `levels` (and therefore the ring and the level bar) come from.
	 *
	 * "basecamp" — `path_level_progress`, the authoritative mirror.
	 * "catalog"  — the seeded TI curriculum, counted against manual marks,
	 *              for an enrollment Base Camp has never spoken about (#419).
	 *
	 * Surfaced rather than hidden so the UI can say which it is. The catalog
	 * denominator is real (it is TI's own per-level requirement), but `approved`
	 * is never inferred from it — only Base Camp approves a level.
	 */
	levelsSource: "basecamp" | "catalog";
	/** Does Base Camp have anything to say about this enrollment at all? Drives
	 *  whether "awaiting processing" is a meaningful distinction to show. */
	hasBasecamp: boolean;
	/** This person's delivered speeches whose project is in this path. */
	wins: Win[];
	/** Current-level catalog projects not already a win. Empty when complete.
	 * On the bcm branch this is required-only (electives live in `upNextElectives`). */
	upNext: UpNextProject[];
	/** Current-level elective choice, when the mirror is present and the level's
	 * elective requirement isn't met yet. Null on the inference fallback path. */
	upNextElectives: UpNextElectives | null;
}

export interface CatalogProject {
	projectId: string;
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
	/** Manual completion marks for this enrollment (#419). */
	marks?: MarkRow[];
}

/**
 * Levels derived from the seeded catalog, for an enrollment Base Camp has never
 * spoken about (#419).
 *
 * Before this, `pathwaysForPerson` INNER-joined `path_level_progress`, so a
 * member who declared a path by hand (#417) produced no view model at all and
 * the dashboard told them their club hadn't synced — which was true and useless.
 *
 * The denominator is not invented: it is TI's own per-level requirement, the
 * required projects at that level plus `min_req_electives`. `approved` is always
 * false — only Base Camp approves a level, and inferring it from marks would be
 * exactly the over-crediting this feature exists to avoid.
 */
function levelsFromCatalog(
	catalogProjects: CatalogProject[],
	pathLevels: { level: number; minReqElectives: number }[] | undefined,
	completeProjectIds: Set<string>,
): SyncedLevel[] {
	const levels = [...new Set(catalogProjects.map((p) => p.level))].sort(
		(a, b) => a - b,
	);
	return levels.map((level) => {
		const atLevel = catalogProjects.filter((p) => p.level === level);
		const required = atLevel.filter((p) => p.isRequired);
		const minReqElectives =
			pathLevels?.find((l) => l.level === level)?.minReqElectives ?? 0;
		return {
			level,
			completed: atLevel.filter((p) => completeProjectIds.has(p.projectId))
				.length,
			total: required.length + minReqElectives,
			approved: false,
		};
	});
}

/** Pure: shape one synced path into its display model. */
export function buildPathViewModel(path: SyncedPath): PathViewModel {
	const detail = path.detailProjects ?? [];
	const marks = path.marks ?? [];

	// The two sources are UNIONED for "what's done", never merged into one
	// another: Base Camp never overwrites a mark and a mark never overwrites Base
	// Camp. `hasBasecampDetail` is what makes "awaiting processing" meaningful —
	// it needs Base Camp's per-PROJECT verdict, which only /detail gives. A club
	// that syncs summary counts only, or never syncs, has no such verdict, so
	// nothing is ever labelled as awaiting anything.
	const hasBasecampDetail = detail.length > 0;
	const bcmCompleteIds = new Set(
		detail.filter((p) => p.complete).map((p) => p.projectId),
	);
	const markedIds = new Set(marks.map((m) => m.projectId));
	const completeIds = new Set([...bcmCompleteIds, ...markedIds]);

	// Base Camp's own level counts win where they exist. Otherwise derive them
	// from the seeded catalog so a hand-declared enrollment (#417) is a real,
	// visible path rather than nothing at all.
	const levelsSource: "basecamp" | "catalog" =
		path.levels.length > 0 ? "basecamp" : "catalog";
	const levels =
		levelsSource === "basecamp"
			? [...path.levels].sort((a, b) => a.level - b.level)
			: levelsFromCatalog(path.catalogProjects, path.pathLevels, completeIds);

	const done = levels.reduce((s, l) => s + Math.min(l.completed, l.total), 0);
	const total = levels.reduce((s, l) => s + l.total, 0);
	const ringPercent =
		total === 0 ? 0 : Math.min(100, Math.round((done / total) * 100));
	const firstUnapproved = levels.find((l) => !l.approved);
	const currentLevel = firstUnapproved ? firstUnapproved.level : null;
	// On the catalog branch `approved` is always false, so a path is never
	// reported complete off marks alone — only Base Camp closes a path.
	const complete = !firstUnapproved;

	const base = {
		courseCode: path.courseCode,
		pathName: path.pathName,
		ringPercent,
		currentLevel,
		complete,
		levels,
		levelsSource,
		hasBasecamp: hasBasecampDetail,
	};

	// Project-level branch: taken as soon as EITHER source has per-project truth.
	if (hasBasecampDetail || marks.length > 0) {
		// A delivered speech linked to this project (via `speeches.project_id`)
		// gives a mark its title and date; /detail carries its own.
		const speechByProjectId = new Map(
			path.wins
				.filter((w) => w.projectId !== null)
				.map((w) => [
					w.projectId as string,
					{ speechTitle: w.speechTitle, deliveredAt: w.deliveredAt },
				]),
		);
		const byId = new Map<string, { level: number; name: string }>();
		for (const p of detail) byId.set(p.projectId, p);
		for (const m of marks) byId.set(m.projectId, m);

		const wins: Win[] = [...completeIds]
			.map((projectId) => {
				const meta = byId.get(projectId);
				const fromDetail = detail.find((p) => p.projectId === projectId);
				const speech = speechByProjectId.get(projectId);
				return {
					projectId,
					level: meta?.level ?? 0,
					name: meta?.name ?? "",
					speechTitle: fromDetail?.speechTitle ?? speech?.speechTitle ?? "",
					deliveredAt: fromDetail?.speechDate ?? speech?.deliveredAt ?? null,
					markedHere: markedIds.has(projectId),
					awaitingProcessing:
						hasBasecampDetail && !bcmCompleteIds.has(projectId),
				};
			})
			.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));

		let upNext: UpNextProject[] = [];
		let upNextElectives: UpNextElectives | null = null;
		if (!complete && currentLevel !== null) {
			const currentCatalog = path.catalogProjects.filter(
				(c) => c.level === currentLevel,
			);
			upNext = currentCatalog
				.filter((c) => c.isRequired && !completeIds.has(c.projectId))
				.map((c) => ({
					projectId: c.projectId,
					level: c.level,
					name: c.name,
					isRequired: c.isRequired,
				}));

			const currentElectives = currentCatalog.filter((c) => !c.isRequired);
			const completedElectives = currentElectives.filter((c) =>
				completeIds.has(c.projectId),
			).length;
			const minReq =
				path.pathLevels?.find((l) => l.level === currentLevel)
					?.minReqElectives ?? 0;
			const chooseCount = Math.max(0, minReq - completedElectives);
			if (chooseCount > 0) {
				upNextElectives = {
					chooseCount,
					options: currentElectives
						.filter((c) => !completeIds.has(c.projectId))
						.map((c) => ({ projectId: c.projectId, name: c.name })),
				};
			}
		}

		return { ...base, wins, upNext, upNextElectives };
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
						projectId: cp.projectId,
						level: cp.level,
						name: cp.name,
						isRequired: cp.isRequired,
					}));

	return { ...base, wins: path.wins, upNext, upNextElectives: null };
}

interface WinRow {
	personId: string;
	projectId: string;
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
			projectId: pathwaysProjects.id,
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
	projectId: string;
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
			projectId: pathwaysProjects.id,
			pathId: pathwaysProjects.pathId,
			level: pathwaysProjects.level,
			name: pathwaysProjects.name,
			isRequired: pathwaysProjects.isRequired,
		})
		.from(pathwaysProjects)
		.where(inArray(pathwaysProjects.pathId, pathIds))
		.orderBy(
			asc(pathwaysProjects.level),
			asc(pathwaysProjects.sortOrder),
			asc(pathwaysProjects.name),
		);
}

interface DetailRow {
	personId: string;
	projectId: string;
	courseCode: string;
	level: number;
	name: string;
	isRequired: boolean;
	complete: boolean;
	speechTitle: string | null;
	speechDate: Date | null;
}

/** /detail mirror rows joined to catalog + path, keyed by person (via the
 * enrollment) — symmetric with `fetchDeliveredWins`, so both read paths group
 * by `personId::courseCode`. */
async function fetchDetailProjects(personIds: string[]): Promise<DetailRow[]> {
	if (personIds.length === 0) return [];
	return db
		.select({
			personId: pathEnrollments.personId,
			projectId: pathwaysProjects.id,
			courseCode: pathwaysPaths.courseCode,
			level: pathwaysProjects.level,
			name: pathwaysProjects.name,
			isRequired: pathwaysProjects.isRequired,
			complete: bcmProjectProgress.complete,
			speechTitle: bcmProjectProgress.speechTitle,
			speechDate: bcmProjectProgress.speechDate,
		})
		.from(bcmProjectProgress)
		.innerJoin(
			pathEnrollments,
			eq(pathEnrollments.id, bcmProjectProgress.enrollmentId),
		)
		.innerJoin(
			pathwaysProjects,
			eq(pathwaysProjects.id, bcmProjectProgress.projectId),
		)
		.innerJoin(pathwaysPaths, eq(pathwaysPaths.id, pathwaysProjects.pathId))
		.where(inArray(pathEnrollments.personId, personIds));
}

interface ManualMarkRow {
	personId: string;
	projectId: string;
	courseCode: string;
	level: number;
	name: string;
	isRequired: boolean;
	markedAt: Date;
}

/**
 * Manual completion marks (#419), joined to catalog + path and keyed by person —
 * symmetric with `fetchDetailProjects`, so both project-level sources group by
 * `personId::courseCode`.
 *
 * Restricted to LIVE enrollments: archiving a path (#417) hides it, and its
 * marks with it, without deleting either.
 */
async function fetchMarks(personIds: string[]): Promise<ManualMarkRow[]> {
	if (personIds.length === 0) return [];
	return db
		.select({
			personId: pathEnrollments.personId,
			projectId: pathwaysProjects.id,
			courseCode: pathwaysPaths.courseCode,
			level: pathwaysProjects.level,
			name: pathwaysProjects.name,
			isRequired: pathwaysProjects.isRequired,
			markedAt: projectCompletionMarks.markedAt,
		})
		.from(projectCompletionMarks)
		.innerJoin(
			pathEnrollments,
			eq(pathEnrollments.id, projectCompletionMarks.enrollmentId),
		)
		.innerJoin(
			pathwaysProjects,
			eq(pathwaysProjects.id, projectCompletionMarks.projectId),
		)
		.innerJoin(pathwaysPaths, eq(pathwaysPaths.id, pathwaysProjects.pathId))
		.where(
			and(
				inArray(pathEnrollments.personId, personIds),
				isNull(pathEnrollments.archivedAt),
			),
		);
}

/** Per-level elective requirements (pathways_path_levels) for a set of path ids. */
async function fetchPathLevels(
	pathIds: string[],
): Promise<{ courseCode: string; level: number; minReqElectives: number }[]> {
	if (pathIds.length === 0) return [];
	return db
		.select({
			courseCode: pathwaysPaths.courseCode,
			level: pathwaysPathLevels.level,
			minReqElectives: pathwaysPathLevels.minReqElectives,
		})
		.from(pathwaysPathLevels)
		.innerJoin(pathwaysPaths, eq(pathwaysPaths.id, pathwaysPathLevels.pathId))
		.where(inArray(pathwaysPathLevels.pathId, pathIds));
}

/** Read every enrolled path for a person and build view models. */
export async function pathwaysForPerson(
	personId: string,
): Promise<PathViewModel[]> {
	// LEFT join on `path_level_progress`, not inner (#419). An inner join dropped
	// every enrollment Base Camp had never spoken about — so a member who
	// declared a path by hand (#417) got no view model at all and the dashboard
	// told them their club hadn't synced. `buildPathViewModel` derives levels
	// from the seeded catalog when this comes back null.
	//
	// Archived enrollments are excluded here too; before, `path_level_progress`
	// happened to mask most of them.
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
		.leftJoin(
			pathLevelProgress,
			eq(pathLevelProgress.enrollmentId, pathEnrollments.id),
		)
		.where(
			and(
				eq(pathEnrollments.personId, personId),
				isNull(pathEnrollments.archivedAt),
			),
		)
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
		// Null for an enrollment with no Base Camp counts — the row exists only to
		// carry the path itself.
		if (r.level !== null) {
			p.levels.push({
				level: r.level,
				completed: r.completed ?? 0,
				total: r.total ?? 0,
				approved: r.approved ?? false,
			});
		}
	}

	const pathIds = [...courseCodeByPathId.keys()];
	const [winRows, catalogRows, detailRows, pathLevelRows, markRows] =
		await Promise.all([
			fetchDeliveredWins([personId], pathIds),
			fetchCatalogProjects(pathIds),
			fetchDetailProjects([personId]),
			fetchPathLevels(pathIds),
			fetchMarks([personId]),
		]);

	for (const w of winRows) {
		const p = byPath.get(w.courseCode);
		if (!p) continue;
		p.wins.push({
			projectId: w.projectId,
			level: w.level,
			name: w.name,
			speechTitle: w.speechTitle,
			deliveredAt: w.deliveredAt,
			markedHere: false,
			awaitingProcessing: false,
		});
	}
	for (const c of catalogRows) {
		const courseCode = courseCodeByPathId.get(c.pathId);
		if (!courseCode) continue;
		const p = byPath.get(courseCode);
		if (!p) continue;
		p.catalogProjects.push({
			projectId: c.projectId,
			level: c.level,
			name: c.name,
			isRequired: c.isRequired,
		});
	}
	for (const d of detailRows) {
		const p = byPath.get(d.courseCode);
		if (!p) continue;
		if (!p.detailProjects) p.detailProjects = [];
		p.detailProjects.push({
			projectId: d.projectId,
			courseCode: d.courseCode,
			level: d.level,
			name: d.name,
			isRequired: d.isRequired,
			complete: d.complete,
			speechTitle: d.speechTitle,
			speechDate: d.speechDate,
		});
	}
	for (const m of markRows) {
		const p = byPath.get(m.courseCode);
		if (!p) continue;
		if (!p.marks) p.marks = [];
		p.marks.push(m);
	}
	for (const pl of pathLevelRows) {
		const p = byPath.get(pl.courseCode);
		if (!p) continue;
		if (!p.pathLevels) p.pathLevels = [];
		p.pathLevels.push({ level: pl.level, minReqElectives: pl.minReqElectives });
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
 * (levels, wins, catalog, /detail mirror, path-levels), grouped by membership
 * id — avoids an N+1 when
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
		// LEFT, and archived enrollments excluded — same reasoning as
		// `pathwaysForPerson` (#419).
		.leftJoin(
			pathLevelProgress,
			eq(pathLevelProgress.enrollmentId, pathEnrollments.id),
		)
		.where(and(eq(members.clubId, clubId), isNull(pathEnrollments.archivedAt)))
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
		if (r.level !== null) {
			p.levels.push({
				level: r.level,
				completed: r.completed ?? 0,
				total: r.total ?? 0,
				approved: r.approved ?? false,
			});
		}
	}

	const [winRows, catalogRows, detailRows, pathLevelRows, markRows] =
		await Promise.all([
			fetchDeliveredWins([...personIds], [...pathIds]),
			fetchCatalogProjects([...pathIds]),
			fetchDetailProjects([...personIds]),
			fetchPathLevels([...pathIds]),
			fetchMarks([...personIds]),
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
			projectId: w.projectId,
			level: w.level,
			name: w.name,
			speechTitle: w.speechTitle,
			deliveredAt: w.deliveredAt,
			markedHere: false,
			awaitingProcessing: false,
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
		list.push({
			projectId: c.projectId,
			level: c.level,
			name: c.name,
			isRequired: c.isRequired,
		});
	}

	// Detail rows are person-scoped (like wins) → key by personId::courseCode.
	const detailByPersonAndPath = new Map<string, DetailProjectRow[]>();
	for (const d of detailRows) {
		const key = `${d.personId}::${d.courseCode}`;
		let list = detailByPersonAndPath.get(key);
		if (!list) {
			list = [];
			detailByPersonAndPath.set(key, list);
		}
		list.push({
			projectId: d.projectId,
			courseCode: d.courseCode,
			level: d.level,
			name: d.name,
			isRequired: d.isRequired,
			complete: d.complete,
			speechTitle: d.speechTitle,
			speechDate: d.speechDate,
		});
	}

	// Marks are person-scoped too (#419).
	const marksByPersonAndPath = new Map<string, MarkRow[]>();
	for (const m of markRows) {
		const key = `${m.personId}::${m.courseCode}`;
		let list = marksByPersonAndPath.get(key);
		if (!list) {
			list = [];
			marksByPersonAndPath.set(key, list);
		}
		list.push(m);
	}

	// Path-levels are path-scoped (like catalog) → key by courseCode.
	const pathLevelsByCourseCode = new Map<
		string,
		{ level: number; minReqElectives: number }[]
	>();
	for (const pl of pathLevelRows) {
		let list = pathLevelsByCourseCode.get(pl.courseCode);
		if (!list) {
			list = [];
			pathLevelsByCourseCode.set(pl.courseCode, list);
		}
		list.push({ level: pl.level, minReqElectives: pl.minReqElectives });
	}

	const result = new Map<string, PathViewModel[]>();
	for (const [memberId, byPath] of byMember) {
		const personId = personIdByMember.get(memberId);
		const vms = [...byPath.values()].map((p) => {
			p.wins = winsByPersonAndPath.get(`${personId}::${p.courseCode}`) ?? [];
			p.catalogProjects = catalogByCourseCode.get(p.courseCode) ?? [];
			p.detailProjects = detailByPersonAndPath.get(
				`${personId}::${p.courseCode}`,
			);
			p.pathLevels = pathLevelsByCourseCode.get(p.courseCode);
			p.marks = marksByPersonAndPath.get(`${personId}::${p.courseCode}`);
			return buildPathViewModel(p);
		});
		result.set(memberId, vms);
	}
	return result;
}
