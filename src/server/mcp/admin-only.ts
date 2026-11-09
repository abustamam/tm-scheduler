/**
 * The admin-only gate for connector tools whose app twin is
 * `requireClubRole(..., ["admin"])` (#1563). `audience: "officer"` lets an
 * open-term officer through `authorizeToken`; a tool that writes the roster must
 * then ask the one further question the app asks. Built on the exported
 * `adminClubsForUser`, whose rows carry `via`; it never reads a browser session
 * (authz-logic.ts explains why `requireClubRole` itself is off limits here).
 */
import { adminClubsForUser, type TokenClub } from "./authz-logic";
import { McpError } from "./errors";

export const ADMIN_ONLY_MESSAGE =
	"Only a club admin may change the roster. Officers can ask an admin to do it.";

export async function requireClubAdminStanding(
	userId: string,
	club: TokenClub,
): Promise<void> {
	const mine = (await adminClubsForUser(userId)).find(
		(c) => c.clubId === club.clubId,
	);
	if (mine?.via !== "admin")
		throw new McpError("FORBIDDEN", ADMIN_ONLY_MESSAGE);
}
