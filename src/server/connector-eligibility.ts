import { adminClubsForUser } from "./mcp/authz-logic";

/**
 * Who may connect an app to GavelUp (#852): a person who is an active admin,
 * or holds an open officer term, in at least one club that is not archived.
 *
 * THE single statement of that rule. It gates minting a personal `tmk_` token
 * on `/me` (`src/server/api-tokens.ts`) and approving an OAuth connection on
 * `/oauth/consent` (the consent hook in `src/lib/auth.ts`), and the consent
 * screen reads it to decide whether to offer Approve at all. The day members
 * get tools of their own, this is the function that widens.
 *
 * Not the authorization for any tool call: `/api/mcp` re-resolves the caller's
 * clubs on every request (`authenticateToken` / `authorizeToken`), so a person
 * who stops being an officer loses access there whatever this said when they
 * connected. This decides only whether offering a credential makes sense.
 */
export async function mayUseConnector(userId: string): Promise<boolean> {
	const clubs = await adminClubsForUser(userId);
	return clubs.some((c) => !c.archived);
}
