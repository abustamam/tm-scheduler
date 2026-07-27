/**
 * Pure parser for Base Camp Manager's progress endpoint
 * (`GET /api/bcm/progress/?club=<guid>&page=N`). Turns the raw paginated JSON
 * into flat per-(member,path) rows with per-level counts. No DB — the sync
 * upsert lives in `src/server/pathways-sync-logic.ts`.
 *
 * Base Camp gives per-LEVEL counts + `approved`, never project identity, and
 * `completed` may exceed `total` (extra/repeated electives) — preserved as-is.
 */
export interface BcmProgressLevel {
	completed: number;
	total: number;
	approved?: boolean;
}

export interface BcmProgressRow {
	user: { id: number; name: string; email: string | null };
	path_name: string;
	course_id: string;
	progression: Record<string, BcmProgressLevel>;
}

// Only the slice the parser reads. The real payload is a paginated envelope
// that also carries `count`/`next`/`previous` — intentionally omitted here.
export interface BcmProgressPage {
	results: BcmProgressRow[];
}

export interface ParsedLevel {
	level: number;
	completed: number;
	total: number;
	approved: boolean;
}

export interface ParsedMemberPath {
	basecampUserId: string;
	name: string;
	email: string | null;
	courseCode: string;
	pathName: string;
	levels: ParsedLevel[];
}

/**
 * The 11 Pathways paths TI publishes, from Base Camp's own course-discovery API
 * (`https://basecamp.toastmasters.org/api/courses/v1/courses/`, unauthenticated).
 * There is no 8710. Kept here rather than derived from `PATHWAYS_CATALOG` so the
 * parser stays free of any `#/lib/pathways-catalog` import — this module is on
 * the ingest hot path and the catalog is display data.
 */
export const PATHWAYS_COURSE_CODES: ReadonlySet<string> = new Set([
	"8700",
	"8701",
	"8702",
	"8703",
	"8704",
	"8705",
	"8706",
	"8707",
	"8708",
	"8709",
	"8711",
]);

/**
 * Base Camp course key → Pathways course code, or `null` when the course is not
 * a Pathways path at all.
 *
 *   course-v1:pathways+8701+8_15_2023     → "8701"
 *   course-v1:pathways+SP8702+8_31_2023   → "8702"   (localized legacy path)
 *   course-v1:pathways+COT-S+…            → null     (Club Officer Training)
 *   course-v1:pathways+8731+…             → null     (Pathways Mentor Program)
 *
 * Two things this has to survive (#414), both found by running it over Base
 * Camp's live catalog, where the previous version threw on 92 of 256 ids:
 *
 * 1. TI uses TWO id conventions. Current paths put the language in the run slot
 *    (`8700+AR8700`); the five legacy paths put it in the CODE slot
 *    (`AR8702+8_31_2023`). A bare `/^\d+$/` test rejected the latter, so every
 *    localized edition of every legacy path — 25 course ids across Arabic,
 *    Chinese, German, French and Spanish — threw. Since `parseProgressPages`
 *    is not wrapped per-row, one member on the Spanish Leadership Development
 *    path 400'd their whole club's sync.
 *
 * 2. Base Camp hosts plenty of NUMERIC courses that are not paths — 8604
 *    Speechcraft Coordinator, 8605 Speechcrafter Learning, 8669 The
 *    Communication Series, 8712 Basic Training, 8731 Pathways Mentor Program.
 *    Those passed the digit test and would be inserted into `pathways_paths`,
 *    which is GLOBAL (no clubId), so one member enrolled in the Mentor Program
 *    would add it to every club's catalog permanently. Hence the allowlist.
 *
 * The org segment is ignored deliberately: real payloads carry both
 * `course-v1:Toastmasters+…` and `course-v1:pathways+…`.
 */
export function extractCourseCode(courseId: string): string | null {
	const raw = courseId.split("+")[1];
	if (!raw) return null;
	// Optional language prefix, then exactly the 4-digit code. Not a hardcoded
	// list of languages, so a new one doesn't reintroduce the crash.
	const code = /^[A-Za-z]*(\d{4})$/.exec(raw)?.[1];
	if (!code || !PATHWAYS_COURSE_CODES.has(code)) return null;
	return code;
}

const LEVEL_KEY = /^Level (\d+)$/;

function parseProgression(
	progression: Record<string, BcmProgressLevel>,
): ParsedLevel[] {
	const levels: ParsedLevel[] = [];
	for (const [key, value] of Object.entries(progression)) {
		const match = LEVEL_KEY.exec(key);
		if (!match) continue; // skip "Path Completion"
		levels.push({
			level: Number(match[1]),
			completed: value.completed,
			total: value.total,
			approved: value.approved === true,
		});
	}
	return levels.sort((a, b) => a.level - b.level);
}

/** Accept a single page object or an array; normalize to pages. */
export function normalizePages(
	input: BcmProgressPage | BcmProgressPage[],
): BcmProgressPage[] {
	return Array.isArray(input) ? input : [input];
}

/**
 * Rows whose course is not a Pathways path are SKIPPED, not fatal (#414). A
 * member enrolled in Club Officer Training, the Distinguished Toastmaster
 * course, or the Pathways Mentor Program is ordinary, not a broken payload —
 * they simply have no Pathways enrollment to record. Throwing here 400'd the
 * entire club's sync, because this call is wrapped once for the whole batch
 * rather than per row (`pathways-ingest-logic.ts`).
 */
export function parseProgressPages(
	pages: BcmProgressPage[],
): ParsedMemberPath[] {
	return pages.flatMap((page) =>
		page.results.flatMap((row) => {
			const courseCode = extractCourseCode(row.course_id);
			if (!courseCode) return [];
			return [
				{
					basecampUserId: String(row.user.id),
					name: row.user.name,
					email: row.user.email ? row.user.email.toLowerCase() : null,
					courseCode,
					pathName: row.path_name,
					levels: parseProgression(row.progression),
				},
			];
		}),
	);
}
