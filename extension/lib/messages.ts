import type { DetailPayload } from "./basecamp-detail-walk";

/** Message contracts between the content script and the background worker (#107). */

/** Minimal mirror of the server's SyncResult (+ optional warning). */
export interface SyncResultLike {
	matched: number;
	pathsUpserted: number;
	unmatched: { name: string; email: string | null; basecampUserId: string }[];
	warning?: string;
	detail?: {
		membersWithDetail: number;
		unmatchedMembers: number;
		failedMembers: number;
		projectsStamped: number;
		projectsDerived: number;
		unmatchedElectives: { courseCode: string; name: string; level: number }[];
	};
}

/** content script → background: POST the collected pages to GavelUp. */
export interface IngestRequest {
	type: "gavelup-ingest";
	guid: string;
	pages: unknown[];
	details?: DetailPayload[];
}
export interface IngestResponse {
	ok: boolean;
	result?: SyncResultLike;
	error?: string;
}

/** content script → background: open the extension's Options page. */
export interface OpenOptionsRequest {
	type: "gavelup-open-options";
}
