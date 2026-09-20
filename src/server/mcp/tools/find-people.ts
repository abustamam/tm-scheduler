/**
 * `find_people` — the club's members and guests, in one list (#773).
 *
 * Together on purpose. The question a caller actually has is "who is this name
 * on the page", and a roster/guest split makes them ask it twice and decide
 * which answer to believe. A `kind` discriminator on each row is enough.
 *
 * **Contact details.** Guests carry MASKED contact — `j•••@gmail.com`,
 * `•••-4567` — through the one serializer (`toMcpGuest`), which is enough to
 * confirm a match and not enough to write to anyone. Members carry NO contact at
 * all: nothing in these tools needs it, and the meeting page's holder-contact
 * reader is gated for a reason (#37). A member's `preferredName` is a NAME and
 * not an exception to that rule (#776 item 4, decided on #788) — it sits beside
 * the full name this reader already publishes to anyone.
 *
 * Both sides read through existing readers rather than new queries:
 * `loadPublicClubRoster` for members (which carries its own archive gate) and
 * `loadGuestPipeline` for guests — the VP-Membership board's reader, because it
 * is the one that already carries stage, the derived visit count and the
 * preferred name. `listClubGuests` is the narrow picker reader and has none of
 * them.
 */
import { z } from "zod";
import { MAX_FIND_PEOPLE_RESULTS } from "#/lib/mcp-limits";
import { loadGuestPipeline } from "#/server/guest-pipeline-logic";
import { loadPublicClubRoster } from "#/server/members-logic";
import { authorizeToken } from "../authz-logic";
import { toMcpGuest, toMcpMember } from "../serialize";
import type { McpToolDefinition } from "../tool";

const inputSchema = {
	clubId: z.string().uuid(),
	query: z
		.string()
		.max(100)
		.optional()
		.describe("Case-insensitive substring of a name. Omit to list everyone."),
};

export const findPeopleTool: McpToolDefinition = {
	name: "find_people",
	config: {
		title: "Find people",
		description:
			"The club's roster members and current guests together, each with a " +
			"`kind`. Guest contact details are masked. Use the ids from here when " +
			"a tool asks for a memberId or guestId.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club } = await authorizeToken(ctx.rawToken, args.clubId);

		const [roster, guests] = await Promise.all([
			loadPublicClubRoster(club.clubId),
			// The VP-Membership board's reader: it is the one that already carries
			// stage, the DERIVED visit count and the preferred name, which is
			// exactly what this tool reports. `listClubGuests` is the narrow picker
			// reader and carries none of them.
			loadGuestPipeline(club.clubId),
		]);

		const people = [
			...roster.map((m) => ({
				// `preferredName` rides through the one serializer with everything
				// else (#776 item 4). It used to be hardcoded `null` here because
				// `loadPublicClubRoster` did not select the column, which made one
				// list answer the same field two ways: a guest's "goes by" name was
				// populated and a member's never was, so a caller reading the roster
				// concluded nobody on it had one.
				...toMcpMember(m),
				officerPositions: m.officerPositions,
			})),
			...guests.map((g) => ({
				...toMcpGuest(g),
				stage: g.stage,
				visitCount: g.visitCount,
			})),
		];

		const needle = args.query?.trim().toLowerCase();
		const matched = needle
			? people.filter(
					(p) =>
						p.name.toLowerCase().includes(needle) ||
						(p.preferredName?.toLowerCase().includes(needle) ?? false),
				)
			: people;

		return {
			clubId: club.clubId,
			// Say when the list was cut rather than silently returning a prefix: a
			// caller that believes it has everyone will conclude a name is absent.
			truncated: matched.length > MAX_FIND_PEOPLE_RESULTS,
			people: matched.slice(0, MAX_FIND_PEOPLE_RESULTS),
		};
	},
};
