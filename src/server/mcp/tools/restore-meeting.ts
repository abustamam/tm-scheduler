/**
 * `restore_meeting` — put a cancelled meeting back on the calendar (#1057).
 *
 * The undo for `cancel_meeting`. Writes in the same call, because the write is
 * visible (the meeting is back) and reversible (cancel it again), and it moves
 * no `role_slots` row: the assignments are exactly what they were when the
 * meeting was cancelled. No notice — nothing was sent on cancel, and the people
 * who hold roles have them still.
 *
 * Authorized against the club derived FROM THE MEETING
 * (`authorizeTokenForMeeting`), then `applyRestoreMeeting`, the seam the
 * browser's Restore button calls, under the meeting lock. Refusals are mapped
 * the way `cancel-meeting.ts` maps them: by identity with the exported
 * constants, to `VALIDATION`, since both say the request is wrong for the
 * meeting's state (its date has passed, or it is not cancelled).
 */
import { z } from "zod";
import {
	MEETING_NOT_CANCELLED_MESSAGE,
	MEETING_RESTORE_PAST_MESSAGE,
} from "#/lib/meeting-cancellation-notice";
import { applyRestoreMeeting } from "#/server/meetings-logic";
import { authorizeTokenForMeeting } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

const inputSchema = { meetingId: z.string().uuid() };

/** The seam's refusal as an `McpError`, or the throw unchanged. */
function asMcpRefusal(err: unknown): unknown {
	if (!(err instanceof Error)) return err;
	if (
		err.message === MEETING_RESTORE_PAST_MESSAGE ||
		err.message === MEETING_NOT_CANCELLED_MESSAGE
	) {
		return new McpError("VALIDATION", err.message);
	}
	return err;
}

export const restoreMeetingTool: McpToolDefinition = {
	name: "restore_meeting",
	config: {
		title: "Restore meeting",
		description:
			"Put a cancelled meeting back on the calendar, with every role " +
			"assignment exactly as it was. Refused for a meeting that is not " +
			"cancelled or whose date has passed.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club } = await authorizeTokenForMeeting(ctx, args.meetingId);

		try {
			await applyRestoreMeeting({
				meetingId: args.meetingId,
				actorMemberId: club.membershipId,
			});
		} catch (err) {
			throw asMcpRefusal(err);
		}

		return {
			meetingId: args.meetingId,
			clubId: club.clubId,
			status: "scheduled" as const,
		};
	},
};
