/**
 * Core logic for the extension ingest endpoint (#107). A `-logic.ts` so `#/db`
 * stays out of the client bundle. Reuses the v1 parse/upsert pipeline verbatim
 * (normalizePages → parseProgressPages → syncClubProgress) — this file adds
 * token auth and the wrong-club soft-warn, and (when the body carries an optional
 * `details` array) parses each /detail payload and runs `syncClubDetail`, merging
 * a `detail` block into the result. Throws `IngestError` with an HTTP status; the
 * route maps it to a Response.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { syncTokens } from "#/db/schema";
import {
	type BcmDetailPayload,
	parseDetailPayload,
} from "#/lib/basecamp-detail";
import {
	type BcmProgressPage,
	normalizePages,
	parseProgressPages,
} from "#/lib/basecamp-progress";
import { type DetailSyncResult, syncClubDetail } from "./pathways-detail-logic";
import { type SyncResult, syncClubProgress } from "./pathways-sync-logic";
import { type ResolvedToken, resolveActiveToken } from "./sync-tokens-logic";

export class IngestError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "IngestError";
	}
}

const bodySchema = z.object({
	basecampClubGuid: z.string().min(1),
	pages: z.array(z.unknown()).min(1),
	details: z.array(z.unknown()).optional(),
});

const WRONG_CLUB_WARNING =
	"This looks like a different Base Camp club than last time.";

export async function ingestForToken(
	rawToken: string | null,
	body: unknown,
): Promise<SyncResult & { warning?: string; detail?: DetailSyncResult }> {
	if (!rawToken) throw new IngestError(401, "Missing bearer token.");
	const tok = await resolveActiveToken(rawToken);
	if (!tok) throw new IngestError(401, "Invalid or revoked token.");

	const parsed = bodySchema.safeParse(body);
	if (!parsed.success) {
		throw new IngestError(
			400,
			"Request body must be { basecampClubGuid, pages }.",
		);
	}

	let rows: ReturnType<typeof parseProgressPages>;
	try {
		rows = parseProgressPages(
			normalizePages(parsed.data.pages as BcmProgressPage[]),
		);
	} catch {
		throw new IngestError(
			400,
			"That doesn't look like a Base Camp progress payload (expected the /api/bcm/progress JSON).",
		);
	}

	const result = await syncClubProgress(tok.clubId, rows);
	const warning = await recordTokenUse(tok, parsed.data.basecampClubGuid);

	// The detail phase is best-effort augmentation on top of the summary sync,
	// which has ALREADY committed above. It must never turn a good summary sync
	// into a 500 — parse failures and DB errors alike degrade to a warning
	// rather than throwing, so the caller always gets back the committed result.
	let detail: DetailSyncResult | undefined;
	let detailWarning: string | undefined;
	if (parsed.data.details && parsed.data.details.length > 0) {
		try {
			const parsedDetails = (parsed.data.details as BcmDetailPayload[]).map(
				parseDetailPayload,
			);
			detail = await syncClubDetail(tok.clubId, parsedDetails);
		} catch {
			detailWarning =
				"Project details couldn't be synced this time; counts are up to date.";
		}
	}

	const finalWarning = warning ?? detailWarning;
	return {
		...result,
		...(finalWarning ? { warning: finalWarning } : {}),
		...(detail ? { detail } : {}),
	};
}

async function recordTokenUse(
	tok: ResolvedToken,
	observedGuid: string,
): Promise<string | undefined> {
	const set: { lastUsedAt: Date; basecampClubGuid?: string } = {
		lastUsedAt: new Date(),
	};
	let warning: string | undefined;
	if (tok.basecampClubGuid === null) {
		set.basecampClubGuid = observedGuid;
	} else if (tok.basecampClubGuid !== observedGuid) {
		warning = WRONG_CLUB_WARNING;
	}
	await db.update(syncTokens).set(set).where(eq(syncTokens.id, tok.id));
	return warning;
}
