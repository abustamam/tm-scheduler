// Distinguished Club Program (DCP) DB logic (#207 / ADR-0019), split out from the
// `createServerFn` wrappers in `dcp.ts` so the Start compiler strips it from the
// client bundle (enforced by `server-modules.guard.test.ts`) — a plain
// db-touching export in the server-fn module would drag `pg` → `Buffer` into the
// browser. All the tier/base/catalog math is the pure, client-safe `#/lib/dcp`.
//
// Goals are President-entered. Two assists SUGGEST values without writing on
// their own: g7/g8 pre-filled at start from `members.joinedAt` in the
// program-year window, and g1–g6 live-derived from this club's dated Pathways
// completions (#245 / ADR-0022) and only stored when explicitly applied. The
// recognition tier + membership base are DERIVED at read time, never stored.
import { and, asc, count, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import {
	dcpGoalProgress,
	dcpScoreboards,
	members,
	pathLevelProgress,
} from "#/db/schema";
import {
	computeDcpSummary,
	DCP_GOALS,
	type DcpSummary,
	EDUCATION_GOAL_KEYS,
	type EducationLevelCounts,
	educationGoalsFromLevelCounts,
	goalByKey,
	programYearWindow,
	splitNewMembers,
} from "#/lib/dcp";

export interface DcpScoreboardView {
	programYear: number;
	/** false → no scoreboard started for this club-year yet. */
	exists: boolean;
	baseMemberCount: number | null;
	/** Active roster count now (drives the ≥20 base rule). */
	currentActive: number;
	/** Members whose `joined_at` falls in the program-year window (the g7/g8 hint). */
	newMemberCount: number;
	/** goalKey → achieved (all zero when not started). */
	progress: Record<string, number>;
	/**
	 * Live Pathways-derived SUGGESTIONS for education goals 1–6 (#245). Always
	 * computed, never stored — `progress` stays the only thing that scores, so a
	 * suggestion counts toward nothing until the President Applies it.
	 */
	derivedEducation: Record<string, number>;
	/**
	 * Whether this club has any dated, club-credited Pathways completion at all
	 * (any year). A zero derived value is ambiguous — "synced and genuinely zero"
	 * vs "never synced" — so the UI needs this to know whether to offer the
	 * suggestions or fall back to pure manual entry.
	 */
	pathwaysSynced: boolean;
	summary: DcpSummary;
}

// ---------------------------------------------------------------------------
// Roster-derived counts
// ---------------------------------------------------------------------------

/** Active members in the club now — the ≥20 half of the DCP membership base. */
export async function countActiveMembers(clubId: string): Promise<number> {
	const rows = await db
		.select({ id: members.id })
		.from(members)
		.where(and(eq(members.clubId, clubId), eq(members.status, "active")));
	return rows.length;
}

/**
 * New members added in the program year = members whose per-club `joined_at`
 * falls in the [Jul 1, Jul 1 next year) window. `joined_at` null is excluded;
 * status is NOT filtered — a member who joined this year and later went inactive
 * still counts as a new member added (DCP credits additions).
 */
export async function countNewMembers(
	clubId: string,
	programYear: number,
): Promise<number> {
	const { start, end } = programYearWindow(programYear);
	const rows = await db
		.select({ id: members.id })
		.from(members)
		.where(
			and(
				eq(members.clubId, clubId),
				isNotNull(members.joinedAt),
				gte(members.joinedAt, start),
				lt(members.joinedAt, end),
			),
		);
	return rows.length;
}

// ---------------------------------------------------------------------------
// Pathways-derived education awards (#245 / ADR-0022)
// ---------------------------------------------------------------------------

/**
 * Count this club's *education awards* for the program year, by level.
 *
 * The countable pool is `path_level_progress` rows that are `approved`, credited
 * to THIS club, and whose `completed_at` falls inside the year. Rows where
 * `completed_at` is null are levels that were already approved before this club
 * first synced the enrollment — ADR-0022 never fabricates a date for them, so
 * they are excluded and need manual entry.
 *
 * Counting is per-row (award-counting), deliberately NOT per-member: the unique
 * index is (enrollment, level), so one person finishing the same level in two
 * paths yields two rows and two awards — which is how DCP credits them.
 */
export async function countEducationAwards(
	clubId: string,
	programYear: number,
): Promise<EducationLevelCounts> {
	const { start, end } = programYearWindow(programYear);
	const rows = await db
		.select({ level: pathLevelProgress.level, n: count() })
		.from(pathLevelProgress)
		.where(
			and(
				eq(pathLevelProgress.creditedClubId, clubId),
				eq(pathLevelProgress.approved, true),
				// Redundant against the range below (NULL satisfies neither bound),
				// but states the ADR-0022 exclusion rule literally.
				isNotNull(pathLevelProgress.completedAt),
				gte(pathLevelProgress.completedAt, start),
				lt(pathLevelProgress.completedAt, end),
			),
		)
		.groupBy(pathLevelProgress.level);

	const byLevel = new Map(rows.map((r) => [r.level, Number(r.n)]));
	return {
		n1: byLevel.get(1) ?? 0,
		n2: byLevel.get(2) ?? 0,
		n3: byLevel.get(3) ?? 0,
		// "Level 4, Level 5, or a Path" — see educationGoalsFromLevelCounts.
		n45: (byLevel.get(4) ?? 0) + (byLevel.get(5) ?? 0),
	};
}

/**
 * Has this club ever witnessed a Pathways completion? Any single dated,
 * club-credited row (in ANY program year) proves the Base Camp sync has run for
 * this club, which is what distinguishes a real zero from "no data".
 */
export async function hasPathwaysCompletions(clubId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: pathLevelProgress.id })
		.from(pathLevelProgress)
		.where(
			and(
				eq(pathLevelProgress.creditedClubId, clubId),
				isNotNull(pathLevelProgress.completedAt),
			),
		)
		.limit(1);
	return Boolean(row);
}

/** The live education-goal suggestions for a club-year (g1–g6). */
export async function deriveEducationGoals(
	clubId: string,
	programYear: number,
): Promise<Record<string, number>> {
	return educationGoalsFromLevelCounts(
		await countEducationAwards(clubId, programYear),
	);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

async function findScoreboard(clubId: string, programYear: number) {
	const [row] = await db
		.select({
			id: dcpScoreboards.id,
			baseMemberCount: dcpScoreboards.baseMemberCount,
		})
		.from(dcpScoreboards)
		.where(
			and(
				eq(dcpScoreboards.clubId, clubId),
				eq(dcpScoreboards.programYear, programYear),
			),
		)
		.limit(1);
	return row ?? null;
}

export const getScoreboardSchema = z.object({
	clubId: z.string().uuid(),
	programYear: z.number().int().min(2000).max(2100),
});
export type GetScoreboardInput = z.infer<typeof getScoreboardSchema>;

/** The loader-friendly view for one club-year: the stored progress (if started)
 *  plus the roster-derived counts and the derived summary. */
export async function getScoreboard(
	input: GetScoreboardInput,
): Promise<DcpScoreboardView> {
	const { clubId, programYear } = input;
	const [
		board,
		currentActive,
		newMemberCount,
		derivedEducation,
		pathwaysSynced,
	] = await Promise.all([
		findScoreboard(clubId, programYear),
		countActiveMembers(clubId),
		countNewMembers(clubId, programYear),
		deriveEducationGoals(clubId, programYear),
		hasPathwaysCompletions(clubId),
	]);

	const progress: Record<string, number> = {};
	for (const g of DCP_GOALS) progress[g.key] = 0;
	if (board) {
		const rows = await db
			.select({
				goalKey: dcpGoalProgress.goalKey,
				achieved: dcpGoalProgress.achieved,
			})
			.from(dcpGoalProgress)
			.where(eq(dcpGoalProgress.scoreboardId, board.id));
		for (const r of rows) {
			if (r.goalKey in progress) progress[r.goalKey] = r.achieved;
		}
	}

	const baseMemberCount = board?.baseMemberCount ?? null;
	return {
		programYear,
		exists: Boolean(board),
		baseMemberCount,
		currentActive,
		newMemberCount,
		progress,
		derivedEducation,
		pathwaysSynced,
		// Scores from STORED progress only — derived suggestions never count.
		summary: computeDcpSummary({ progress, currentActive, baseMemberCount }),
	};
}

// ---------------------------------------------------------------------------
// Start (lazy create): snapshot the base, seed the 10 goals, pre-fill g7/g8
// ---------------------------------------------------------------------------

export const startScoreboardSchema = z.object({
	clubId: z.string().uuid(),
	programYear: z.number().int().min(2000).max(2100),
});
export type StartScoreboardInput = z.infer<typeof startScoreboardSchema>;

/**
 * Create a club-year scoreboard: snapshot `baseMemberCount` = current active
 * count, seed one goal row per catalog goal (achieved 0), and pre-fill the two
 * new-member goals (g7/g8) from the roster join dates. Idempotent — a second call
 * (e.g. a double-click) returns the existing scoreboard without reseeding.
 */
export async function startScoreboard(
	input: StartScoreboardInput,
): Promise<DcpScoreboardView> {
	const { clubId, programYear } = input;
	const existing = await findScoreboard(clubId, programYear);
	if (!existing) {
		const [currentActive, newMemberCount] = await Promise.all([
			countActiveMembers(clubId),
			countNewMembers(clubId, programYear),
		]);
		const { g7, g8 } = splitNewMembers(newMemberCount);
		const prefill: Record<string, number> = { g7, g8 };

		await db.transaction(async (tx) => {
			const [board] = await tx
				.insert(dcpScoreboards)
				.values({ clubId, programYear, baseMemberCount: currentActive })
				.onConflictDoNothing({
					target: [dcpScoreboards.clubId, dcpScoreboards.programYear],
				})
				.returning({ id: dcpScoreboards.id });
			// Lost a race to a concurrent start — the winner already seeded it.
			if (!board) return;
			await tx
				.insert(dcpGoalProgress)
				.values(
					DCP_GOALS.map((g) => ({
						scoreboardId: board.id,
						goalKey: g.key,
						achieved: prefill[g.key] ?? 0,
					})),
				)
				.onConflictDoNothing({
					target: [dcpGoalProgress.scoreboardId, dcpGoalProgress.goalKey],
				});
		});
	}
	return getScoreboard({ clubId, programYear });
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

async function requireScoreboard(
	clubId: string,
	programYear: number,
): Promise<{ id: string }> {
	const board = await findScoreboard(clubId, programYear);
	if (!board) {
		throw new Error("No DCP scoreboard has been started for that year.");
	}
	return board;
}

export const updateGoalSchema = z.object({
	clubId: z.string().uuid(),
	programYear: z.number().int().min(2000).max(2100),
	goalKey: z.string(),
	achieved: z.number().int().nonnegative(),
});
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;

/**
 * Set a single goal's `achieved` value. Composite goals (9, 10) are clamped to a
 * 0/1 toggle; count goals keep their raw value (may exceed target). Stamps the
 * editing user for the audit trail.
 */
export async function updateGoal(
	input: UpdateGoalInput,
	updatedBy: string | null,
): Promise<{ ok: true }> {
	const goal = goalByKey(input.goalKey);
	if (!goal) throw new Error("Unknown DCP goal.");
	const board = await requireScoreboard(input.clubId, input.programYear);
	const achieved = goal.composite
		? input.achieved > 0
			? 1
			: 0
		: input.achieved;

	await db
		.insert(dcpGoalProgress)
		.values({
			scoreboardId: board.id,
			goalKey: goal.key,
			achieved,
			updatedBy,
			updatedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: [dcpGoalProgress.scoreboardId, dcpGoalProgress.goalKey],
			set: { achieved, updatedBy, updatedAt: new Date() },
		});
	return { ok: true };
}

export const applyEducationSchema = z.object({
	clubId: z.string().uuid(),
	programYear: z.number().int().min(2000).max(2100),
});
export type ApplyEducationInput = z.infer<typeof applyEducationSchema>;

/**
 * Write the live Pathways suggestions into the stored scoreboard for goals 1–6
 * (#245) — the President reviewing and accepting the derivation.
 *
 * One multi-row upsert, so all six land or none do. Deliberately scoped to the
 * education goals: g7/g8 (new members), the composite g9/g10, and the membership
 * base are never touched. The suggestions stay live afterward — the next read
 * re-derives, so later completions resurface as a new suggestion to apply.
 */
export async function applyEducationSuggestions(
	input: ApplyEducationInput,
	updatedBy: string | null,
): Promise<DcpScoreboardView> {
	const { clubId, programYear } = input;
	const board = await requireScoreboard(clubId, programYear);
	const derived = await deriveEducationGoals(clubId, programYear);
	const updatedAt = new Date();

	await db
		.insert(dcpGoalProgress)
		.values(
			EDUCATION_GOAL_KEYS.map((goalKey) => ({
				scoreboardId: board.id,
				goalKey,
				achieved: derived[goalKey] ?? 0,
				updatedBy,
				updatedAt,
			})),
		)
		.onConflictDoUpdate({
			target: [dcpGoalProgress.scoreboardId, dcpGoalProgress.goalKey],
			set: { achieved: sql`excluded.achieved`, updatedBy, updatedAt },
		});

	return getScoreboard({ clubId, programYear });
}

export const updateBaseSchema = z.object({
	clubId: z.string().uuid(),
	programYear: z.number().int().min(2000).max(2100),
	baseMemberCount: z.number().int().nonnegative().nullable(),
});
export type UpdateBaseInput = z.infer<typeof updateBaseSchema>;

/** Correct the year's snapshotted base member count (used by the net-+5 rule). */
export async function updateBaseMemberCount(
	input: UpdateBaseInput,
): Promise<{ ok: true }> {
	await requireScoreboard(input.clubId, input.programYear);
	await db
		.update(dcpScoreboards)
		.set({ baseMemberCount: input.baseMemberCount, updatedAt: new Date() })
		.where(
			and(
				eq(dcpScoreboards.clubId, input.clubId),
				eq(dcpScoreboards.programYear, input.programYear),
			),
		);
	return { ok: true };
}

/** Program years a club has a scoreboard for, newest first (for the year picker). */
export async function listScoreboardYears(clubId: string): Promise<number[]> {
	const rows = await db
		.select({ programYear: dcpScoreboards.programYear })
		.from(dcpScoreboards)
		.where(eq(dcpScoreboards.clubId, clubId))
		.orderBy(asc(dcpScoreboards.programYear));
	return rows.map((r) => r.programYear).reverse();
}
