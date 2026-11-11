/**
 * `reopen_meeting` — put a completed meeting back to scheduled (#1572).
 *
 * The undo for `complete_meeting`, shaped like `restore_meeting`: writes in the
 * same call, authorized against the club derived FROM THE MEETING, then
 * `applyReopenMeeting` under the meeting lock. The seam refuses anything that is
 * not `completed` with an exported sentence, compared here by identity and
 * given `VALIDATION` (the request is wrong for the meeting's state). Ballots
 * `complete_meeting` closed stay closed.
 */
import { z } from "zod";
import { MEETING_REOPEN_NOT_COMPLETED_MESSAGE } from "#/lib/meeting-cancellation-notice";
import { applyReopenMeeting } from "#/server/meetings-logic";
import { authorizeTokenForMeeting } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

const inputSchema = { meetingId: z.string().uuid() };

export const reopenMeetingTool: McpToolDefinition = {
	name: "reopen_meeting",
	audience: "officer",
	// Completing again undoes it; a second reopen is refused.
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
	},
	config: {
		title: "Reopen meeting",
		description:
			"Put a completed meeting back to scheduled so it can be edited, then " +
			"complete it again. Ballots that completing closed stay closed. " +
			"Refused for a meeting that is not completed (a cancelled one is put " +
			"back with restore_meeting).",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club } = await authorizeTokenForMeeting(ctx, args.meetingId);

		try {
			await applyReopenMeeting({
				meetingId: args.meetingId,
				actorMemberId: club.membershipId,
			});
		} catch (err) {
			if (
				err instanceof Error &&
				err.message === MEETING_REOPEN_NOT_COMPLETED_MESSAGE
			) {
				throw new McpError("VALIDATION", err.message);
			}
			throw err;
		}

		return {
			meetingId: args.meetingId,
			clubId: club.clubId,
			status: "scheduled" as const,
		};
	},
};
