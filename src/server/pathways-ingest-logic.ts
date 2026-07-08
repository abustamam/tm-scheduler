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

// Bounds are defensive ceilings, not tuned limits — each is far above any real
// club's payload. A summary walk is one page per ~25 members (200 pages ≫ any
// real club); details are one entry per member×path (1000 ≫ real); the club
// GUID is a fixed-shape identifier (100 chars ≫ real). They exist so a hostile
// client can't force unbounded work after the token check.
const bodySchema = z.object({
	basecampClubGuid: z.string().min(1).max(100),
	pages: z.array(z.unknown()).min(1).max(200),
	details: z.array(z.unknown()).max(1000).optional(),
});

const WRONG_CLUB_WARNING =
	"This looks like a different Base Camp club than last time.";

/**
 * Extract the raw token from an Authorization header. The scheme is
 * case-insensitive per RFC 7235; leading/trailing whitespace is tolerated.
 * Returns null when the header is absent or not a `Bearer <token>` value.
 */
export function parseBearerToken(header: string | null): string | null {
	if (!header) return null;
	const m = /^Bearer\s+(.+)$/i.exec(header.trim());
	return m ? m[1] : null;
}

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
		// No payload contents in the log — it can carry member names/emails.
		console.warn("[ingest] unparseable progress payload");
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
		} catch (err) {
			// ADR-0011: the detail phase is best-effort and must never sink the
			// already-committed summary sync — degrade to a warning. But log the
			// cause (club id + error only, no payload) so a persistently broken
			// detail sync is debuggable in Railway logs instead of invisible.
			console.warn("[ingest] detail phase degraded for club", tok.clubId, err);
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
