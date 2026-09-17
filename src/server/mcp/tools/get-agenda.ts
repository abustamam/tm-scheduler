/**
 * `get_agenda` — one meeting's role slots and meta (#773).
 *
 * Authorized against the club derived FROM THE MEETING
 * (`authorizeTokenForMeeting`), never a club id in the input. That is the rule
 * for every meeting-scoped tool: a caller who could pair their own club id with
 * another club's meeting would be checked against the first and act on the
 * second.
 *
 * Reads through `loadMeetingSlots` — the ONE slot loader the meeting page, the
 * print route and the agenda editor already share — rather than a narrower query
 * of its own. A second query is how two surfaces come to disagree about what a
 * slot is.
 *
 * It returns names and no contact details. `loadMeetingSlots` carries neither,
 * and nothing here reaches for `loadHolderContacts` (the gated holder-contact
 * reader the meeting page uses) — an agenda in a transcript has no use for a
 * member's phone number.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings } from "#/db/schema";
import { isMeetingLocked } from "#/lib/meeting-lifecycle";
import { resolveMeetingNumber } from "#/server/meeting-number-logic";
import { loadMeetingSlots } from "#/server/meeting-slots-logic";
import { authorizeTokenForMeeting } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";
import { clubLocalParts } from "./list-meetings";

const inputSchema = { meetingId: z.string().uuid() };

export const getAgendaTool: McpToolDefinition = {
	name: "get_agenda",
	config: {
		title: "Get agenda",
		description:
			"One meeting's agenda: theme, Word of the Day, whether it is locked, " +
			"and every role slot with its assignee or `open`. Slot ids from here " +
			"are what role assignment takes.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club } = await authorizeTokenForMeeting(
			ctx.rawToken,
			args.meetingId,
		);

		const [meeting] = await db
			.select({
				id: meetings.id,
				scheduledAt: meetings.scheduledAt,
				status: meetings.status,
				theme: meetings.theme,
				wordOfTheDay: meetings.wordOfTheDay,
				wodDefinition: meetings.wodDefinition,
				wodExample: meetings.wodExample,
				location: meetings.location,
			})
			.from(meetings)
			.where(eq(meetings.id, args.meetingId))
			.limit(1);
		// Unreachable: authorization above resolved this meeting's club. Fail
		// closed rather than rendering an agenda for nothing.
		if (!meeting) throw new McpError("NOT_FOUND", "Meeting not found.");

		const slots = await loadMeetingSlots(meeting.id);
		const { date, time, weekday } = clubLocalParts(
			meeting.scheduledAt,
			club.timezone,
		);

		return {
			meetingId: meeting.id,
			clubId: club.clubId,
			date,
			weekday,
			time,
			timezone: club.timezone,
			meetingNumber: await resolveMeetingNumber(meeting.id),
			status: meeting.status,
			// A completed meeting rejects every agenda edit (#150 / ADR-0012), so
			// say so up front rather than letting a caller plan changes that the
			// write tools will refuse.
			locked: isMeetingLocked(meeting.status),
			theme: meeting.theme,
			location: meeting.location,
			wordOfTheDay: meeting.wordOfTheDay,
			wodDefinition: meeting.wodDefinition,
			wodExample: meeting.wodExample,
			slots: slots.map((s) => ({
				slotId: s.id,
				role: s.roleName,
				roleKey: s.roleKey,
				slotIndex: s.slotIndex,
				assignee: s.assigneeName
					? {
							kind: s.assigneeIsGuest
								? ("guest" as const)
								: ("member" as const),
							id: s.assigneeIsGuest ? s.assigneeGuestId : s.assigneeId,
							name: s.assigneeName,
						}
					: null,
				// Which speaker slot this evaluator is paired with, so a caller can
				// keep the pairing intact when it moves people around.
				evaluatesSlotId: s.evaluatesSlotId,
				// Present only when a speech is linked to the slot. Speakers fill in
				// their own details; an empty speaker slot is the normal state.
				speechTitle: s.speechTitle,
			})),
		};
	},
};
