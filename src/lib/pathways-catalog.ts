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
 * Scope: the 6 paths this club actually uses (real Base Camp fixture data). The
 * catalog is keyed by Base Camp `course_code`; other paths can be appended later
 * (the seed is idempotent). Names are for the *display* layer ("Your wins" /
 * "Up next") — Base Camp's per-level counts still own completion (Phase 1), so a
 * path's catalog project count deliberately need NOT equal Base Camp's `total`.
 *
 * Encoding: each path lists its REQUIRED projects per level. Electives at levels
 * 3–5 are a standard pool MINUS that path's own required projects (this is how TI
 * structures them), derived below — so the required lists are the only hand-typed
 * data, which minimizes transcription error.
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

export interface CatalogProject {
	name: string;
	level: number; // 1–5
	isRequired: boolean;
}

export interface CatalogPath {
	courseCode: string;
	name: string;
	status: "current" | "legacy";
	projects: CatalogProject[];
}

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
		l5: ["Prepare to Speak Professionally", "Reflect on Your Path"],
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
		l5: ["Team Building", "Reflect on Your Path"],
	},
	{
		courseCode: "8711",
		name: "Engaging Humor",
		l2: [
			"Know Your Sense of Humor",
			"Connect with Your Audience",
			"Introduction to Toastmasters Mentoring",
		],
		l3: ["Engage Your Audience With Humor"],
		l4: ["The Power of Humor in an Impromptu Speech"],
		l5: ["Deliver Your Message With Humor", "Reflect on Your Path"],
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
		l5: ["Leading in Your Volunteer Organization", "Reflect on Your Path"],
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
		l5: ["Lead in Any Situation", "Reflect on Your Path"],
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
		l5: ["Manage Successful Events", "Reflect on Your Path"],
	},
];

function buildPath(p: PathReq): CatalogPath {
	const required = new Set<string>([...L1, ...p.l2, ...p.l3, ...p.l4, ...p.l5]);
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
		...p.l5.map((name) => ({ name, level: 5, isRequired: true })),
		...electives(L5_POOL, 5),
	];
	return {
		courseCode: p.courseCode,
		name: p.name,
		status: p.status ?? "current",
		projects,
	};
}

export const PATHWAYS_CATALOG: CatalogPath[] = CLUB_PATHS.map(buildPath);
