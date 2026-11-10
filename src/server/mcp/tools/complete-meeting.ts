/**
 * `complete_meeting` — close out a meeting that has happened (#1572).
 *
 * Writes in the same call, like `cancel_meeting`, and `reopen_meeting` undoes
 * it. Authorized against the club derived FROM THE MEETING, then
 * `applyCompleteMeeting`, the seam the browser's Complete button calls: it sets
 * `completed`, closes every open ballot in the same transaction, logs
 * `meeting_edit`, and freezes the meeting number. Nothing is sent.
 *
 * `errors.ts` forbids mapping a refusal by message text, and the seam's
 * "date has not arrived" refusal has no exported constant, so the cancelled,
 * already-completed and too-early cases are decided HERE from the row this tool
 * loaded (the same predicates the seam uses); the seam stays the writer, and a
 * race past these checks surfaces as its own error.
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { clubs, meetings, meetingVoteSessions } from "#/db/schema";
import { MEETING_CANCELLED_MESSAGE } from "#/lib/meeting-cancellation-notice";
import { meetingDateReached } from "#/lib/meeting-lifecycle";
import { applyCompleteMeeting } from "#/server/meetings-logic";
import { sessionOpenNow } from "#/server/voting-logic";
import { authorizeTokenForMeeting } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

const inputSchema = { meetingId: z.string().uuid() };

export const NOT_YET_MESSAGE =
	"You can only complete a meeting on or after its scheduled date.";
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

		const [open] = await db
			.select({ n: sql<number>`count(*)::int` })
			.from(meetingVoteSessions)
			.where(
				and(
					eq(meetingVoteSessions.meetingId, args.meetingId),
					sessionOpenNow(),
				),
			);
		const closedVotes = open?.n ?? 0;

		try {
			await applyCompleteMeeting({
				meetingId: args.meetingId,
				actorMemberId: club.membershipId,
			});
		} catch (err) {
			if (err instanceof Error && err.message === MEETING_CANCELLED_MESSAGE) {
				throw new McpError("VALIDATION", err.message);
			}
			throw err;
		}

		return {
			meetingId: args.meetingId,
			clubId: club.clubId,
			status: "completed" as const,
			closedVotes,
		};
	},
};
