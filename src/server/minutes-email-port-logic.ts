// Concrete MinutesEmailPort — the integration seam between the email flow (#165)
// and the minutes data/PDF (#152). It reuses #152's `renderMinutesPdf` (the SAME
// server-side generator the PDF *download* uses, so the emailed file is
// byte-identical — no second PDF path) and queries the active roster +
// present-guest attendance rows for the default recipient list. Pure/DB logic
// only (no createServerFn) so the Start compiler strips it from the client
// bundle when imported by the minutes-email server-fn handlers.
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { db } from "#/db";
import {
	clubs,
	guests,
	meetingAttendance,
	meetings,
	members,
} from "#/db/schema";
import type { MinutesEmailPort } from "./minutes-email-logic";
import { renderMinutesPdf } from "./minutes-pdf-logic";

export function createMinutesEmailPort(): MinutesEmailPort {
	return {
		// #152's real renderer — byte-identical to the PDF download.
		renderMinutesPdf(meetingId: string): Promise<Uint8Array> {
			return renderMinutesPdf(meetingId);
		},

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

		// meetings + clubs are existing tables — no #152 dependency.
		async loadHeader(meetingId: string) {
			const [row] = await db
				.select({ clubName: clubs.name, meetingDate: meetings.scheduledAt })
				.from(meetings)
				.innerJoin(clubs, eq(clubs.id, meetings.clubId))
				.where(eq(meetings.id, meetingId))
				.limit(1);
			if (!row) throw new Error("Meeting not found.");
			return { clubName: row.clubName, meetingDate: row.meetingDate };
		},
	};
}
