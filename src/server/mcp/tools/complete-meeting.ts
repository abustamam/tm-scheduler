/**
 * `complete_meeting` — close out a meeting that has happened (#1572).
 *
 * Writes in the same call, like `cancel_meeting`, and `reopen_meeting` undoes
 * it. Authorized against the club derived FROM THE MEETING, then
 * `applyCompleteMeeting`, the seam the browser's Complete button calls: it sets
 * `completed`, closes every open ballot in the same transaction, logs
 * `meeting_edit`, and freezes the meeting number. Nothing is sent.
 *
 * The tool's early checks (cancelled, completed, too early) are friendly
 * previews from the row it loaded. The SEAM is the authority: it re-decides all
 * of them under the meeting lock, so two concurrent calls cannot both complete
 * (the loser gets `alreadyCompleted` and is refused as `LOCKED`), a meeting
 * rescheduled into the future between the preview and the write gets the seam's
 * "on or after" sentence mapped to `VALIDATION` by identity (an exported
 * constant, not message text), and the closed-ballot count is the seam's own.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { clubs, meetings } from "#/db/schema";
import { MEETING_CANCELLED_MESSAGE } from "#/lib/meeting-cancellation-notice";
import { meetingDateReached } from "#/lib/meeting-lifecycle";
import {
	applyCompleteMeeting,
	COMPLETE_NOT_YET_MESSAGE,
} from "#/server/meetings-logic";
import { authorizeTokenForMeeting } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

const inputSchema = { meetingId: z.string().uuid() };

export const NOT_YET_MESSAGE = COMPLETE_NOT_YET_MESSAGE;
export const ALREADY_COMPLETED_MESSAGE = "This meeting is already completed.";

export const completeMeetingTool: McpToolDefinition = {
	name: "complete_meeting",
	audience: "officer",
	// Locks the meeting and closes its ballots; reopen_meeting undoes the status,
	// not the closed ballots.
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
	},
	config: {
		title: "Complete meeting",
		description:
			"Mark one meeting complete, once its date has arrived. Completing " +
			"locks the meeting against further edits and CLOSES any ballots still " +
			"open on it; the result says how many it closed. Nothing is sent. " +
			"reopen_meeting puts it back to scheduled. Refused for a cancelled " +
			"meeting, one already completed, or one whose date has not arrived.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club } = await authorizeTokenForMeeting(ctx, args.meetingId);

		const [meeting] = await db
			.select({
				status: meetings.status,
				scheduledAt: meetings.scheduledAt,
				timezone: clubs.timezone,
			})
			.from(meetings)
			.innerJoin(clubs, eq(clubs.id, meetings.clubId))
			.where(eq(meetings.id, args.meetingId))
			.limit(1);
		if (!meeting) throw new McpError("NOT_FOUND", "Meeting not found.");
		if (meeting.status === "cancelled") {
			throw new McpError("VALIDATION", MEETING_CANCELLED_MESSAGE);
		}
		if (meeting.status === "completed") {
			throw new McpError("LOCKED", ALREADY_COMPLETED_MESSAGE);
		}
		if (!meetingDateReached(meeting.scheduledAt, meeting.timezone)) {
			throw new McpError("VALIDATION", NOT_YET_MESSAGE);
		}

		let result: Awaited<ReturnType<typeof applyCompleteMeeting>>;
		try {
			result = await applyCompleteMeeting({
				meetingId: args.meetingId,
				actorMemberId: club.membershipId,
			});
		} catch (err) {
			if (err instanceof Error && err.message === MEETING_CANCELLED_MESSAGE) {
				throw new McpError("VALIDATION", err.message);
			}
			if (err instanceof Error && err.message === COMPLETE_NOT_YET_MESSAGE) {
				throw new McpError("VALIDATION", NOT_YET_MESSAGE);
			}
			throw err;
		}
		if (result.alreadyCompleted) {
			throw new McpError("LOCKED", ALREADY_COMPLETED_MESSAGE);
		}

		return {
			meetingId: args.meetingId,
			clubId: club.clubId,
			status: "completed" as const,
			closedVotes: result.closedVotes,
		};
	},
};
