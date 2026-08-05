/**
 * The Pathways project picker's data (#418) — replacing the free-text
 * `pathway_path` / `project_name` / `project_level` triple with a real
 * `speeches.project_id`.
 *
 * Scoped to the speaker's ENROLLED paths (#417). The catalog is ~420 projects
 * across 11 paths; unscoped it isn't a picker, it's a phone book.
 *
 * A `-logic.ts` so `#/db` never leaks into the client bundle (server-modules
 * guard). Never imported by client code.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "#/db";
import {
	bcmProjectProgress,
	members,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
	pathwaysProjects,
	people,
} from "#/db/schema";
import { PATHWAYS_COURSE_CODES } from "#/lib/basecamp-progress";
import { cap } from "#/lib/cap";
import { defaultOpenLevel, levelLabel } from "#/lib/pathways-catalog";
import { SPEAKER_LIMITS } from "#/lib/speaker-limits";
import { userPersonIds } from "./person-identity-logic";

export interface PickerProject {
	id: string;
	level: number;
	name: string;
	isRequired: boolean;
	/**
	 * Base Camp says this one is done. Display only — a completed project stays
	 * SELECTABLE. Repeats are real: `path_level_progress.completed` may exceed
	 * `total` precisely because members redo electives.
	 *
	 * Always false on the anonymous surface; see `listProjectOptions`.
	 */
	complete: boolean;
}

export interface PickerPath {
	pathId: string;
	courseCode: string;
	name: string;
	status: "current" | "legacy";
	/** Which level group the picker opens on. A convenience, never a restriction. */
	defaultLevel: number;
	projects: PickerProject[];
}

/**
 * The paths + projects this person may pick from.
 *
 * `includeProgress` is the privacy seam. The picker is reachable from the
 * PUBLIC club page (claiming a speaker slot needs no session — the claimant
 * picks their name), and which project someone is *about* to deliver is already
 * public: the agenda prints "Engaging Humor · Ice Breaker · Level 1" today. But
 * which projects they have COMPLETED is a personal educational record that
 * feeds award eligibility, and the public page is only a soft honor-system
 * gate — the same line that already keeps member email and phone behind
 * sign-in. So anonymous callers get the option list with every `complete` false.
 *
 * Enumeration is constrained to the eleven real course codes for the same
 * reason as #417: `pathways_paths` is global (no `club_id`) and any club's sync
 * can insert into it, so one member enrolled in the Pathways Mentor Program
 * would otherwise make it a pickable "path" for every club on the platform.
 */
export async function listProjectOptions(
	personId: string,
	opts: { includeProgress: boolean },
): Promise<PickerPath[]> {
	const enrolled = await db
		.select({
			enrollmentId: pathEnrollments.id,
			pathId: pathwaysPaths.id,
			courseCode: pathwaysPaths.courseCode,
			name: pathwaysPaths.name,
			status: pathwaysPaths.status,
		})
		.from(pathEnrollments)
		.innerJoin(pathwaysPaths, eq(pathEnrollments.pathId, pathwaysPaths.id))
		.where(
			and(
				eq(pathEnrollments.personId, personId),
				isNull(pathEnrollments.archivedAt),
				inArray(pathwaysPaths.courseCode, [...PATHWAYS_COURSE_CODES]),
			),
		)
		.orderBy(asc(pathwaysPaths.sortOrder), asc(pathwaysPaths.courseCode));

	if (enrolled.length === 0) return [];

	const pathIds = enrolled.map((e) => e.pathId);
	const enrollmentIds = enrolled.map((e) => e.enrollmentId);

	const [projectRows, completeRows, levelRows] = await Promise.all([
		db
			.select({
				id: pathwaysProjects.id,
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
			),
		opts.includeProgress
			? db
					.select({ projectId: bcmProjectProgress.projectId })
					.from(bcmProjectProgress)
					.where(
						and(
							inArray(bcmProjectProgress.enrollmentId, enrollmentIds),
							eq(bcmProjectProgress.complete, true),
						),
					)
			: Promise.resolve([] as { projectId: string }[]),
		opts.includeProgress
			? db
					.select({
						enrollmentId: pathLevelProgress.enrollmentId,
						level: pathLevelProgress.level,
						approved: pathLevelProgress.approved,
					})
					.from(pathLevelProgress)
					.where(inArray(pathLevelProgress.enrollmentId, enrollmentIds))
			: Promise.resolve(
					[] as { enrollmentId: string; level: number; approved: boolean }[],
				),
	]);

	const completeIds = new Set(completeRows.map((r) => r.projectId));

	// Highest CONTIGUOUS approved level, so an out-of-order approval doesn't skip
	// the levels still in progress beneath it.
	const approvedByEnrollment = new Map<string, number | null>();
	for (const e of enrolled) {
		const mine = levelRows
			.filter((l) => l.enrollmentId === e.enrollmentId)
			.sort((a, b) => a.level - b.level);
		let through: number | null = null;
		for (const l of mine) {
			if (!l.approved) break;
			through = l.level;
		}
		approvedByEnrollment.set(e.enrollmentId, through);
	}

	return enrolled.map((e) => {
		const projects: PickerProject[] = projectRows
			.filter((p) => p.pathId === e.pathId)
			.map((p) => ({
				id: p.id,
				level: p.level,
				name: p.name,
				isRequired: p.isRequired,
				complete: completeIds.has(p.id),
			}));
		return {
			pathId: e.pathId,
			courseCode: e.courseCode,
			name: e.name,
			status: e.status,
			defaultLevel: defaultOpenLevel(
				projects,
				approvedByEnrollment.get(e.enrollmentId) ?? null,
			),
			projects,
		};
	});
}

/**
 * The Person and club behind a roster member, or null when there is no such
 * member. The club comes from the row rather than the caller, so it can't be
 * asserted wrongly.
 */
export async function resolveMemberSubject(
	memberId: string,
): Promise<{ personId: string; clubId: string } | null> {
	const [m] = await db
		.select({ personId: members.personId, clubId: members.clubId })
		.from(members)
		.where(eq(members.id, memberId));
	return m ?? null;
}

/**
 * May this signed-in viewer see the subject's completion marks?
 *
 * Self, or an admin of the club the picker was opened in. Anything else — a
 * fellow member, a signed-in visitor, an admin of some other club — gets the
 * option list with no progress on it. `clubRole` is only admin|member, with VP
 * Education and President mapping to admin, so the gate is `["admin"]`.
 *
 * Returns a boolean rather than throwing: failing to prove admin is not an
 * error here, it just means a plainer picker.
 *
 * Queries the membership directly rather than calling `guards.getMembership`.
 * That module imports Better-Auth, and `slots-logic.ts` imports this one for
 * `resolveProjectDisplay` — routing through it would drag the whole auth graph
 * into every suite that mocks only `#/db`, which hangs them.
 */
export async function viewerMaySeeProgress(input: {
	userId: string;
	clubId: string;
	personId: string;
}): Promise<boolean> {
	// Every linked Person, not one arbitrary row — see person-identity-logic.
	const mine = await userPersonIds(input.userId);
	if (mine.includes(input.personId)) return true;

	const [membership] = await db
		.select({ clubRole: members.clubRole })
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.where(
			and(eq(people.userId, input.userId), eq(members.clubId, input.clubId)),
		)
		.limit(1);
	return membership?.clubRole === "admin";
}

/** The free-text triple a picked project stands for. */
export interface ProjectDisplay {
	pathwayPath: string;
	projectName: string;
	projectLevel: string;
}

/**
 * Resolve a picked project id to the free-text fields it replaces.
 *
 * The display layer — agenda, print layouts, the projected deck, the run sheet,
 * reporting — all read `pathway_path` / `project_name` / `project_level`, and
 * the schema documents them as "the fallback display until project_id coverage
 * is high". So a picked project WRITES those three from the catalog rather than
 * leaving them to whatever was typed. Every downstream surface keeps working
 * untouched, and the fallback text is guaranteed to match the linked project
 * instead of drifting from it.
 *
 * Re-checks the course-code allowlist on the way in: the picker only offers
 * enrolled, allowlisted paths, but this is a plain uuid over the wire and the
 * claim path is anonymous, so the id is not trusted just because a picker
 * produced one.
 */
export async function resolveProjectDisplay(
	projectId: string,
): Promise<ProjectDisplay> {
	const [row] = await db
		.select({
			level: pathwaysProjects.level,
			projectName: pathwaysProjects.name,
			pathName: pathwaysPaths.name,
			courseCode: pathwaysPaths.courseCode,
		})
		.from(pathwaysProjects)
		.innerJoin(pathwaysPaths, eq(pathwaysPaths.id, pathwaysProjects.pathId))
		.where(eq(pathwaysProjects.id, projectId));

	if (!row || !PATHWAYS_COURSE_CODES.has(row.courseCode)) {
		throw new Error("That Pathways project no longer exists.");
	}

	// CLAMPED to the same caps the typed values get (#526).
	//
	// `applyProjectDisplay` writes these three straight onto the speech AFTER
	// `speakerDetailsSchema` has run, so without this the catalog is a way
	// around a cap the schema advertises. And the catalog is not bounded at its
	// own ingest: `pathways-ingest-logic.ts` types the payload as
	// `z.array(z.unknown())`, bounding only the array LENGTHS, so the name
	// strings inside are unvalidated and a club sync-token holder can store one
	// of any size.
	//
	// Clamping here rather than at ingest because this is the ONE choke point —
	// `applyProjectDisplay` is the only non-test caller — whereas the ingest
	// side has several entry points and legitimately mirrors data we do not
	// control. It also makes the guarantee true for catalog rows already stored.
	//
	// `cap` truncates by code point, so a clamped name can never emit the lone
	// surrogate that a `.slice()` would.
	return {
		pathwayPath: cap(row.pathName, SPEAKER_LIMITS.pathwayPath),
		projectName: cap(row.projectName, SPEAKER_LIMITS.projectName),
		projectLevel: cap(levelLabel(row.level), SPEAKER_LIMITS.projectLevel),
	};
}
