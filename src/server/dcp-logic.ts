// Distinguished Club Program (DCP) DB logic (#207 / ADR-0019), split out from the
// `createServerFn` wrappers in `dcp.ts` so the Start compiler strips it from the
// client bundle (enforced by `server-modules.guard.test.ts`) — a plain
// db-touching export in the server-fn module would drag `pg` → `Buffer` into the
// browser. All the tier/base/catalog math is the pure, client-safe `#/lib/dcp`.
//
// Goals are President-entered. THREE assists SUGGEST values without writing on
// their own: g7/g8 pre-filled at start from `members.joinedAt` in the
// program-year window, g1–g6 live-derived from this club's dated Pathways
// completions (#245 / ADR-0022), and g9 live-derived from its Club Officer
// Training records (#531). The last two are stored only when explicitly
// applied. The recognition tier + membership base are DERIVED at read time,
// never stored.
//
// That count read "Two assists" until #531, and keeping it accurate matters:
// this is the paragraph a future author reads to learn the house style, and
// ADR-0019's position is that TI — not GavelUp — is the system of record for
// every one of these goals, so no derivation may write on its own.
import {
	and,
	asc,
	count,
	eq,
	gte,
	inArray,
	isNotNull,
	lt,
	sql,
} from "drizzle-orm";
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
import { TRAINING_GOAL_KEY } from "#/lib/officer-training";
import { logActivity } from "./activity";
import { deriveTrainingSuggestion } from "./officer-training-logic";

/**
 * The acting MEMBERSHIP id for the `activity_log` row a DCP write appends
 * (#690), null for a read-write impersonating superadmin — memberless in the
 * club, so `logActivity` credits the real person via `impersonated_by` instead.
 *
 * Deliberately a separate parameter from the `updatedBy` these functions already
 * took, because the two are different ids answering different questions and they
 * are NOT interchangeable: `updatedBy` is a USER id stamping
 * `dcp_goal_progress.updated_by` (the row-level "who touched this value last",
 * overwritten by the next edit and gone with the row), while this is a
 * MEMBERSHIP id, which is the only thing the club's activity feed can render a
 * name from. Mistaking the first for an audit trail is what #690 was: it holds
 * no history, no before value, and `dcp_scoreboards` — where the membership base
 * lives — has no such column at all.
 *
 * Optional so the existing DB-level tests keep calling these functions with no
 * actor (an honest "system" row, which `logActivity` is null-aware about). Every
 * real call site is a server fn in `dcp.ts` and passes the membership
 * `requireClubRole` already resolved — NEVER a value off the client payload
 * (#396 / `actor-provenance.guard.test.ts`).
 */
type ActorMemberId = string | null;

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
	/**
	 * Live Club Officer Training SUGGESTION for the composite goal 9 (#531).
	 * Always computed, never stored — `progress.g9` stays the only thing that
	 * scores, so this counts toward nothing until the President applies it.
	 */
	derivedTraining: {
		/** What an apply would write: 0 or 1. */
		suggestion: number;
		/** Distinct PEOPLE trained, [period 1, period 2]. */
		trainedByPeriod: number[];
		/**
		 * Whether ANY training is recorded for the year. A bare `suggestion: 0` is
		 * ambiguous — "recorded and genuinely short" vs "never recorded anything" —
		 * and applying the second would clear a President's hand-entered Met. The UI
		 * only offers the apply when this is true, exactly as `pathwaysSynced` gates
		 * the education assist.
		 */
		hasRecords: boolean;
	};
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
		derivedTraining,
	] = await Promise.all([
		findScoreboard(clubId, programYear),
		countActiveMembers(clubId),
		countNewMembers(clubId, programYear),
		deriveEducationGoals(clubId, programYear),
		hasPathwaysCompletions(clubId),
		deriveTrainingSuggestion(clubId, programYear),
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
		derivedTraining,
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
	actorMemberId: ActorMemberId = null,
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
			// Same transaction as the write it describes — an audit row that can
			// commit while the scoreboard does not is worse than none. Inside the
			// `if (!board)` guard above deliberately: a start that LOST the race
			// created nothing, and logging it would put two "started the scoreboard"
			// entries in the feed for one scoreboard.
			await logActivity(tx, {
				clubId,
				actorMemberId,
				action: "dcp_scoreboard_edit",
				targetType: "scoreboard",
				targetId: board.id,
				// `before: null` is the honest before for a create — the scoreboard
				// did not exist. `after` is what the start actually snapshotted and
				// pre-filled, which is the part a reader would otherwise have to
				// reconstruct from the roster as it stood that day.
				detail: {
					change: "started",
					programYear,
					before: null,
					after: { baseMemberCount: currentActive, ...prefill },
				},
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
): Promise<{ id: string; baseMemberCount: number | null }> {
	const board = await findScoreboard(clubId, programYear);
	if (!board) {
		throw new Error("No DCP scoreboard has been started for that year.");
	}
	return board;
}

/**
 * The stored `achieved` for the named goals, keyed by goal — the BEFORE half of
 * an audit entry (#690). A goal with no row yet reads as absent rather than 0:
 * "was never set" and "was set to 0" are different facts, and on the composite
 * goals the second is a President's explicit Not Met.
 */
async function readGoalProgress(
	scoreboardId: string,
	goalKeys: string[],
): Promise<Record<string, number>> {
	if (goalKeys.length === 0) return {};
	const rows = await db
		.select({
			goalKey: dcpGoalProgress.goalKey,
			achieved: dcpGoalProgress.achieved,
		})
		.from(dcpGoalProgress)
		.where(
			and(
				eq(dcpGoalProgress.scoreboardId, scoreboardId),
				inArray(dcpGoalProgress.goalKey, goalKeys),
			),
		);
	return Object.fromEntries(rows.map((r) => [r.goalKey, r.achieved]));
}

/**
 * The goals whose value actually MOVED, as `{ before, after }` maps over that
 * subset. This is what makes an apply's audit entry say something: a batch that
 * re-wrote six goals and changed none is a different event from one that raised
 * two, and an entry listing all six either way tells a reader nothing.
 */
function diffGoals(
	before: Record<string, number>,
	after: Record<string, number>,
): {
	goals: string[];
	before: Record<string, number | null>;
	after: Record<string, number>;
} {
	const goals = Object.keys(after).filter((k) => before[k] !== after[k]);
	return {
		goals,
		before: Object.fromEntries(goals.map((k) => [k, before[k] ?? null])),
		after: Object.fromEntries(goals.map((k) => [k, after[k] as number])),
	};
}

export const updateGoalSchema = z.object({
	clubId: z.string().uuid(),
	programYear: z.number().int().min(2000).max(2100),
	goalKey: z.string(),
	achieved: z.number().int().nonnegative(),
});
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;

/** A drizzle transaction handle, so a writer and the audit row it produces can
 *  commit together. Same shape `logActivity` accepts. */
type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * Upsert ONE goal's stored value, with the composite 0/1 clamp, and no audit
 * entry. Private, and the ONLY place the clamp is written: a second copy is a
 * second place it can be forgotten, which is the rule `applyTrainingSuggestion`
 * already followed by calling `updateGoal`. It is extracted here so that rule
 * survives #690 — `updateGoal` now also logs, and an apply must not file as a
 * hand edit. (The education apply below keeps its own multi-row upsert: it
 * writes only count goals, which the clamp does not touch, and "all six or none"
 * is the point of that single statement.) Each public writer wraps this and logs
 * the event it actually is — a President typing a number is not the same feed
 * entry as a President accepting a derivation, even when the row is identical.
 *
 * Returns the value as STORED (post-clamp), which is the `after` an audit entry
 * must record: logging the requested 7 for a composite goal that stored 1 would
 * make the trail disagree with the scoreboard.
 */
async function writeGoalValue(
	conn: Tx,
	scoreboardId: string,
	goal: { key: string; composite?: boolean },
	requested: number,
	updatedBy: string | null,
): Promise<number> {
	const achieved = goal.composite ? (requested > 0 ? 1 : 0) : requested;
	const updatedAt = new Date();
	await conn
		.insert(dcpGoalProgress)
		.values({
			scoreboardId,
			goalKey: goal.key,
			achieved,
			updatedBy,
			updatedAt,
		})
		.onConflictDoUpdate({
			target: [dcpGoalProgress.scoreboardId, dcpGoalProgress.goalKey],
			set: { achieved, updatedBy, updatedAt },
		});
	return achieved;
}

/**
 * Set a single goal's `achieved` value. Composite goals (9, 10) are clamped to a
 * 0/1 toggle; count goals keep their raw value (may exceed target). Stamps the
 * editing user on the row, and appends the `activity_log` entry the club's feed
 * reads (#690) — the row stamp records only who touched it LAST, so it is not by
 * itself an answer to "who changed this, and when".
 */
export async function updateGoal(
	input: UpdateGoalInput,
	updatedBy: string | null,
	actorMemberId: ActorMemberId = null,
): Promise<{ ok: true }> {
	const goal = goalByKey(input.goalKey);
	if (!goal) throw new Error("Unknown DCP goal.");
	const board = await requireScoreboard(input.clubId, input.programYear);
	// Read the BEFORE outside the transaction the write runs in: it is the value
	// the President was looking at, and an entry that carries only the new number
	// says nothing a reader could not already see on the scoreboard.
	const before = await readGoalProgress(board.id, [goal.key]);

	await db.transaction(async (tx) => {
		const achieved = await writeGoalValue(
			tx,
			board.id,
			goal,
			input.achieved,
			updatedBy,
		);
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId,
			action: "dcp_scoreboard_edit",
			targetType: "scoreboard",
			targetId: board.id,
			detail: {
				change: "goal",
				programYear: input.programYear,
				goalKey: goal.key,
				before: before[goal.key] ?? null,
				after: achieved,
			},
		});
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
 *
 * Audited as ONE `dcp_suggestion_applied` entry naming the goals that actually
 * moved (#690), not six entries and not one per goal: "the President accepted
 * the Pathways assist" is a single event, and six rows would bury the rest of
 * the feed under one click.
 */
export async function applyEducationSuggestions(
	input: ApplyEducationInput,
	updatedBy: string | null,
	actorMemberId: ActorMemberId = null,
): Promise<DcpScoreboardView> {
	const { clubId, programYear } = input;
	const board = await requireScoreboard(clubId, programYear);
	const derived = await deriveEducationGoals(clubId, programYear);
	const updatedAt = new Date();
	const before = await readGoalProgress(board.id, [...EDUCATION_GOAL_KEYS]);
	const after = Object.fromEntries(
		EDUCATION_GOAL_KEYS.map((k) => [k, derived[k] ?? 0]),
	);

	await db.transaction(async (tx) => {
		await tx
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
		await logActivity(tx, {
			clubId,
			actorMemberId,
			action: "dcp_suggestion_applied",
			targetType: "scoreboard",
			targetId: board.id,
			detail: {
				change: "education",
				programYear,
				// An apply that moved nothing still logs, with an empty `goals`: the
				// President took the action, and "accepted the assist, nothing
				// changed" is a true and occasionally useful line. It is the goal
				// LIST that carries the information, not the entry's existence.
				...diffGoals(before, after),
			},
		});
	});

	return getScoreboard({ clubId, programYear });
}

export const applyTrainingSchema = z.object({
	clubId: z.string().uuid(),
	programYear: z.number().int().min(2000).max(2100),
});
export type ApplyTrainingInput = z.infer<typeof applyTrainingSchema>;

/**
 * Write the live Club Officer Training suggestion into stored goal 9 (#531) —
 * the President reviewing and accepting the derivation. The third assist,
 * mirroring {@link applyEducationSuggestions}.
 *
 * Scoped to `g9` alone: nothing else on the scoreboard is touched. It goes
 * through {@link writeGoalValue} rather than writing `dcp_goal_progress`
 * directly so the composite 0/1 clamp and the `updatedBy` stamp are applied by
 * the one function that owns them — a second upsert here would be a second place
 * the clamp could be forgotten. It stops one level short of `updateGoal`, which
 * is what it used to call, for the audit trail alone (#690): `updateGoal` logs
 * `dcp_scoreboard_edit`, and an accepted suggestion filed as a typed-in number
 * is exactly the confusion the two-value vocabulary exists to prevent.
 *
 * It CAN write a 0, which clears a hand-entered Met, and that is deliberate: the
 * President is accepting what the records say, and the alternative (an apply that
 * silently refuses to lower a value) would leave the scoreboard disagreeing with
 * the panel beside it.
 *
 * What it must NOT do is write a 0 on no evidence. `hasRecords` is asserted HERE
 * and not only in the UI: the button is hidden without records, but a stale tab,
 * a replayed POST or any direct call would otherwise clear a President's manual
 * Met for a club that has recorded nothing. That is the #573 shape CLAUDE.md
 * records — a one-tap action wired to a write whose floor was optional — except
 * that here the floor was absent server-side entirely while
 * `deriveTrainingSuggestion` already returned the fact and this function
 * destructured it away.
 */
export async function applyTrainingSuggestion(
	input: ApplyTrainingInput,
	updatedBy: string | null,
	actorMemberId: ActorMemberId = null,
): Promise<DcpScoreboardView> {
	const { clubId, programYear } = input;
	const board = await requireScoreboard(clubId, programYear);
	const { suggestion, hasRecords } = await deriveTrainingSuggestion(
		clubId,
		programYear,
	);
	if (!hasRecords) {
		throw new Error(
			"Record officer training first — there is nothing to apply to goal 9 yet.",
		);
	}
	const goal = goalByKey(TRAINING_GOAL_KEY);
	if (!goal) throw new Error("Unknown DCP goal.");
	const before = await readGoalProgress(board.id, [goal.key]);

	await db.transaction(async (tx) => {
		const achieved = await writeGoalValue(
			tx,
			board.id,
			goal,
			suggestion,
			updatedBy,
		);
		await logActivity(tx, {
			clubId,
			actorMemberId,
			action: "dcp_suggestion_applied",
			targetType: "scoreboard",
			targetId: board.id,
			// Same `{ goals, before, after }` shape as the education apply, over the
			// one goal this touches, so a reader of the feed (or of this code) does
			// not have to learn two payloads for the same kind of event.
			detail: {
				change: "training",
				programYear,
				...diffGoals(before, { [goal.key]: achieved }),
			},
		});
	});
	return getScoreboard({ clubId, programYear });
}

export const updateBaseSchema = z.object({
	clubId: z.string().uuid(),
	programYear: z.number().int().min(2000).max(2100),
	baseMemberCount: z.number().int().nonnegative().nullable(),
});
export type UpdateBaseInput = z.infer<typeof updateBaseSchema>;

/**
 * Correct the year's snapshotted base member count (used by the net-+5 rule).
 *
 * The one DCP write with no row-level `updated_by` to fall back on —
 * `dcp_scoreboards` has no such column — so before #690 a change to the number
 * the whole membership half of the scoreboard is scored against was recorded
 * absolutely nowhere.
 *
 * A no-op call returns without writing OR logging. This is load-bearing rather
 * than an optimisation: the baseline field on the DCP page saves on BLUR and,
 * unlike the goal inputs beside it, does not compare against the current value
 * first — so tabbing through it calls this function with the number already
 * stored. Before #690 that was an invisible redundant UPDATE; with an audit
 * entry attached it would mint "corrected the DCP membership base" rows whose
 * before and after are identical, in the one feed this whole change exists to
 * make worth reading. A trail padded with non-events is how a club learns to
 * stop reading it.
 *
 * The comparison is `===` on `number | null` and the null arm is deliberate:
 * null is "never snapshotted", which the ≥20-active rule treats differently
 * from a snapshotted 0, so null → 0 and 0 → null are both REAL changes and must
 * still log. Only null → null and n → n are the no-op.
 */
export async function updateBaseMemberCount(
	input: UpdateBaseInput,
	actorMemberId: ActorMemberId = null,
): Promise<{ ok: true }> {
	const board = await requireScoreboard(input.clubId, input.programYear);
	if (board.baseMemberCount === input.baseMemberCount) return { ok: true };
	await db.transaction(async (tx) => {
		await tx
			.update(dcpScoreboards)
			.set({ baseMemberCount: input.baseMemberCount, updatedAt: new Date() })
			.where(
				and(
					eq(dcpScoreboards.clubId, input.clubId),
					eq(dcpScoreboards.programYear, input.programYear),
				),
			);
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId,
			action: "dcp_scoreboard_edit",
			targetType: "scoreboard",
			targetId: board.id,
			detail: {
				change: "base",
				programYear: input.programYear,
				// `findScoreboard` already selected the old value, so the BEFORE costs
				// no extra query. Both ends are nullable: null is "not snapshotted",
				// which the ≥20-active rule treats differently from a 0.
				before: board.baseMemberCount,
				after: input.baseMemberCount,
			},
		});
	});
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
