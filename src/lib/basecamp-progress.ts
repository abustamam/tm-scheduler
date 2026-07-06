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

/** "course-v1:Toastmasters+8701+8_15_2023" → "8701". */
export function extractCourseCode(courseId: string): string {
	const parts = courseId.split("+");
	const code = parts[1];
	if (!code || !/^\d+$/.test(code)) {
		throw new Error(`Unrecognized course_id: ${courseId}`);
	}
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

export function parseProgressPages(
	pages: BcmProgressPage[],
): ParsedMemberPath[] {
	return pages.flatMap((page) =>
		page.results.map((row) => ({
			basecampUserId: String(row.user.id),
			name: row.user.name,
			email: row.user.email ? row.user.email.toLowerCase() : null,
			courseCode: extractCourseCode(row.course_id),
			pathName: row.path_name,
			levels: parseProgression(row.progression),
		})),
	);
}
