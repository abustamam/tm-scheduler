import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireClubAdminView, requireClubRole, requireUser } from "./guards";
import {
	type CreatedToken,
	createSyncToken,
	listSyncTokens,
	revokeSyncToken,
	type SyncTokenSummary,
} from "./sync-tokens-logic";

/** Mint a new club sync token. Admin only. Returns the raw token ONCE. */
export const generateSyncToken = createServerFn({ method: "POST" })
	.validator((i: unknown) =>
		z
			.object({
				clubId: z.string().uuid(),
				name: z.string().max(100).optional(),
			})
			.parse(i),
	)
	.handler(async ({ data }): Promise<CreatedToken> => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return createSyncToken({
			clubId: data.clubId,
			createdBy: user.id,
			name: data.name ?? null,
		});
	});

/** List a club's sync tokens (no secrets). Admin only. */
export const getSyncTokens = createServerFn({ method: "GET" })
	.validator((i: unknown) => z.object({ clubId: z.string().uuid() }).parse(i))
	.handler(async ({ data }): Promise<SyncTokenSummary[]> => {
		const user = await requireUser();
		await requireClubAdminView(user.id, data.clubId);
		return listSyncTokens(data.clubId);
	});

/** Revoke a club sync token. Admin only. */
export const revokeSyncTokenFn = createServerFn({ method: "POST" })
	.validator((i: unknown) =>
		z
			.object({ clubId: z.string().uuid(), tokenId: z.string().uuid() })
			.parse(i),
	)
	.handler(async ({ data }): Promise<{ ok: true }> => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		await revokeSyncToken({ clubId: data.clubId, tokenId: data.tokenId });
		return { ok: true };
	});
