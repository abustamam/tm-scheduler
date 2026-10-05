/**
 * What an officer is told when the roster stops a member signing in, keyed by
 * the obstacle the server named (#756).
 *
 * One table, shared by the roster row's invite button, the member edit dialog
 * and the bulk-invite summary, because the three used to disagree about what
 * the same refusal meant. Each line names the ONE thing the reader can act on —
 * an earlier cut said "get you set up directly", which is a capability no club
 * officer has (`mergePeople` is superadmin-gated), and sent people to a dead
 * end.
 *
 * A plain `Record` over the union, so adding an obstacle is a type error here
 * rather than a missing message at runtime. Client-safe: no `#/db` import, so
 * it can be read from a route file.
 */
import type { RosterObstacle } from "#/server/account-link-logic";

export const ROSTER_CONFLICT_COPY: Record<RosterObstacle, string> = {
	no_vouching_row:
		"Saved — but this member can't sign in yet, because that email isn't the one on file for them.",
	shared_address:
		"Saved — but another member already has that email, so neither of them can sign in until each has their own address.",
};

/** The same two, phrased for the INVITE button, where nothing was saved. */
export const INVITE_CONFLICT_COPY: Record<RosterObstacle, string> = {
	no_vouching_row:
		"No invite sent — that email isn't the one on file for them, so the link couldn't attach to their account.",
	shared_address:
		"No invite sent — another member has the same email. Give each of them their own address first.",
};
