// ===========================================================================
// INTEGRATION TODO (#165 depends on #152)
// ---------------------------------------------------------------------------
// This is the CONCRETE MinutesEmailPort. Two of its three methods are STUBS
// that throw, because they need #152's minutes data (`meeting_attendance`
// table + present guests) and #152's `renderMinutesPdf(meetingId)` renderer,
// neither of which exists in this branch.
//
// At integration, a human must WIRE:
//   1. `renderMinutesPdf` -> call #152's real `renderMinutesPdf(meetingId)`
//      (the SAME server-side generator the PDF *download* uses, so the emailed
//      file is byte-identical — do NOT create a second PDF path).
//   2. `loadRecipients` -> query active roster members (with email) + guests
//      marked `present` in `meeting_attendance` (with email) for the meeting.
//      Return `{ members, presentGuests }`, each `{ name, email: string|null }`.
//      `resolveMinutesRecipients` (in minutes-email-logic.ts) handles the
//      null-email filtering — this method just returns the raw rows.
//
// `loadHeader` below is REAL (meetings + clubs are existing tables) and needs
// no change.
// ===========================================================================

import { eq } from "drizzle-orm";
import { db } from "#/db";
import { clubs, meetings } from "#/db/schema";
import type { MinutesEmailPort } from "./minutes-email-logic";

export function createMinutesEmailPortStub(): MinutesEmailPort {
	return {
		// INTEGRATION TODO: replace with #152's real renderMinutesPdf(meetingId).
		async renderMinutesPdf(_meetingId: string): Promise<Uint8Array> {
			throw new Error(
				"WIRE AT INTEGRATION: connect to #152 renderMinutesPdf + attendance recipients",
			);
		},

		// INTEGRATION TODO: replace with a query over the active roster +
		// meeting_attendance (present guests) for this meeting.
		async loadRecipients(_meetingId: string) {
			throw new Error(
				"WIRE AT INTEGRATION: connect to #152 renderMinutesPdf + attendance recipients",
			);
		},

		// REAL — meetings + clubs are existing tables; no #152 dependency.
		async loadHeader(meetingId: string) {
			const [row] = await db
				.select({
					clubName: clubs.name,
					meetingDate: meetings.scheduledAt,
				})
				.from(meetings)
				.innerJoin(clubs, eq(clubs.id, meetings.clubId))
				.where(eq(meetings.id, meetingId))
				.limit(1);
			if (!row) throw new Error("Meeting not found.");
			return { clubName: row.clubName, meetingDate: row.meetingDate };
		},
	};
}
