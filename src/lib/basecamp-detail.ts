/**
 * Pure parser for Base Camp Manager's per-member /detail endpoint
 * (`GET /api/bcm/progress/<course-v1-id>/detail?user=<guid>`). Turns one raw
 * payload into a flat, DB-agnostic shape. No DB — the upsert lives in
 * `src/server/pathways-detail-logic.ts`.
 *
 * The raw payload is member PII (speech titles, names) — callers must keep raw
 * captures gitignored; only synthetic fixtures live in the repo.
 */
import { extractCourseCode } from "./basecamp-progress";

// --- Raw payload shape (only the slice the parser reads) ---

interface RawBlockNode {
	type: "course" | "chapter" | "sequential";
	display_name: string;
	block_id?: string;
	complete?: boolean;
	block_lib_type?: "imported" | "elective";
	min_req_electives?: number;
	children?: RawBlockNode[];
}

export interface BcmDetailPayload {
	basecampUserId: string; // numeric user.id (string) — the enrollment join key
	courseId: string;
	blocks: RawBlockNode;
	speeches: Record<string, { speech_title?: string; speech_date?: string }>;
}

// --- Parsed shape ---

export interface ParsedDetailProject {
	blockId: string;
	name: string;
	level: number;
	isRequired: boolean; // block_lib_type "imported" → true, "elective" → false
	complete: boolean;
	speechTitle: string | null;
	speechDate: Date | null;
}

export interface ParsedDetailLevel {
	level: number;
	minReqElectives: number;
}

export interface ParsedDetail {
	basecampUserId: string;
	courseCode: string;
	projects: ParsedDetailProject[];
	levels: ParsedDetailLevel[];
}

const LEVEL_KEY = /^Level (\d+)$/;

/**
 * A level's own introduction unit, which Base Camp ships as a `sequential` with
 * a real `block_id` alongside the level's actual projects — so it used to be
 * ingested as a required PROJECT (#415). On prod that produced 22 phantom rows:
 * "Level 1: Mastering Fundamentals" … "Level 5: Demonstrating Expertise" on each
 * current path, plus "Path Introduction" on each legacy one. They carry no
 * speech title and no completion date, and they are what made Base Camp report
 * `total: 5` for a Level 1 that really has four projects (#398).
 *
 * This is a NAME heuristic, deliberately narrow, and it is a fallback rather
 * than the preferred fix: no captured payload was available to tell whether a
 * structural field distinguishes these (`block_lib_type` is absent from the
 * synthetic fixture for both kinds). If a raw capture ever shows one, replace
 * this — a structural signal survives TI renaming a level, and this does not.
 * No real project is named "Path Introduction" or begins "Level N:".
 */
const LEVEL_CONTAINER = /^(Level [1-5]:|Path Introduction$)/;

/**
 * Returns `null` when the payload is not for a Pathways path at all — Club
 * Officer Training, the Mentor Program and friends all live in the same Base
 * Camp (#414). Callers filter; this used to throw, which took the whole detail
 * phase down with it.
 */
export function parseDetailPayload(
	payload: BcmDetailPayload,
): ParsedDetail | null {
	const courseCode = extractCourseCode(payload.courseId);
	if (!courseCode) return null;

	const projects: ParsedDetailProject[] = [];
	const levels: ParsedDetailLevel[] = [];

	for (const chapter of payload.blocks.children ?? []) {
		const match = LEVEL_KEY.exec(chapter.display_name);
		if (!match) continue; // skip "Path Completion" and non-level chapters
		const level = Number(match[1]);
		levels.push({ level, minReqElectives: chapter.min_req_electives ?? 0 });

		for (const node of chapter.children ?? []) {
			if (node.type !== "sequential") continue;
			// Placeholder = unchosen elective slot (empty block_id). Never a project.
			if (!node.block_id) continue;
			// The level's own intro unit. Has a block_id, is not a project.
			if (LEVEL_CONTAINER.test(node.display_name)) continue;
			const speech = payload.speeches[node.block_id];
			projects.push({
				blockId: node.block_id,
				name: node.display_name,
				level,
				isRequired: node.block_lib_type !== "elective",
				complete: node.complete === true,
				speechTitle: speech?.speech_title ?? null,
				speechDate: speech?.speech_date ? new Date(speech.speech_date) : null,
			});
		}
	}

	levels.sort((a, b) => a.level - b.level);

	return {
		basecampUserId: payload.basecampUserId,
		courseCode,
		projects,
		levels,
	};
}
