/**
 * `cancel_meeting` — skip one meeting (#1057).
 *
 * Writes in the same call, like `assign_roles`, and for the same reason: the
 * write is easy to see (the meeting disappears from the calendar) and easy to
 * undo (`restore_meeting` puts it back with every assignment intact, because
 * cancelling touches no `role_slots` row). Nothing is sent: the app drafts and
 * a human sends (ADR-0028), so the result carries the drafted `notice` for
 * Claude to show, built by the SAME `buildCancellationNotice` the meeting
 * page's sheet uses, from the same slots.
 *
 * Authorized against the club derived FROM THE MEETING
 * (`authorizeTokenForMeeting`), like every meeting-scoped tool: an admin or an
 * officer of that club and nobody else. Then `applyCancelMeeting`, the seam the
 * browser's `cancelMeeting` server fn calls, under the meeting lock — so the
 * connector and the button cannot disagree about which meetings may be
 * cancelled.
 *
 * ## Refusals are compared by identity with the exported constants
 *
 * `errors.ts` forbids mapping by message TEXT and sanctions exactly one thing:
 * comparing against an exported constant, by identity. The seam throws plain
 * `Error`s carrying those constants, so each is caught and given the nearest
 * code the vocabulary has — `LOCKED` for a completed meeting (that IS the
 * lock), `VALIDATION` for a date that has passed or a meeting already
 * cancelled (the request is wrong for the meeting's state). Anything else is
 * rethrown and becomes `INTERNAL`, which is what an unexpected throw should be.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings } from "#/db/schema";
import {
	buildCancellationNotice,
	holdersFromSlots,
	MEETING_ALREADY_CANCELLED_MESSAGE,
	MEETING_CANCEL_COMPLETED_MESSAGE,
	MEETING_CANCEL_PAST_MESSAGE,
} from "#/lib/meeting-cancellation-notice";
import { loadMeetingSlots } from "#/server/meeting-slots-logic";
import { applyCancelMeeting } from "#/server/meetings-logic";
import { authorizeTokenForMeeting } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

const inputSchema = { meetingId: z.string().uuid() };

/** The seam's refusal as an `McpError`, or the throw unchanged. */
function asMcpRefusal(err: unknown): unknown {
	if (!(err instanceof Error)) return err;
	if (err.message === MEETING_CANCEL_COMPLETED_MESSAGE) {
		return new McpError("LOCKED", err.message);
	}
	if (
		err.message === MEETING_CANCEL_PAST_MESSAGE ||
		err.message === MEETING_ALREADY_CANCELLED_MESSAGE
	) {
		return new McpError("VALIDATION", err.message);
	}
	return err;
}

export const cancelMeetingTool: McpToolDefinition = {
	name: "cancel_meeting",
	config: {
		title: "Cancel meeting",
		description:
			"Cancel (skip) one upcoming meeting. Everyone keeps their role, so " +
			"restore_meeting puts it back exactly as it was. Nothing is sent: the " +
			"result includes a drafted notice naming the date and every role " +
			"holder, for a person to copy and send. Refused for a completed " +
			"meeting, a meeting whose date has passed, or one already cancelled.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club } = await authorizeTokenForMeeting(ctx, args.meetingId);

		try {
			await applyCancelMeeting({
				meetingId: args.meetingId,
				actorMemberId: club.membershipId,
			});
		} catch (err) {
			throw asMcpRefusal(err);
		}

		const [meeting] = await db
			.select({ scheduledAt: meetings.scheduledAt })
			.from(meetings)
			.where(eq(meetings.id, args.meetingId))
			.limit(1);
		// Unreachable: the seam just updated this row. Fail closed regardless.
		if (!meeting) throw new McpError("NOT_FOUND", "Meeting not found.");
		// Names only (`loadMeetingSlots` carries no contact), in agenda order —
		// the same loader and the same order the sheet reads.
		const slots = await loadMeetingSlots(args.meetingId);
		const notice = buildCancellationNotice({
			clubName: club.name,
			scheduledAt: meeting.scheduledAt,
			timezone: club.timezone,
			holders: holdersFromSlots(slots),
		});

		return {
			meetingId: args.meetingId,
			clubId: club.clubId,
			status: "cancelled" as const,
			notice: notice.text,
		};
	},
};
