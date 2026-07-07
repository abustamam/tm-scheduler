/**
 * DB logic for Pathways sync tokens (#107). Kept in a `-logic.ts` so `#/db`
 * never leaks into the client bundle (server-modules guard). The raw token is
 * returned exactly once (at creation) and otherwise only ever stored/compared
 * as a SHA-256 hash. Plain SHA-256 is adequate: the token is 256 bits of
 * randomness, so it is not brute-forceable and a slow hash buys nothing.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "#/db";
import { syncTokens } from "#/db/schema";

export function generateRawToken(): string {
	return `gup_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(raw: string): string {
	return createHash("sha256").update(raw).digest("hex");
}

export interface CreatedToken {
	id: string;
	token: string;
}

export async function createSyncToken(input: {
	clubId: string;
	createdBy: string;
	name?: string | null;
}): Promise<CreatedToken> {
	const token = generateRawToken();
	const [row] = await db
		.insert(syncTokens)
		.values({
			clubId: input.clubId,
			tokenHash: hashToken(token),
			name: input.name ?? null,
			createdBy: input.createdBy,
		})
		.returning({ id: syncTokens.id });
	if (!row) throw new Error("Failed to create sync token.");
	return { id: row.id, token };
}

export interface SyncTokenSummary {
	id: string;
	name: string | null;
	createdBy: string;
	basecampClubGuid: string | null;
	createdAt: Date;
	lastUsedAt: Date | null;
	revokedAt: Date | null;
}

export async function listSyncTokens(
	clubId: string,
): Promise<SyncTokenSummary[]> {
	return db
		.select({
			id: syncTokens.id,
			name: syncTokens.name,
			createdBy: syncTokens.createdBy,
			basecampClubGuid: syncTokens.basecampClubGuid,
			createdAt: syncTokens.createdAt,
			lastUsedAt: syncTokens.lastUsedAt,
			revokedAt: syncTokens.revokedAt,
		})
		.from(syncTokens)
		.where(eq(syncTokens.clubId, clubId));
}

export async function revokeSyncToken(input: {
	clubId: string;
	tokenId: string;
}): Promise<void> {
	await db
		.update(syncTokens)
		.set({ revokedAt: new Date() })
		.where(
			and(
				eq(syncTokens.id, input.tokenId),
				eq(syncTokens.clubId, input.clubId),
			),
		);
}

export interface ResolvedToken {
	id: string;
	clubId: string;
	basecampClubGuid: string | null;
}

export async function resolveActiveToken(
	rawToken: string,
): Promise<ResolvedToken | null> {
	const [row] = await db
		.select({
			id: syncTokens.id,
			clubId: syncTokens.clubId,
			basecampClubGuid: syncTokens.basecampClubGuid,
		})
		.from(syncTokens)
		.where(
			and(
				eq(syncTokens.tokenHash, hashToken(rawToken)),
				isNull(syncTokens.revokedAt),
			),
		);
	return row ?? null;
}
