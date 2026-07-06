/**
 * Hand-curated Pathways project catalog (Phase 2 / #101). Source: the official
 * Toastmasters path pages (toastmasters.org/pathways-overview/…), current as of
 * 2026-07. Seeded into `pathways_paths` + `pathways_projects` by
 * `scripts/seed-pathways-catalog.ts`.
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

// Standard current elective pools (identical across the current paths). A path's
// electives at a level = pool minus that path's required projects anywhere.
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
const L5_POOL = [
	"Ethical Leadership",
	"High Performance Leadership",
	"Leading in Your Volunteer Organization",
	"Lessons Learned",
	"Moderate a Panel Discussion",
	"Prepare to Speak Professionally",
];

// Level 1 is identical (all required) across every current path.
const L1 = [
	"Ice Breaker",
	"Writing a Speech with Purpose",
	"Introduction to Vocal Variety and Body Language",
	"Evaluation and Feedback",
];

interface PathReq {
	courseCode: string;
	name: string;
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
	return { courseCode: p.courseCode, name: p.name, status: "current", projects };
}

export const PATHWAYS_CATALOG: CatalogPath[] = CLUB_PATHS.map(buildPath);
