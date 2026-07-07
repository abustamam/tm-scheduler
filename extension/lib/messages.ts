/** Message contracts between the popup, content script, and background (#107). */

/** Minimal mirror of the server's SyncResult (+ optional warning). */
export interface SyncResultLike {
	matched: number;
	pathsUpserted: number;
	unmatched: { name: string; email: string | null; basecampUserId: string }[];
	warning?: string;
}

/** popup → content script (active Base Camp tab). */
export interface SyncRequest {
	type: "gavelup-sync";
	guidOverride: string | null;
}
export interface SyncResponse {
	ok: boolean;
	guid?: string;
	pages?: unknown[];
	error?: string;
}

/** popup → background service worker. */
export interface IngestRequest {
	type: "gavelup-ingest";
	guid: string;
	pages: unknown[];
}
export interface IngestResponse {
	ok: boolean;
	result?: SyncResultLike;
	error?: string;
}
