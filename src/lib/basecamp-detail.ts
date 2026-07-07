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
	type: string; // "course" | "chapter" | "sequential"
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

export function parseDetailPayload(payload: BcmDetailPayload): ParsedDetail {
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

	return {
		basecampUserId: payload.basecampUserId,
		courseCode: extractCourseCode(payload.courseId),
		projects,
		levels,
	};
}
