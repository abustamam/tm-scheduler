import { createServerFn } from "@tanstack/react-start";
import { db } from "#/db";
import { isDemoClub } from "./demo-club-flag";
import { assertClubNotArchived } from "./guards";
import { submitGuestRsvpLogic } from "./guest-rsvp-logic";
import { guestRsvpSchema, MIN_FILL_MS } from "./guest-rsvp-schemas";

// The db-touching logic lives in `guest-rsvp-logic.ts` (never imported by client
// routes) so it can't drag `#/db` → `pg` into the browser bundle. This module
// exports ONLY createServerFns + types — see `server-modules.guard.test.ts`.
export type {
	GuestRsvpConfirmation,
	GuestRsvpResult,
} from "./guest-rsvp-logic";

export const submitGuestRsvp = createServerFn({ method: "POST" })
	.validator((input: unknown) => guestRsvpSchema.parse(input))
	.handler(async ({ data }) => {
		// A bot gets the success shape before anything is read (honeypot, then
		// fill time; a missing `fillMs` is 0, so too fast).
		if (data.website !== "" || data.fillMs < MIN_FILL_MS) {
			return { ok: true as const, confirmation: null };
		}
		// Kept after the bot checks: a demo club returns below without reaching
		// the logic, whose own archive gate would otherwise never run for it.
		await assertClubNotArchived(data.clubId);
		// Demo club keeps no guest data (#1199): success-shaped, nothing written.
		if (await isDemoClub(db, data.clubId)) {
			return { ok: true as const, confirmation: null };
		}
		return submitGuestRsvpLogic({
			clubId: data.clubId,
			meetingId: data.meetingId,
			clientKey: data.clientKey,
			firstName: data.firstName,
			email: data.email || null,
			phone: data.phone || null,
			website: data.website,
			fillMs: data.fillMs,
		});
	});
