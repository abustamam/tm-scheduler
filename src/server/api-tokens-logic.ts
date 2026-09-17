/**
 * DB logic for personal access tokens (#773) — the bearer credential
 * `/api/mcp` accepts. Kept in a `-logic.ts` so `#/db` never leaks into the
 * client bundle (server-modules guard).
 *
 * Mirrors `sync-tokens-logic.ts` deliberately, including the hashing note: the
 * raw token is returned exactly once, at creation, and otherwise only ever
 * stored and compared as a SHA-256 hash. Plain SHA-256 is adequate because the
 * token is 256 bits of randomness — it is not brute-forceable and a slow hash
 * buys nothing against an offline attacker who has the column.
 *
 * The one real difference from sync tokens is the owner: this token is a
 * PERSON, not a club. Nothing here takes a `clubId`. Which clubs a token may
 * act on is resolved per call from the owner's live memberships (`authz-logic`),
 * so revoking a membership narrows every existing token immediately, with no
 * token state to update.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "#/db";
import { apiTokens } from "#/db/schema";

/**
 * `tmk_` + 32 random bytes, base64url.
 *
 * The prefix differs from `sync_tokens`' `gup_` so a pasted token says which
 * kind it is before anything tries to resolve it — the two are accepted by
 * different endpoints and mean different things (a club vs. a person).
 */
export function generateRawApiToken(): string {
	return `tmk_${randomBytes(32).toString("base64url")}`;
}

export function hashApiToken(raw: string): string {
	return createHash("sha256").update(raw).digest("hex");
}

export interface CreatedApiToken {
	id: string;
	/** The raw token. Returned ONCE, at creation; never readable again. */
	token: string;
}

export async function createApiToken(input: {
	userId: string;
	name?: string | null;
}): Promise<CreatedApiToken> {
	const token = generateRawApiToken();
	const [row] = await db
		.insert(apiTokens)
		.values({
			userId: input.userId,
			tokenHash: hashApiToken(token),
			name: input.name ?? null,
		})
		.returning({ id: apiTokens.id });
	if (!row) throw new Error("Failed to create token.");
	return { id: row.id, token };
}

/** A token as the `/me` list shows it. Carries no hash and no raw value. */
export interface ApiTokenSummary {
	id: string;
	name: string | null;
	createdAt: Date;
	lastUsedAt: Date | null;
	revokedAt: Date | null;
}

export async function listApiTokens(
	userId: string,
): Promise<ApiTokenSummary[]> {
	return db
		.select({
			id: apiTokens.id,
			name: apiTokens.name,
			createdAt: apiTokens.createdAt,
			lastUsedAt: apiTokens.lastUsedAt,
			revokedAt: apiTokens.revokedAt,
		})
		.from(apiTokens)
		.where(eq(apiTokens.userId, userId))
		.orderBy(desc(apiTokens.createdAt));
}

/**
 * Soft-revoke one of the user's own tokens.
 *
 * Scoped by `userId` as well as `id`, so a token id learned from somewhere else
 * cannot be used to revoke another person's credential.
 */
export async function revokeApiToken(input: {
	userId: string;
	tokenId: string;
}): Promise<void> {
	await db
		.update(apiTokens)
		.set({ revokedAt: new Date() })
		.where(
			and(eq(apiTokens.id, input.tokenId), eq(apiTokens.userId, input.userId)),
		);
}

export interface ResolvedApiToken {
	id: string;
	userId: string;
}

/**
 * The active token row for a raw bearer value, or null.
 *
 * Null covers every rejection the endpoint answers 401 to — unknown, malformed,
 * and revoked alike — deliberately: telling a caller which of those it was
 * distinguishes "this token existed" from "it never did".
 */
export async function resolveActiveApiToken(
	rawToken: string,
): Promise<ResolvedApiToken | null> {
	const [row] = await db
		.select({ id: apiTokens.id, userId: apiTokens.userId })
		.from(apiTokens)
		.where(
			and(
				eq(apiTokens.tokenHash, hashApiToken(rawToken)),
				isNull(apiTokens.revokedAt),
			),
		)
		.limit(1);
	return row ?? null;
}

/**
 * Stamp `last_used_at`. Called OUTSIDE any apply transaction (design D10) — it
 * is telemetry for the token list, and a failure to record it must never roll
 * back the club write it accompanied.
 */
export async function touchApiToken(tokenId: string): Promise<void> {
	await db
		.update(apiTokens)
		.set({ lastUsedAt: new Date() })
		.where(eq(apiTokens.id, tokenId));
}
