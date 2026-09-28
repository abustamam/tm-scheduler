/**
 * `get_lineup_blast` — draft one meeting's lineup message (#1024).
 *
 * Read-only, so it takes no planHash. It returns the SAME draft the meeting
 * page's Lineup blast button copies: both build it with `buildLineupBlast` from
 * the same `loadLineupBlastData`, and `lineup-blast-logic.integration.test.ts`
 * holds the two outputs equal.
 *
 * Authorized against the club derived FROM THE MEETING
 * (`authorizeTokenForMeeting`), like every meeting-scoped tool. That admits an
 * admin or an officer of the club and nobody else, so a plain member is
 * refused before anything is read. The meeting's Toastmaster who is neither
 * cannot hold a working token at all (`whoami` lists no club for them), which
 * makes this tool the narrower half of the rule `mayDraftLineupBlast` states;
 * the decision below still goes through that one rule rather than restating it.
 *
 * The draft carries names and the public meeting page. No contact details, and
 * never the meeting's video-call link (#731/#754).
 */
import { z } from "zod";
import { buildLineupBlast, mayDraftLineupBlast } from "#/lib/lineup-blast";
import { appBaseUrl } from "#/lib/unsubscribe-token";
import { loadLineupBlastData } from "#/server/lineup-blast-logic";
import { authorizeTokenForMeeting } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

const inputSchema = { meetingId: z.string().uuid() };

export const getLineupBlastTool: McpToolDefinition = {
	name: "get_lineup_blast",
	config: {
		title: "Get lineup blast",
		description:
			"Draft a meeting's lineup message: every role in agenda order, marked " +
			"confirmed, claimed (awaiting confirmation) or open, with a link to the " +
			"public meeting page. Returns plain text (for WhatsApp) and HTML (for " +
			"email). Read-only: nothing is sent; a person copies and sends it.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club } = await authorizeTokenForMeeting(ctx, args.meetingId);
		if (
			!mayDraftLineupBlast({
				isAdmin: club.via === "admin",
				isOfficer: club.via === "officer",
				holdsToastmasterSlot: false,
			})
		) {
			throw new McpError(
				"FORBIDDEN",
				"You are not an admin or officer of that club.",
			);
		}

		const data = await loadLineupBlastData(args.meetingId);
		const blast = buildLineupBlast(data, appBaseUrl());
		return {
			meetingId: data.meeting.id,
			clubId: club.clubId,
			subject: blast.subject,
			text: blast.text,
			html: blast.html,
			openCount: blast.openCount,
			lines: blast.lines,
		};
	},
};
