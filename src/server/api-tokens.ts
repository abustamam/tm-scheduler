import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	type ApiTokenSummary,
	type CreatedApiToken,
	createApiToken,
	listApiTokens,
	revokeApiToken,
} from "./api-tokens-logic";
import { mayUseConnector } from "./connector-eligibility";
import { requireUser } from "./guards";

/**
 * Personal access tokens for `/api/mcp` (#773), managed on `/me`.
 *
 * These take `requireUser()` and NO `clubId`: the token belongs to a person,
 * not a club, which is the whole difference from `sync-tokens.ts` beside them.
 * What a token may act on is resolved per call from its owner's live
 * memberships, so there is no club-scoped gate to apply here and none of these
 * fns names one.
 *
 * `/me` is the right home for the same reason — it is the app's only user-level
 * page, and a credential that follows a person across every club they are an
 * officer of does not belong under any one club's admin section.
 */

/** Whether minting a token could authorize anything, and the token list. */
export interface ApiTokenState {
	/**
	 * The user is an active admin, or holds an open officer term, in at least one
	 * club (`mayUseConnector`, the rule the consent screen applies too).
	 * Resolved SERVER-side, rather than re-derived on the client: the route context carries
	 * `officerPositions` for the ACTIVE club only, so a client-side check would
	 * hide the section from an officer whose office is in another club.
	 */
	eligible: boolean;
	tokens: ApiTokenSummary[];
}

/** The `/me` section's state: eligibility plus the user's own tokens. */
export const getApiTokenState = createServerFn({ method: "GET" }).handler(
	async (): Promise<ApiTokenState> => {
		const user = await requireUser();
		const [eligible, tokens] = await Promise.all([
			mayUseConnector(user.id),
			listApiTokens(user.id),
		]);
		return { eligible, tokens };
	},
);

/**
 * Mint a personal access token. Returns the raw value ONCE.
 *
 * Refuses for a user who is an admin nowhere. Not a security boundary — such a
 * token would authorize nothing, because every tool resolves a membership — but
 * a credential that silently cannot do anything is worse than a clear refusal.
 */
export const generateApiToken = createServerFn({ method: "POST" })
	.validator((i: unknown) =>
		z.object({ name: z.string().max(100).optional() }).parse(i ?? {}),
	)
	.handler(async ({ data }): Promise<CreatedApiToken> => {
		const user = await requireUser();
		if (!(await mayUseConnector(user.id))) {
			throw new Error(
				"Only a club admin or officer can create an access token.",
			);
		}
		return createApiToken({ userId: user.id, name: data.name ?? null });
	});

/** Revoke one of the caller's OWN tokens. Scoped by user id in the query. */
export const revokeApiTokenFn = createServerFn({ method: "POST" })
	.validator((i: unknown) => z.object({ tokenId: z.string().uuid() }).parse(i))
	.handler(async ({ data }): Promise<{ ok: true }> => {
		const user = await requireUser();
		await revokeApiToken({ userId: user.id, tokenId: data.tokenId });
		return { ok: true as const };
	});
