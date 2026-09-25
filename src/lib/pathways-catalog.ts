/**
 * Seed Pathways project catalog (Phase 2 / #101). Seeded into `pathways_paths` +
 * `pathways_projects` by `scripts/seed-pathways-catalog.ts`.
 *
 * PROVENANCE (#382): these names were **LLM-generated, not transcribed** from a
 * TI source. An earlier version of this comment claimed "Source: the official
 * Toastmasters path pages (toastmasters.org/pathways-overview/…)" — that was
 * wrong, and is corrected here rather than quietly deleted so nobody re-derives
 * false confidence from it.
 *
 * VERIFIED 2026-07-26 (#398) against those pages for real, one per path
 * (`toastmasters.org/pathways-overview/pathways-<slug>-path`, linked from
 * Education → Pathways → Paths and Projects; public, no login). Every path's
 * L2–L5 required projects were already correct. Three things were not, and are
 * fixed: `L3_POOL` was missing "Researching and Presenting", `L1` listed five
 * projects instead of four, and 8702/8705 were marked current rather than
 * legacy. See the comments at each.
 *
 * The guess is self-correcting for anything Base Camp actually returns.
 * `reconcileCatalog` (`src/server/pathways-detail-logic.ts`) runs on every
 * /detail sync and, per project: matches by durable `bcm_block_id` (keeping name
 * and level current across TI renames), else stamps `bcm_block_id` onto a seeded
 * row matched by (path, level, name), else derives the required project we
 * failed to seed. So a corroborated row carries a block id and a fabricated one
 * never gets one — run `scripts/audit-pathways-catalog.ts` to list the latter.
 *
 * The gap that leaves: unchosen electives arrive from Base Camp as placeholders
 * with an empty block id and are skipped (`src/lib/basecamp-detail.ts`), so an
 * elective is corroborated only once some member picks it. The three pools below
 * are therefore the part of this file no sync will ever verify on its own, which
 * is why they were checked by hand — and why they need re-checking by hand
 * whenever TI revises the curriculum. That is not automatic.
 *
 * Scope: ALL 11 paths TI publishes — 6 current and 5 legacy — completed
 * 2026-07-27 (#412). It used to hold only the 6 this club happened to use, which
 * was fine while this file was a display-only mirror of data Base Camp already
 * supplied. It is not fine now: under #420 this catalog becomes the backing store
 * for a project picker, and on a club that never syncs `pathways_projects` is
 * empty unless seeded from here. A member on a path we omitted would get an empty
 * picker.
 *
 * The `course_code` keys are not guesses. They come from Base Camp's own Open edX
 * course-discovery API — `https://basecamp.toastmasters.org/api/courses/v1/courses/`,
 * which answers UNAUTHENTICATED, needs no enrolled member, and is the only place
 * these codes exist (toastmasters.org does not publish them). It independently
 * reproduces all 6 codes this file already had, which is what makes the 5 new
 * ones trustworthy. There is no 8710.
 *
 * Names are for the *display* layer ("Your wins" / "Up next") — Base Camp's
 * per-level counts still own completion (Phase 1), so a path's catalog project
 * count deliberately need NOT equal Base Camp's `total`.
 *
 * Encoding: each path lists its REQUIRED projects per level. Electives at levels
 * 3–5 are a standard pool MINUS that path's own required projects (this is how TI
 * structures them), derived below — so the required lists are the only hand-typed
 * data, which minimizes transcription error.
 *
 * Current paths add, at Levels 4 and 5, the Education Series presentations
 * (`SERIES`, #921): one Successful Club Series presentation per level, plus one
 * Better Speaker Series (L4) or Leadership Excellence Series (L5) presentation.
 * They are rows with `isRequired: false` and a `series`, and they are NOT
 * electives — `seriesRequiredAt` is the one statement of which series a level
 * needs. Legacy paths have none.
 *
 * NOT MODELLED — what each project takes to complete, which is not one speech
 * and not even one assignment. Level 1's "Evaluation and Feedback" takes THREE:
 * give a speech, evaluate another member's speech, then give the same speech
 * again applying the feedback received. Its three siblings take one speech each.
 * Later levels include projects that are not speeches at all — which
 * `pathways-read-logic.ts` already half-knows, since a win's `deliveredAt` is
 * "null for a non-speech (leadership) completion".
 *
 * Note Base Camp's level page labels that project "Roles: Speaker; Evaluator" —
 * two DISTINCT ROLES, not two assignments, because Speaker recurs. So the role
 * label is not a count and cannot be scraped into one. Nothing here records
 * either, so a project must never be inferred complete from a delivered speech.
 * Moot on the synced path (Base Camp owns `complete`); it bites any
 * speech-derived view. Tracked separately.
 */

/**
 * The three Education Series (#921). Mirrors the `pathways_series` pgEnum in
 * `src/db/schema.ts`; `pathways-catalog.test.ts` holds the two equal. Kept here
 * rather than imported so this client-safe module does not reach for the schema.
 */
export const PATHWAYS_SERIES = [
	"successful_club",
	"better_speaker",
	"leadership_excellence",
] as const;
export type PathwaysSeries = (typeof PATHWAYS_SERIES)[number];

export const SERIES_LABEL: Record<PathwaysSeries, string> = {
	successful_club: "Successful Club Series",
	better_speaker: "Better Speaker Series",
	leadership_excellence: "Leadership Excellence Series",
};

export interface CatalogProject {
	name: string;
	level: number; // 1–5
	isRequired: boolean;
	/** An Education Series presentation (current paths, L4/L5 only). Never an
	 *  elective, and always `isRequired: false`. Absent on every other project. */
	series?: PathwaysSeries;
}

export interface CatalogLevel {
	level: number; // 1–5
	/** How many electives this level requires. 0 at levels 1–2. */
	minReqElectives: number;
}

export interface CatalogPath {
	courseCode: string;
	name: string;
	status: "current" | "legacy";
	projects: CatalogProject[];
	levels: CatalogLevel[];
}

/**
 * Electives required per level. Identical on all 11 paths — verified 2026-07-27
 * (#412) by parsing every path page: levels 3, 4 and 5 say "Choose 2 / 1 / 1 of
 * the following", levels 1–2 have no electives at all.
 *
 * This mirrors `pathways_path_levels.min_req_electives`, which until now was
 * written ONLY by `reconcileCatalog` from a Base Camp sync. Without it
 * `pathways-read-logic.ts` computes `minReq = … ?? 0`, then `chooseCount = 0`,
 * and never builds `upNextElectives` — so a never-synced club's Level 3 view
 * silently omitted the two electives the level requires. No error, no empty
 * state, just absence. That is why the seed has to write this table.
 */
const MIN_REQ_ELECTIVES: Record<number, number> = {
	1: 0,
	2: 0,
	3: 2,
	4: 1,
	5: 1,
};

// Standard elective pools (identical across paths). A path's electives at a
// level = pool minus that path's required projects anywhere — which is exactly
// how toastmasters.org presents them per path, so each path page cross-checks
// the pool. Verified 2026-07-26 (#398): Dynamic Leadership requires nothing from
// L3_POOL and so lists all 15; Presentation Mastery lists 14 (minus its L2
// "Effective Body Language"); Motivational Strategies lists 14 (minus its L2
// "Active Listening"); Engaging Humor lists 13 (minus two).
const L3_POOL = [
	"Active Listening",
	"Connect with Storytelling",
	"Connect with Your Audience",
	"Creating Effective Visual Aids",
	"Deliver Social Speeches",
	"Effective Body Language",
	"Focus on the Positive",
	"Inspire Your Audience",
	"Know Your Sense of Humor",
	"Make Connections Through Networking",
	"Prepare for an Interview",
	"Researching and Presenting",
	"Understanding Vocal Variety",
	"Using Descriptive Language",
	"Using Presentation Software",
];
// Verified whole 2026-07-26 (#398) against Motivational Strategies and Dynamic
// Leadership, which require nothing from this pool and so display all 8.
const L4_POOL = [
	"Building a Social Media Presence",
	"Create a Podcast",
	"Manage Online Meetings",
	"Manage Projects Successfully",
	"Managing a Difficult Audience",
	"Public Relations Strategies",
	"Question-and-Answer Session",
	"Write a Compelling Blog",
];
// Verified whole 2026-07-26 (#398), same two paths.
const L5_POOL = [
	"Ethical Leadership",
	"High Performance Leadership",
	"Leading in Your Volunteer Organization",
	"Lessons Learned",
	"Moderate a Panel Discussion",
	"Prepare to Speak Professionally",
];

// Level 1 "Mastering Fundamentals" is identical (all required) across every path:
// FOUR projects, verified 2026-07-26 (#398) against every path page on
// toastmasters.org, against Base Camp's own per-member project table, and
// against Base Camp's Level 1 page, which says so outright: "These four
// projects form the base of your Toastmasters journey."
//
// This used to list five, with "Researching and Presenting" filling the fifth
// slot, justified by Base Camp reporting `total: 5` for L1. Both halves of that
// were wrong. Base Camp's L1 really does have five *rows*, but the first is
// "Level 1: Mastering Fundamentals" — the level's own intro unit, which carries
// no speech title and no completion date. Four projects plus one intro. And the
// count never had to match anyway: per this file's header, a path's catalog
// project count deliberately need NOT equal Base Camp's `total`, because Base
// Camp's per-level counts own completion and these names are display only.
//
// "Researching and Presenting" is an L3 elective (it is in `L3_POOL`), not an L1
// required project. Listing it in both silently removed it from every path's
// elective options, since `buildPath` derives electives as pool-minus-required.
const L1 = [
	"Ice Breaker",
	"Writing a Speech with Purpose",
	"Introduction to Vocal Variety and Body Language",
	"Evaluation and Feedback",
];

interface PathReq {
	courseCode: string;
	name: string;
	/** Omitted ⇒ "current". TI retires paths without retiring enrollments. */
	status?: "current" | "legacy";
	l2: string[]; // Level 2 required (3)
	l3: string[]; // Level 3 required
	l4: string[]; // Level 4 required
	l5: string[]; // Level 5 required
}

// Required projects per club path (Level 1 is the shared `L1`).
const CLUB_PATHS: PathReq[] = [
	{
		courseCode: "8701",
		name: "Presentation Mastery",
		l2: [
			"Understanding Your Communication Style",
			"Effective Body Language",
			"Introduction to Toastmasters Mentoring",
		],
		l3: ["Persuasive Speaking"],
		l4: ["Managing a Difficult Audience"],
		l5: ["Prepare to Speak Professionally"],
	},
	{
		courseCode: "8700",
		name: "Motivational Strategies",
		l2: [
			"Understanding Your Communication Style",
			"Active Listening",
			"Introduction to Toastmasters Mentoring",
		],
		l3: ["Understanding Emotional Intelligence"],
		l4: ["Motivate Others"],
		l5: ["Team Building"],
	},
	{
		courseCode: "8711",
		name: "Engaging Humor",
		l2: [
			"Know Your Sense of Humor",
			"Connect with Your Audience",
			"Introduction to Toastmasters Mentoring",
		],
		// Lowercase "with", which is BASE CAMP's spelling — toastmasters.org
		// capitalises the W on both of these. Base Camp wins for strings (#413):
		// `reconcileCatalog` matches a seeded row to a real block by name, and the
		// capitalised form left an orphan that could never be stamped, because
		// step 1 finds the already-derived lowercase row by `bcm_block_id` and
		// returns before the case-insensitive step 2 is reached. Prod carried both
		// spellings as separate rows until #429.
		l3: ["Engage Your Audience with Humor"],
		l4: ["The Power of Humor in an Impromptu Speech"],
		l5: ["Deliver Your Message with Humor"],
	},
	{
		courseCode: "8705",
		name: "Strategic Relationships",
		// TI lists this under "Legacy Paths" (#398). Members stay enrolled.
		status: "legacy",
		l2: [
			"Understanding Your Leadership Style",
			"Active Listening",
			"Introduction to Toastmasters Mentoring",
		],
		l3: ["Make Connections Through Networking"],
		l4: ["Public Relations Strategies"],
		l5: ["Leading in Your Volunteer Organization"],
	},
	{
		courseCode: "8706",
		name: "Dynamic Leadership",
		l2: [
			"Understanding Your Leadership Style",
			"Understanding Your Communication Style",
			"Introduction to Toastmasters Mentoring",
		],
		l3: ["Negotiate the Best Outcome"],
		l4: ["Manage Change"],
		l5: ["Lead in Any Situation"],
	},
	{
		courseCode: "8702",
		name: "Leadership Development",
		// TI lists this under "Legacy Paths" (#398). Members stay enrolled.
		status: "legacy",
		l2: [
			"Managing Time",
			"Understanding Your Leadership Style",
			"Introduction to Toastmasters Mentoring",
		],
		l3: ["Planning and Implementing"],
		l4: ["Leading Your Team"],
		l5: ["Manage Successful Events"],
	},
	// --- Added 2026-07-27 (#412). Course codes from Base Camp's course-discovery
	// API; required projects parsed from each path's toastmasters.org page. Each
	// one cross-checks itself: the page also prints that path's elective options,
	// which must equal pool-minus-requireds. All five reconcile exactly, and
	// `pathways-catalog.test.ts` asserts the counts so a bad edit can't pass.
	{
		courseCode: "8704",
		name: "Visionary Communication",
		l2: [
			"Understanding Your Leadership Style",
			"Understanding Your Communication Style",
			"Introduction to Toastmasters Mentoring",
		],
		l3: ["Develop a Communication Plan"],
		l4: ["Communicate Change"],
		l5: ["Develop Your Vision"],
	},
	{
		courseCode: "8707",
		name: "Persuasive Influence",
		l2: [
			"Understanding Your Leadership Style",
			"Active Listening",
			"Introduction to Toastmasters Mentoring",
		],
		l3: ["Understanding Conflict Resolution"],
		l4: ["Leading in Difficult Situations"],
		l5: ["High Performance Leadership"],
	},
	{
		courseCode: "8703",
		name: "Innovative Planning",
		// TI lists this under "Legacy Paths" (#412). Members stay enrolled.
		status: "legacy",
		l2: [
			"Understanding Your Leadership Style",
			// toastmasters.org prints this as "Connect With Your Audience" on the
			// Innovative Planning page and as "Connect with Your Audience" in every
			// elective pool — TI is not case-consistent with itself. The pool's
			// casing is the one to use here: `buildPath` subtracts requireds from
			// the pools by exact string, so the other spelling would leave the
			// project in this path's L3 electives *and* list it as an L2 required.
			// The page's own elective count (14, not 15) confirms which is meant.
			"Connect with Your Audience",
			"Introduction to Toastmasters Mentoring",
		],
		l3: ["Present a Proposal"],
		l4: ["Manage Projects Successfully"],
		l5: ["High Performance Leadership"],
	},
	{
		courseCode: "8708",
		name: "Effective Coaching",
		// TI lists this under "Legacy Paths" (#412). Members stay enrolled.
		status: "legacy",
		l2: [
			"Understanding Your Leadership Style",
			"Understanding Your Communication Style",
			"Introduction to Toastmasters Mentoring",
		],
		l3: ["Reaching Consensus"],
		l4: ["Improvement Through Positive Coaching"],
		l5: ["High Performance Leadership"],
	},
	{
		courseCode: "8709",
		name: "Team Collaboration",
		// TI lists this under "Legacy Paths" (#412). Members stay enrolled.
		status: "legacy",
		l2: [
			"Understanding Your Leadership Style",
			"Active Listening",
			"Introduction to Toastmasters Mentoring",
		],
		l3: ["Successful Collaboration"],
		l4: ["Motivate Others"],
		l5: ["Lead in Any Situation"],
	},
];

/**
 * TI revised the Pathways projects and kept the superseded editions for members
 * already on a legacy path, so Base Camp returns EVERY project on 8702/8705 (and
 * by the same pattern 8703/8708/8709) with a " (Legacy)" suffix — required and
 * elective alike, right down to "Reflect on Your Path (Legacy)".
 *
 * These are therefore different projects, not a different spelling of the same
 * one, which is why the suffix belongs in the catalog rather than being papered
 * over by loose matching. Seeding the unsuffixed names put 22 rows on prod that
 * describe projects nobody on those paths is taking, none of which Base Camp
 * could ever stamp (#423).
 *
 * Note toastmasters.org's legacy path pages list the names WITHOUT the suffix —
 * the website was updated to current project names while Base Camp still serves
 * legacy members the old editions. Base Camp wins, per #413: the website is
 * authoritative for structure, Base Camp for strings.
 *
 * CORROBORATED for 8705 (full /detail payload, 2026-07-27) and 8702 (every
 * derived row on prod). 8703, 8708 and 8709 are INFERRED from the same pattern —
 * nobody in this club is enrolled in them, so no payload exists. If TI treated
 * one of those differently, its rows simply never get a `bcm_block_id` and
 * `scripts/audit-pathways-catalog.ts` reports them as SUSPECT the first time
 * anyone syncs one. That is the cheap, visible failure mode; the alternative
 * (leaving three legacy paths unsuffixed) is wrong under the same inference and
 * fails identically.
 */
const withLegacySuffix = (p: CatalogProject): CatalogProject => ({
	...p,
	name: `${p.name} (Legacy)`,
});

/**
 * Path completion is NOT a sixth level (#424). Toastmasters has five, and Base
 * Camp says so: it ships this as its own `Path Completion` chapter, a sibling of
 * `Level 1`…`Level 5`, carrying one project. Confirmed in real /detail payloads
 * for 8711 and 8705.
 *
 * This catalog used to file "Reflect on Your Path" as a Level 5 required project
 * on all 11 paths, because toastmasters.org draws it inside the Demonstrating
 * Expertise column. That was wrong on both counts: Base Camp never returned it
 * at level 5 (it was the only SUSPECT row on all three cleanly-synced paths in
 * the 2026-07-27 prod audit), and the maintainer confirms it is not a level 5
 * item — it is a reflection ON the path, taken after the levels are done.
 *
 * `pathways_projects.level` is a NOT NULL integer, so the marker has to be a
 * number. 6 is a sentinel chosen for sort order — it puts path completion last
 * without any special-casing — and it must never be rendered as "Level 6". Use
 * `levelLabel()` for anything user-facing.
 *
 * Deliberately NOT added to `levels` below: `pathways_path_levels` describes
 * real levels and their elective minimums, and path completion has neither. Nor
 * can this value reach `currentLevel` or the progress ring, which are derived
 * from `path_level_progress` — written by the summary parser, which filters on
 * `^Level (\d+)$` and so can never emit it.
 */
export const PATH_COMPLETION_LEVEL = 6;

// Education Series presentations, read 2026-09-25 from Base Camp's own
// "Level 4 Requirements" / "Level 5 Requirements" units (8711). Current paths
// only; the legacy editions (8705 checked) have no series requirement.
// One of each series is required per level, per path enrollment.
//
// Base Camp does not return these as blocks (they are static text in each
// level's intro unit), so no sync will ever corroborate or correct them: a
// series row never gets a `bcm_block_id`, and completion is always a mark.
const SERIES: Record<4 | 5, Partial<Record<PathwaysSeries, string[]>>> = {
	4: {
		successful_club: [
			"Finding New Members",
			"Closing the Sale",
			"How to Be a Distinguished Club",
			"Toastmasters Educational Program",
		],
		better_speaker: [
			"Beginning Your Speech",
			"Concluding Your Speech",
			"Controlling Your Fear",
			"Impromptu Speaking",
			"Selecting Your Topic",
			"Know Your Audience",
			"Organizing Your Speech",
			"Creating an Introduction",
			"Preparation and Practice",
			"Using Body Language",
		],
	},
	5: {
		successful_club: ["Moments of Truth", "Evaluate to Motivate", "Mentoring"],
		leadership_excellence: [
			"Service and Leadership",
			"The Leader as a Coach",
			"Developing a Mission",
			"Motivating People",
			"Building a Team",
			"Delegate to Empower",
			"Resolving Conflict",
			"Visionary Leader",
			"Values and Leadership",
			"Goal Setting and Planning",
			"Giving Effective Feedback",
		],
	},
};

/**
 * Which Education Series a level requires one presentation from (#921): the
 * Successful Club Series plus Better Speaker (L4) or Leadership Excellence
 * (L5), on current paths only. The ONE statement of that rule — the read model
 * and the UI both ask this rather than restating it.
 */
export function seriesRequiredAt(
	level: number,
	status: "current" | "legacy",
): PathwaysSeries[] {
	if (status !== "current") return [];
	if (level === 4) return ["successful_club", "better_speaker"];
	if (level === 5) return ["successful_club", "leadership_excellence"];
	return [];
}

/** Series rows for one level, in `SERIES` order. */
function seriesProjects(level: 4 | 5): CatalogProject[] {
	return seriesRequiredAt(level, "current").flatMap((series) =>
		(SERIES[level][series] ?? []).map((name) => ({
			name,
			level,
			isRequired: false,
			series,
		})),
	);
}

/** Identical on every path. Legacy paths get " (Legacy)" like everything else. */
const PATH_COMPLETION_PROJECT = "Reflect on Your Path";

/** User-facing label for a project's level. Never prints "Level 6". */
export function levelLabel(level: number): string {
	return level === PATH_COMPLETION_LEVEL ? "Path Completion" : `Level ${level}`;
}

/**
 * Which level group the project picker opens on (#418): the lowest one that
 * still has an incomplete REQUIRED project.
 *
 * Deliberately not a gate. Someone whose Level 1 is finished but not yet
 * approved is already delivering Level 2 speeches, and someone repeating an
 * elective is going backwards — both are ordinary. Every level stays reachable
 * and every project stays selectable; this only decides what's already open
 * when the sheet appears.
 *
 * `approvedThrough` is Base Camp's own verdict (the highest contiguous approved
 * `path_level_progress.level`) and wins when present, because a level can be
 * approved while our per-project mirror is stale or partial. Falls back to the
 * required-project scan, then to the lowest level for a member with no progress
 * data at all — the common case for a club that has never synced.
 *
 * Levels with no required projects — Path Completion — are skipped: nothing
 * there is deliverable, so it can never be "the level you're on".
 */
export function defaultOpenLevel(
	projects: { level: number; isRequired: boolean; complete: boolean }[],
	approvedThrough: number | null,
): number {
	const levels = [...new Set(projects.map((p) => p.level))].sort(
		(a, b) => a - b,
	);
	if (levels.length === 0) return 1;

	if (approvedThrough !== null) {
		return levels.find((l) => l > approvedThrough) ?? levels[levels.length - 1];
	}

	const firstUnfinished = levels.find((level) => {
		const required = projects.filter((p) => p.level === level && p.isRequired);
		return required.length > 0 && required.some((p) => !p.complete);
	});
	return firstUnfinished ?? levels[0];
}

function buildPath(p: PathReq): CatalogPath {
	const status = p.status ?? "current";
	// Series rows (#921) exist on current paths only, so the legacy suffix below
	// never meets one. Each level's series follow that level's electives.
	const series = (level: 4 | 5): CatalogProject[] =>
		status === "current" ? seriesProjects(level) : [];
	const required = new Set<string>([
		...L1,
		...p.l2,
		...p.l3,
		...p.l4,
		...p.l5,
		PATH_COMPLETION_PROJECT,
	]);
	const electives = (pool: string[], level: number): CatalogProject[] =>
		pool
			.filter((name) => !required.has(name))
			.map((name) => ({ name, level, isRequired: false }));

	const projects: CatalogProject[] = [
		...L1.map((name) => ({ name, level: 1, isRequired: true })),
		...p.l2.map((name) => ({ name, level: 2, isRequired: true })),
		...p.l3.map((name) => ({ name, level: 3, isRequired: true })),
		...electives(L3_POOL, 3),
		...p.l4.map((name) => ({ name, level: 4, isRequired: true })),
		...electives(L4_POOL, 4),
		...series(4),
		...p.l5.map((name) => ({ name, level: 5, isRequired: true })),
		...electives(L5_POOL, 5),
		...series(5),
		{
			name: PATH_COMPLETION_PROJECT,
			level: PATH_COMPLETION_LEVEL,
			isRequired: true,
		},
	];
	return {
		courseCode: p.courseCode,
		name: p.name,
		status,
		// Legacy paths carry TI's superseded EDITION of each project, and Base Camp
		// names them accordingly (#423). Applied as a final transform rather than
		// to the inputs so every pool subtraction above is unaffected — suffixing
		// both sides of `pool minus required` would cancel out anyway, but doing it
		// here keeps the elective arithmetic provably identical to a current path's.
		projects: status === "legacy" ? projects.map(withLegacySuffix) : projects,
		levels: [1, 2, 3, 4, 5].map((level) => ({
			level,
			minReqElectives: MIN_REQ_ELECTIVES[level] ?? 0,
		})),
	};
}

export const PATHWAYS_CATALOG: CatalogPath[] = CLUB_PATHS.map(buildPath);
