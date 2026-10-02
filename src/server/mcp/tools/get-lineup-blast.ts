/**
 * `get_lineup_blast` — draft one meeting's lineup message (#1024).
 *
 * Read-only, so it takes no planHash. It returns the SAME draft the meeting
 * page's Lineup blast button copies: both build it with `buildLineupBlast` from
 * the same `loadPublicLineupBlastData`, and `lineup-blast-logic.integration.test.ts`
 * holds the two outputs equal.
 *
 * Authorized against the club derived FROM THE MEETING
 * (`authorizeTokenForMeeting`), like every meeting-scoped tool. That admits an
 * admin or an officer of the club and nobody else, so a plain member is
 * refused before anything is read. It is NARROWER than the button: a meeting's
 * Toastmaster who is neither cannot hold a working token at all (`whoami`
 * lists no club for them). Widening that is the maintainer's call, not this
 * tool's.
 *
 * The draft carries names and the public meeting page. No contact details, and
 * never the meeting's video-call link (#731/#754).
 */
import { z } from "zod";
import { buildLineupBlast, mayDraftLineupBlast } from "#/lib/lineup-blast";
import { loadPublicLineupBlastData } from "#/server/lineup-blast-logic";
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
			"email). Read-only: nothing is sent; a person copies and sends it. A " +
			"cancelled meeting has no lineup and is refused as LOCKED; " +
			"cancel_meeting returns that meeting's cancellation notice instead.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club } = await authorizeTokenForMeeting(ctx, args.meetingId);
		// DOCUMENTS the shared rule; it does not enforce anything. The token check
		// above already admitted only an admin or an officer, so this cannot
		// refuse. It is here so a reader finds `mayDraftLineupBlast` from the
		// tool, and so that if the token gate is ever widened this line is where
		// the rule starts to matter. Do not read it as a gate.
		const permitted = mayDraftLineupBlast({
			isAdmin: club.via === "admin",
			isOfficer: club.via === "officer",
			holdsToastmasterSlot: false,
		});
		if (!permitted) {
			throw new McpError(
				"FORBIDDEN",
				"You are not an admin or officer of that club.",
			);
		}

		// Null only for an archived club or a vanished meeting, both of which
		// the token check above already refused. Fail closed regardless.
		const data = await loadPublicLineupBlastData(args.meetingId);
		if (!data) throw new McpError("NOT_FOUND", "Meeting not found.");
		const blast = buildLineupBlast(data);
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
