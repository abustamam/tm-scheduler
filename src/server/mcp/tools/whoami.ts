/**
 * `whoami` — who this token belongs to, and which clubs it may act on (#773).
 *
 * The ONE tool that calls `authenticateToken` rather than `authorizeToken`, and
 * the guard waives it by name for that reason: it is what TELLS the caller which
 * clubs exist, so it has no `clubId` to be checked against. Every other tool
 * names a club or a meeting and is authorized against that.
 *
 * It returns the token owner's own name and email — their own, from their own
 * credential — and no contact details for anyone else.
 */
import { authenticateToken } from "../authz-logic";
import type { McpToolDefinition } from "../tool";

export const whoamiTool: McpToolDefinition = {
	name: "whoami",
	config: {
		title: "Who am I",
		description:
			"The person this token belongs to, and the clubs where they are an " +
			"admin or hold an elected office. Call this first: every other tool " +
			"needs a clubId or a meetingId from here.",
	},
	handler: async (_input, ctx) => {
		const auth = await authenticateToken(ctx);
		return {
			user: auth.user,
			clubs: auth.clubs.map((c) => ({
				clubId: c.clubId,
				name: c.name,
				timezone: c.timezone,
				// How they hold admin here, because it changes what an officer
				// should expect to keep: a stored `admin` role survives their term
				// ending, an office does not.
				via: c.via,
				// The standing rule, so a caller proposing dates can propose ones
				// that fall on the club's own meeting night.
				recurrence: c.recurrence,
			})),
		};
	},
};
