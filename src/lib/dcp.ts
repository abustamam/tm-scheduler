// Pure, client-safe Distinguished Club Program (DCP) helpers (#207 / ADR-0019).
// NO `#/db` import lives here so both the server logic (`src/server/dcp-logic.ts`)
// and the client route (`src/routes/_authed/admin/dcp.tsx`) can share the goal
// catalog and the tier/base math without dragging `pg` into the browser bundle.
//
// v1 is a MANUAL scoreboard: every goal is hand-entered except the two
// new-member goals, which are pre-filled from the roster (see `splitNewMembers`).
// The education goals (1–6) auto-derivation is deferred (#245).

export type DcpGoalCategory =
	| "education"
	| "membership"
	| "training"
	| "administration";

export interface DcpGoal {
	/** Stable key stored on `dcp_goal_progress.goal_key`. */
	key: string;
	label: string;
	category: DcpGoalCategory;
	/** `met` = achieved ≥ target. */
	target: number;
	/**
	 * Composite goals (9 training, 10 admin) are scored by Toastmasters as a
	 * single met/not — the President toggles them (stored as achieved 0/1) rather
	 * than entering a count. `target` is 1 for these.
	 */
	composite: boolean;
}

/**
 * The 10 standardized Distinguished Club Program goals (Pathways era). A static
 * catalog in code — the goals are set annually by Toastmasters International and
 * are stable, so they are NOT stored as data (only per-club progress is). Order
 * is the canonical TI order and drives the scoreboard layout.
 */
export const DCP_GOALS: readonly DcpGoal[] = [
	{
		key: "g1",
		label: "Four members achieve Level 1",
		category: "education",
		target: 4,
		composite: false,
	},
	{
		key: "g2",
		label: "Two members achieve Level 2",
		category: "education",
		target: 2,
		composite: false,
	},
	{
		key: "g3",
		label: "Two additional members achieve Level 2",
		category: "education",
		target: 2,
		composite: false,
	},
	{
		key: "g4",
		label: "Two members achieve Level 3",
		category: "education",
		target: 2,
		composite: false,
	},
	{
		key: "g5",
		label: "One member achieves Level 4, Level 5, or a Path",
		category: "education",
		target: 1,
		composite: false,
	},
	{
		key: "g6",
		label: "One additional member achieves Level 4, Level 5, or a Path",
		category: "education",
		target: 1,
		composite: false,
	},
	{
		key: "g7",
		label: "Four new members",
		category: "membership",
		target: 4,
		composite: false,
	},
	{
		key: "g8",
		label: "Four additional new members",
		category: "membership",
		target: 4,
		composite: false,
	},
	{
		key: "g9",
		label: "Minimum four officers trained in each of the two training periods",
		category: "training",
		target: 1,
		composite: true,
	},
	{
		key: "g10",
		label: "On-time dues renewal and officer-list submission",
		category: "administration",
		target: 1,
		composite: true,
	},
];

const GOAL_BY_KEY = new Map(DCP_GOALS.map((g) => [g.key, g]));

/** Look up a catalog goal by its stored key, or undefined. */
export function goalByKey(key: string): DcpGoal | undefined {
	return GOAL_BY_KEY.get(key);
}

// ---------------------------------------------------------------------------
// Program year (Jul 1 – Jun 30), keyed by its starting calendar year
// ---------------------------------------------------------------------------

/** July (0-indexed month 6) is when a Toastmasters program year begins. */
const PROGRAM_YEAR_START_MONTH = 6;

/**
 * The program year a date falls in, identified by its STARTING calendar year:
 * July onward belongs to that calendar year; January–June belongs to the prior
 * one (that year's program year started the previous July).
 */
export function programYearForDate(date: Date): number {
	return date.getMonth() >= PROGRAM_YEAR_START_MONTH
		? date.getFullYear()
		: date.getFullYear() - 1;
}

/** The current program year for "now" (defaults to the real clock). */
export function currentProgramYear(now: Date = new Date()): number {
	return programYearForDate(now);
}

/** Half-open window [Jul 1 of the year, Jul 1 of the next year). Local dates. */
export function programYearWindow(programYear: number): {
	start: Date;
	end: Date;
} {
	return {
		start: new Date(programYear, PROGRAM_YEAR_START_MONTH, 1),
		end: new Date(programYear + 1, PROGRAM_YEAR_START_MONTH, 1),
	};
}

/** Display label for a program year, e.g. 2026 → "2026–27". */
export function programYearLabel(programYear: number): string {
	const next = String((programYear + 1) % 100).padStart(2, "0");
	return `${programYear}–${next}`;
}

// ---------------------------------------------------------------------------
// Membership base requirement (gates every recognition tier)
// ---------------------------------------------------------------------------

/** Net membership growth vs the year's baseline, or null when no baseline set. */
export function netGrowth(
	currentActive: number,
	baseMemberCount: number | null,
): number | null {
	if (baseMemberCount == null) return null;
	return currentActive - baseMemberCount;
}

/**
 * The DCP membership base: at least 20 active members, OR a net growth of five
 * or more vs the program-year baseline. Without a baseline only the ≥20 rule can
 * be satisfied.
 */
export function isBaseMet(
	currentActive: number,
	baseMemberCount: number | null,
): boolean {
	if (currentActive >= 20) return true;
	const growth = netGrowth(currentActive, baseMemberCount);
	return growth != null && growth >= 5;
}

// ---------------------------------------------------------------------------
// New-member assist (goals 7 & 8) — the only roster-derived pre-fill
// ---------------------------------------------------------------------------

/**
 * Split a program-year new-member count across the two membership goals: fill
 * goal 7 first (up to 4), then goal 8 (up to 4). Anything beyond 8 is ignored —
 * both goals are already met.
 */
export function splitNewMembers(count: number): { g7: number; g8: number } {
	const g7 = Math.max(0, Math.min(count, 4));
	const g8 = Math.max(0, Math.min(count - 4, 4));
	return { g7, g8 };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** A goal is met when the achieved value reaches its target. */
export function isGoalMet(goal: DcpGoal, achieved: number): boolean {
	return achieved >= goal.target;
}

export type DcpTier = "distinguished" | "select" | "presidents";

const TIER_LABELS: Record<DcpTier, string> = {
	distinguished: "Distinguished",
	select: "Select Distinguished",
	presidents: "President's Distinguished",
};

/** Human label for a recognition tier. */
export function tierLabel(tier: DcpTier): string {
	return TIER_LABELS[tier];
}

/** Goals-met thresholds for each tier (all also require the membership base). */
const DISTINGUISHED = 5;
const SELECT = 7;
const PRESIDENTS = 9;

export interface DcpSummaryInput {
	/** goalKey → achieved value. Missing keys count as 0. */
	progress: Record<string, number>;
	currentActive: number;
	baseMemberCount: number | null;
}

export interface DcpSummary {
	goalsMet: number;
	baseMet: boolean;
	/** null when the base is unmet OR fewer than 5 goals are met. */
	tier: DcpTier | null;
	/** Goals still needed to reach Distinguished (0 once 5+ are met). */
	goalsToDistinguished: number;
}

/** Derive the scoreboard summary from hand-entered progress + roster counts. */
export function computeDcpSummary(input: DcpSummaryInput): DcpSummary {
	const goalsMet = DCP_GOALS.reduce(
		(n, g) => n + (isGoalMet(g, input.progress[g.key] ?? 0) ? 1 : 0),
		0,
	);
	const baseMet = isBaseMet(input.currentActive, input.baseMemberCount);

	let tier: DcpTier | null = null;
	if (baseMet) {
		if (goalsMet >= PRESIDENTS) tier = "presidents";
		else if (goalsMet >= SELECT) tier = "select";
		else if (goalsMet >= DISTINGUISHED) tier = "distinguished";
	}

	return {
		goalsMet,
		baseMet,
		tier,
		goalsToDistinguished: Math.max(0, DISTINGUISHED - goalsMet),
	};
}
