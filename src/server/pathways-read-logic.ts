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
	projectCompletionMarks,
	roleSlots,
	speeches,
} from "#/db/schema";
import {
	type CatalogPath,
	PATH_COMPLETION_LEVEL,
	type PathwaysSeries,
	SERIES_LABEL,
	seriesRequiredAt,
} from "#/lib/pathways-catalog";
import { isReadableClub } from "./club-readable-logic";
import { resolveUserPersonId } from "./person-identity-logic";

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

/** One Education Series still owed at the working level (#921/#922). */
export interface UpNextSeries {
	series: PathwaysSeries;
	label: string; // SERIES_LABEL[series]
	/** Every title of that series at the level; any ONE of them meets it. */
	options: { projectId: string; name: string }[];
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
	/**
	 * `pathways_paths.status`. Decides the Education Series requirement, which
	 * applies to current paths only (`seriesRequiredAt`).
	 */
	status: CatalogPath["status"];
	ringPercent: number; // 0–100 integer
	currentLevel: number | null; // lowest not-approved; null when complete
	complete: boolean;
	/**
	 * The level the member is actually working on (#898): the lowest level that
	 * still has projects LEFT, which is not the same question as `currentLevel`'s
	 * "lowest not approved". On the catalog branch nothing is ever approved, so
	 * `currentLevel` is Level 1 forever; keying "Up next" off it left a member
	 * who had marked all of Level 1 staring at "Level 1 · 4 of 4" with nothing
	 * next. `currentLevel` and `complete` are unchanged, because the ring and
	 * "Path complete" are about approval, and only Base Camp approves.
	 *
	 * Path Completion (`PATH_COMPLETION_LEVEL`) can be the working level only on
	 * the catalog branch, and only once levels 1–5 have nothing left. Base
	 * Camp's summary never carries it, so there is no count to read there.
	 * Null when nothing is left. Render with `levelLabel()`, never "Level N".
	 */
	workingLevel: number | null;
	/** Projects left at `workingLevel` (see `projectsLeftAt`). 0 when it is null. */
	projectsLeftAtWorkingLevel: number;
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
	/**
	 * What the member still has to do at the WORKING level. Empty when there is
	 * no working level.
	 *
	 * Required-only on the Base Camp branch (electives live in
	 * `upNextElectives`), and ALWAYS EMPTY on the inference fallback — delivered
	 * speeches cannot tell a multi-assignment project from a finished one, nor
	 * evidence a leadership project at all (#456).
	 */
	upNext: UpNextProject[];
	/** Working-level elective choice, when the level's elective requirement
	 * isn't met yet. Null on the inference fallback path. */
	upNextElectives: UpNextElectives | null;
	/**
	 * Education Series still owed at the working level (#922): one group per
	 * series in `seriesRequiredAt(workingLevel, status)` with NO complete project
	 * yet at that level. Empty on legacy paths, levels 1–3 and with no working
	 * level.
	 *
	 * Populated EVEN on the inference fallback, unlike `upNext` (#456): which
	 * series a level needs is a catalog fact, and Base Camp never reports a
	 * series presentation at all, so there is nothing to infer.
	 */
	upNextSeries: UpNextSeries[];
}

export interface CatalogProject {
	projectId: string;
	level: number;
	name: string;
	isRequired: boolean;
	/**
	 * Education Series presentation (#921), else null. `isRequired` is false on
	 * these, and they are NOT electives: every "elective" filter here is
	 * `!isRequired && series === null`.
	 */
	series: PathwaysSeries | null;
}

interface SyncedPath {
	courseCode: string;
	pathName: string;
	/** `pathways_paths.status`; see `PathViewModel.status`. */
	status: CatalogPath["status"];
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
	status: CatalogPath["status"],
): SyncedLevel[] {
	const levels = [...new Set(catalogProjects.map((p) => p.level))].sort(
		(a, b) => a - b,
	);
	return levels.map((level) => {
		const { total, left } = catalogLevelRequirement(
			catalogProjects,
			pathLevels,
			completeProjectIds,
			level,
			status,
		);
		// `total - left`, not "marked projects at this level" (#898). The naive
		// count credits every marked elective, so three electives marked against
		// a requirement of two would fill the ring while a required project sat
		// unmarked. This way the ring and `projectsLeftAt` cannot disagree.
		return { level, completed: total - left, total, approved: false };
	});
}

/**
 * TI's requirement for one catalog level, and how much of it is still open:
 * the required projects not yet complete, plus however many electives are
 * still to choose. Electives beyond the minimum count for nothing.
 *
 * Education Series presentations (#921) are neither: they are excluded from the
 * elective count and add one each to `total` per series the level requires
 * (`seriesGroups`), met by ANY one complete title of that series. A second
 * title of the same series adds nothing.
 */
function catalogLevelRequirement(
	catalogProjects: CatalogProject[],
	pathLevels: { level: number; minReqElectives: number }[] | undefined,
	completeProjectIds: Set<string>,
	level: number,
	status: CatalogPath["status"],
): {
	total: number;
	left: number;
	electivesToChoose: number;
} {
	const atLevel = catalogProjects.filter((p) => p.level === level);
	const required = atLevel.filter((p) => p.isRequired);
	const minReqElectives =
		pathLevels?.find((l) => l.level === level)?.minReqElectives ?? 0;
	const requiredLeft = required.filter(
		(p) => !completeProjectIds.has(p.projectId),
	).length;
	const completedElectives = atLevel.filter(
		(p) => isElective(p) && completeProjectIds.has(p.projectId),
	).length;
	const electivesToChoose = Math.max(0, minReqElectives - completedElectives);
	const seriesAtLevel = seriesGroups(catalogProjects, level, status);
	const seriesLeft = seriesAtLevel.filter(
		(g) => !g.rows.some((p) => completeProjectIds.has(p.projectId)),
	).length;
	return {
		total: required.length + minReqElectives + seriesAtLevel.length,
		left: requiredLeft + electivesToChoose + seriesLeft,
		electivesToChoose,
	};
}

/**
 * The series a level requires, each with its catalog titles at that level.
 *
 * `seriesRequiredAt` is the rule; a required series with no catalog row at the
 * level is dropped rather than counted, so a level can never wait on a
 * requirement the member has nothing to mark against. On a seeded catalog the
 * two are the same list.
 */
function seriesGroups(
	catalogProjects: CatalogProject[],
	level: number,
	status: CatalogPath["status"],
): { series: PathwaysSeries; rows: CatalogProject[] }[] {
	return seriesRequiredAt(level, status)
		.map((series) => ({
			series,
			rows: catalogProjects.filter(
				(p) => p.level === level && p.series === series,
			),
		}))
		.filter((g) => g.rows.length > 0);
}

/** `PathViewModel.upNextSeries` for one level: the series with nothing complete. */
function seriesStillOwed(
	catalogProjects: CatalogProject[],
	level: number | null,
	status: CatalogPath["status"],
	completeProjectIds: Set<string>,
): UpNextSeries[] {
	if (level === null) return [];
	return seriesGroups(catalogProjects, level, status)
		.filter((g) => !g.rows.some((p) => completeProjectIds.has(p.projectId)))
		.map((g) => ({
			series: g.series,
			label: SERIES_LABEL[g.series],
			options: g.rows.map((p) => ({ projectId: p.projectId, name: p.name })),
		}));
}

/** An elective: not required, and not an Education Series presentation (#921). */
function isElective(p: CatalogProject): boolean {
	return !p.isRequired && p.series === null;
}

/**
 * Projects left at one level, counted the way that level's SOURCE counts:
 *
 * - `basecamp`: `total - min(completed, total)` from `path_level_progress`.
 *   Base Camp's counts are authoritative and are not recomputed from marks. A
 *   level Base Camp has APPROVED has nothing left whatever its counts say.
 * - `catalog`: `levelsFromCatalog` already stored `completed = total - left`,
 *   so the same subtraction gives the required-plus-electives answer.
 */
function projectsLeftAt(level: SyncedLevel): number {
	if (level.approved) return 0;
	return level.total - Math.min(level.completed, level.total);
}

/** Lowest level with projects left; see `PathViewModel.workingLevel`. */
function findWorkingLevel(
	levels: SyncedLevel[],
	levelsSource: "basecamp" | "catalog",
): SyncedLevel | null {
	const real = levels.filter((l) => l.level !== PATH_COMPLETION_LEVEL);
	const open = real.find((l) => projectsLeftAt(l) > 0);
	if (open) return open;
	// Path Completion only once 1–5 are done, and only where there is a count
	// for it. `levels` is sorted, so it would come last anyway; the explicit
	// split keeps the Base Camp half true even if a summary ever carried it.
	if (levelsSource !== "catalog") return null;
	const completion = levels.find((l) => l.level === PATH_COMPLETION_LEVEL);
	return completion && projectsLeftAt(completion) > 0 ? completion : null;
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
			: levelsFromCatalog(
					path.catalogProjects,
					path.pathLevels,
					completeIds,
					path.status,
				);

	const done = levels.reduce((s, l) => s + Math.min(l.completed, l.total), 0);
	const total = levels.reduce((s, l) => s + l.total, 0);
	const ringPercent =
		total === 0 ? 0 : Math.min(100, Math.round((done / total) * 100));
	const firstUnapproved = levels.find((l) => !l.approved);
	const currentLevel = firstUnapproved ? firstUnapproved.level : null;
	// On the catalog branch `approved` is always false, so a path is never
	// reported complete off marks alone — only Base Camp closes a path.
	const complete = !firstUnapproved;
	const working = findWorkingLevel(levels, levelsSource);
	const workingLevel = working ? working.level : null;
	const projectsLeftAtWorkingLevel = working ? projectsLeftAt(working) : 0;

	const base = {
		courseCode: path.courseCode,
		pathName: path.pathName,
		status: path.status,
		ringPercent,
		currentLevel,
		complete,
		workingLevel,
		projectsLeftAtWorkingLevel,
		levels,
		levelsSource,
		hasBasecamp: hasBasecampDetail,
		upNextSeries: seriesStillOwed(
			path.catalogProjects,
			workingLevel,
			path.status,
			completeIds,
		),
	};

	// Project-level branch: taken as soon as EITHER source has per-project truth,
	// or when the levels themselves come from the catalog. That last arm is
	// #898's: a newly declared catalog path with zero marks is not a summary-sync
	// club, and falling through to the fallback below (built for Base Camp) left
	// it with no "Up next" at all. With no marks, "complete" is honestly empty.
	const hasProjectTruth = hasBasecampDetail || marks.length > 0;
	if (hasProjectTruth || levelsSource === "catalog") {
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
		// Base Camp never reports a series presentation (#921), so on a synced
		// club a marked one would read "awaiting processing" forever.
		const seriesIds = new Set(
			path.catalogProjects
				.filter((c) => c.series !== null)
				.map((c) => c.projectId),
		);
		const byId = new Map<string, { level: number; name: string }>();
		for (const p of detail) byId.set(p.projectId, p);
		for (const m of marks) byId.set(m.projectId, m);

		// With no per-project truth (a catalog path nobody has marked yet) there
		// are no completions to list, but the member's DELIVERED speeches are
		// still true, and the fallback below has always shown them. Building wins
		// from `completeIds` alone emptied "Your wins" for exactly the path this
		// arm was added for. With detail or marks, unchanged: completions only.
		const wins: Win[] = !hasProjectTruth
			? path.wins
			: [...completeIds]
					.map((projectId) => {
						const meta = byId.get(projectId);
						const fromDetail = detail.find((p) => p.projectId === projectId);
						const speech = speechByProjectId.get(projectId);
						return {
							projectId,
							level: meta?.level ?? 0,
							name: meta?.name ?? "",
							speechTitle: fromDetail?.speechTitle ?? speech?.speechTitle ?? "",
							deliveredAt:
								fromDetail?.speechDate ?? speech?.deliveredAt ?? null,
							markedHere: markedIds.has(projectId),
							awaitingProcessing:
								hasBasecampDetail &&
								!bcmCompleteIds.has(projectId) &&
								!seriesIds.has(projectId),
						};
					})
					.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));

		let upNext: UpNextProject[] = [];
		let upNextElectives: UpNextElectives | null = null;
		// Keyed off the WORKING level, not `currentLevel` (#898), and gated on it
		// alone: `complete` is about approval, so a catalog path in Path
		// Completion still has something next.
		if (workingLevel !== null) {
			const workingCatalog = path.catalogProjects.filter(
				(c) => c.level === workingLevel,
			);
			upNext = workingCatalog
				.filter((c) => c.isRequired && !completeIds.has(c.projectId))
				.map((c) => ({
					projectId: c.projectId,
					level: c.level,
					name: c.name,
					isRequired: c.isRequired,
				}));

			const { electivesToChoose: chooseCount } = catalogLevelRequirement(
				path.catalogProjects,
				path.pathLevels,
				completeIds,
				workingLevel,
				path.status,
			);
			if (chooseCount > 0) {
				upNextElectives = {
					chooseCount,
					options: workingCatalog
						.filter((c) => isElective(c) && !completeIds.has(c.projectId))
						.map((c) => ({ projectId: c.projectId, name: c.name })),
				};
			}
		}

		return { ...base, wins, upNext, upNextElectives };
	}

	// Inference fallback — a club that summary-synced but never `/detail`-synced.
	//
	// `wins` STAYS: it is a list of speeches this member actually delivered whose
	// project is on this path, and every row of it is true.
	//
	// `upNext` is deliberately EMPTY here, and that is a fix rather than a gap
	// (#456). It used to be "current-level catalog minus the names in `wins`",
	// which answers "has this project been touched at all", not "is it finished":
	//
	//   - Level 1's `Evaluation and Feedback` takes THREE assignments — give a
	//     speech, evaluate someone else's, then give the speech again applying
	//     the feedback. A member who has delivered only the first saw the project
	//     disappear from "Up next" with two assignments outstanding, while `wins`
	//     legitimately listed it, so the screen read as complete.
	//   - Later levels contain projects that are not speeches at all
	//     (`Introduction to Toastmasters Mentoring`, `High Performance
	//     Leadership`, `Manage Successful Events`). Delivered speeches can never
	//     evidence those, so subtracting speech names from the catalog is not an
	//     approximation of progress — it is unrelated to it.
	//
	// Inferring BETTER is not the fix. #420's D2 settled the direction: completion
	// is marked by the member or their VPE, never derived from speeches, because
	// derivation is wrong low (the case above) AND wrong high (someone working
	// ahead has Level 2 speeches delivered while Level 1 sits unapproved). The
	// per-project assignment multiset that would be needed lives only in the Base
	// Camp UI behind a login — the `/detail` payload does not carry it (#409).
	//
	// So this branch now shows only what it knows: the speeches you have
	// delivered. `PathwaysProgress` renders nothing for an empty `upNext` with no
	// electives, so the section disappears rather than making a claim. The one
	// exception is `upNextSeries`, already on `base`: which Education Series a
	// level needs is a catalog fact, not an inference from speeches, and Base
	// Camp never reports one, so this branch knows as much about it as any
	// other. The
	// `bcm_project_progress` branch above is unaffected — Base Camp applies the
	// real completion rule there, which is what makes its `completeIds`
	// authoritative and its `upNext` honest.
	return { ...base, wins: path.wins, upNext: [], upNextElectives: null };
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
	series: PathwaysSeries | null;
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
			series: pathwaysProjects.series,
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
			pathStatus: pathwaysPaths.status,
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
				status: r.pathStatus,
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
			series: c.series,
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
	// PUBLIC read (#544): `getMemberPathways` takes no session.
	if (!(await isReadableClub(clubId))) return [];
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
	// Was `const [p] = … where(userId)` — an arbitrary Person when the account
	// has duplicates, so the dashboard could read a different record than the
	// one the speech picker writes. See person-identity-logic.
	const personId = await resolveUserPersonId(userId);
	if (!personId) return [];
	return pathwaysForPerson(personId);
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
			pathStatus: pathwaysPaths.status,
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
				status: r.pathStatus,
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
			series: c.series,
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
