// Concrete MinutesEmailPort — the default recipient list for the minutes
// email draft (#165, #903): the active roster + the guests marked present.
// There is no PDF member any more: GavelUp does not send the minutes, so it
// renders nothing to attach. The officer downloads the guest copy from
// `GET /api/meetings/$id/minutes/pdf?view=guests` and attaches it themselves.
// Pure/DB logic only (no createServerFn) so the Start compiler strips it from
// the client bundle when imported by the minutes-email server-fn handler.
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { db } from "#/db";
import { guests, meetingAttendance, meetings, members } from "#/db/schema";
import type { MinutesEmailPort } from "./minutes-email-logic";

export function createMinutesEmailPort(): MinutesEmailPort {
	return {
		// Default recipients: every active roster member + every guest marked
		// present at this meeting (ADR-0014). Emails may be null — the pure
		// `resolveMinutesRecipients` splits those into `skipped`.
		async loadRecipients(meetingId: string) {
			const [meeting] = await db
				.select({ clubId: meetings.clubId })
				.from(meetings)
				.where(eq(meetings.id, meetingId))
				.limit(1);
			if (!meeting) throw new Error("Meeting not found.");

			const memberRows = await db
				.select({ name: members.name, email: members.email })
				.from(members)
				.where(
					and(eq(members.clubId, meeting.clubId), eq(members.status, "active")),
				)
				.orderBy(asc(members.name));

			const guestRows = await db
				.select({ name: guests.name, email: guests.email })
				.from(meetingAttendance)
				.innerJoin(guests, eq(guests.id, meetingAttendance.guestId))
				.where(
					and(
						eq(meetingAttendance.meetingId, meetingId),
						eq(meetingAttendance.status, "present"),
						isNotNull(meetingAttendance.guestId),
					),
				)
				.orderBy(asc(guests.name));

			return { members: memberRows, presentGuests: guestRows };
		},
	};
}
