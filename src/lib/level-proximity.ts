// "Close to a level" (#898): which members are one or two projects from
// finishing a Pathways level, and which have finished one Base Camp has not
// approved yet. Pure, with no `#/db`, so the selection is unit-testable and the
// VPE dashboard can import the copy helper under jsdom. The rows come from
// `pathwaysByMember`'s view models. `loadLevelProximity` in
// `reporting-logic.ts` does the reading.
//
// The copy says PROJECTS, never speeches: Level 1's "Evaluation and Feedback"
// takes three assignments, and later levels hold projects that are not speeches
// at all (`pathways-catalog.ts` header).
import { levelLabel } from "#/lib/pathways-catalog";
import type { PathViewModel } from "#/server/pathways-read-logic";

export const LEVEL_PROXIMITY = {
	/** A working level with this many projects left, or fewer (and more than 0), is "close". */
	maxProjectsLeft: 2,
} as const;

export interface LevelProximityRow {
	memberId: string;
	name: string;
	pathName: string;
	/** `workingLevel`, or the level awaiting approval. */
	level: number;
	kind: "close" | "awaiting_approval";
	/** `projectsLeftAtWorkingLevel`; 0 for an awaiting row. */
	projectsLeft: number;
	/** Required projects left at that level. [] when unknown. Informational:
	 *  `projectsLeft` is the count, and the copy never trusts names over it. */
	projectNames: string[];
	/** `upNextElectives?.chooseCount ?? 0`. */
	electivesToChoose: number;
	/** Soonest future speaker slot. Absent if none. */
	upcomingSpeakerAt?: Date;
}

/** The slice of a view model this selection reads. */
export type ProximityPath = Pick<
	PathViewModel,
	| "pathName"
	| "levelsSource"
	| "levels"
	| "workingLevel"
	| "projectsLeftAtWorkingLevel"
	| "upNext"
	| "upNextElectives"
>;

export interface LevelProximityInput {
	/** ACTIVE members only. `pathwaysByMember` returns every membership, so the
	 *  caller's roster is what filters; a member absent here produces no row. */
	members: { memberId: string; name: string }[];
	pathsByMember: Map<string, ProximityPath[]>;
	upcomingSpeakerAt: Map<string, Date>;
}

/**
 * The lowest Base Camp level that is fully done but not approved, or null.
 *
 * Only on the `basecamp` branch. A manual club's levels are never approved (only
 * Base Camp approves), so on the catalog branch every finished level would
 * qualify, and the app cannot know whether one was approved. It must not claim
 * a level is waiting on an approval that may already have happened.
 */
function awaitingLevel(path: ProximityPath): number | null {
	if (path.levelsSource !== "basecamp") return null;
	const level = path.levels.find(
		(l) => l.total > 0 && l.completed >= l.total && !l.approved,
	);
	return level ? level.level : null;
}

function byText(a: string, b: string): number {
	return a.localeCompare(b);
}

/**
 * Every "close" and "awaiting approval" row for a club, ordered for the VPE:
 * awaiting first (by member, then path), then close by fewest projects left,
 * then member, then path.
 *
 * At most one row of each kind per (member, path), and the two kinds are
 * independent: Level 2 awaiting approval and Level 3 one project short is two
 * rows, and neither hides the other.
 */
export function selectLevelProximity(
	input: LevelProximityInput,
): LevelProximityRow[] {
	const awaiting: LevelProximityRow[] = [];
	const close: LevelProximityRow[] = [];

	for (const member of input.members) {
		const paths = input.pathsByMember.get(member.memberId) ?? [];
		const upcomingSpeakerAt = input.upcomingSpeakerAt.get(member.memberId);
		for (const path of paths) {
			const shared = {
				memberId: member.memberId,
				name: member.name,
				pathName: path.pathName,
				...(upcomingSpeakerAt ? { upcomingSpeakerAt } : {}),
			};

			const awaitingAt = awaitingLevel(path);
			if (awaitingAt !== null) {
				// Never copies the working level's fields: nothing is left here.
				awaiting.push({
					...shared,
					level: awaitingAt,
					kind: "awaiting_approval",
					projectsLeft: 0,
					projectNames: [],
					electivesToChoose: 0,
				});
			}

			const left = path.projectsLeftAtWorkingLevel;
			if (
				path.workingLevel !== null &&
				left > 0 &&
				left <= LEVEL_PROXIMITY.maxProjectsLeft
			) {
				close.push({
					...shared,
					level: path.workingLevel,
					kind: "close",
					projectsLeft: left,
					projectNames: path.upNext.map((p) => p.name),
					electivesToChoose: path.upNextElectives?.chooseCount ?? 0,
				});
			}
		}
	}

	awaiting.sort(
		(a, b) => byText(a.name, b.name) || byText(a.pathName, b.pathName),
	);
	close.sort(
		(a, b) =>
			a.projectsLeft - b.projectsLeft ||
			byText(a.name, b.name) ||
			byText(a.pathName, b.pathName),
	);
	return [...awaiting, ...close];
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * What is left, in words. N = `projectsLeft`, R = names known, E = electives
 * to choose:
 *
 * - R = N: "2 left: Inspire Your Audience, Active Listening"
 * - R + E = N, E > 0: "2 left: Inspire Your Audience and 1 elective", or
 *   "2 left: choose 2 electives" when R = 0
 * - otherwise: "2 left". The count is Base Camp's or the catalog's, and names
 *   that do not add up to it (a project Base Camp counts that we cannot name,
 *   the summary-sync fallback) must not be presented as the whole list.
 */
export function projectsLeftCopy(
	row: Pick<
		LevelProximityRow,
		"projectsLeft" | "projectNames" | "electivesToChoose"
	>,
): string {
	const n = row.projectsLeft;
	const r = row.projectNames.length;
	const e = row.electivesToChoose;
	if (r > 0 && r === n) return `${n} left: ${row.projectNames.join(", ")}`;
	if (e > 0 && r + e === n) {
		return r === 0
			? `${n} left: choose ${plural(e, "elective")}`
			: `${n} left: ${row.projectNames.join(", ")} and ${plural(e, "elective")}`;
	}
	return `${n} left`;
}

/** The whole detail line under a member's name. */
export function proximityDetail(row: LevelProximityRow): string {
	const where = `${row.pathName} · ${levelLabel(row.level)}`;
	return row.kind === "awaiting_approval"
		? `${where} · All projects done, approve in Base Camp`
		: `${where} · ${projectsLeftCopy(row)}`;
}
