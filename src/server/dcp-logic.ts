// Distinguished Club Program (DCP) DB logic (#207 / ADR-0019), split out from the
// `createServerFn` wrappers in `dcp.ts` so the Start compiler strips it from the
// client bundle (enforced by `server-modules.guard.test.ts`) — a plain
// db-touching export in the server-fn module would drag `pg` → `Buffer` into the
// browser. All the tier/base/catalog math is the pure, client-safe `#/lib/dcp`.
//
// v1 is a MANUAL scoreboard: only the two new-member goals (g7/g8) are
// roster-derived (pre-filled at start from `members.joinedAt` in the program-year
// window); every other goal is hand-entered. The recognition tier + membership
// base are DERIVED at read time, never stored.
import { and, asc, eq, gte, isNotNull, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { dcpGoalProgress, dcpScoreboards, members } from "#/db/schema";
import {
	computeDcpSummary,
	DCP_GOALS,
	type DcpSummary,
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
	const [board, currentActive, newMemberCount] = await Promise.all([
		findScoreboard(clubId, programYear),
		countActiveMembers(clubId),
		countNewMembers(clubId, programYear),
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
