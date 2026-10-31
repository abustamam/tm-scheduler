import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "#/db";
import { isDemoClub } from "./demo-club-flag";
import { assertClubNotArchived } from "./guards";
import { submitGuestRsvpLogic } from "./guest-rsvp-logic";

// The db-touching logic lives in `guest-rsvp-logic.ts` (never imported by client
// routes) so it can't drag `#/db` → `pg` into the browser bundle. This module
// exports ONLY createServerFns + types — see `server-modules.guard.test.ts`.
export type {
	GuestRsvpConfirmation,
	GuestRsvpResult,
} from "./guest-rsvp-logic";

const uuid = z.string().uuid();
const optionalText = (max: number) =>
	z.string().trim().max(max).optional().or(z.literal(""));

/**
 * The public guest RSVP (#1443). No session: the meeting link is the credential,
 * like `submitGuestBook`. NO guest id field: the retry identity is `clientKey`,
 * so a guest id seen elsewhere cannot RSVP as that guest. `website` is the
 * honeypot and `startedAt` the client's form-open time; neither ever rejects.
 */
const guestRsvpSchema = z.object({
	clubId: uuid,
	meetingId: uuid,
	clientKey: uuid,
	firstName: z
		.string()
		.trim()
		.min(1, "Please enter your first name.")
		.max(80, "That name is too long."),
	email: z.string().trim().email().max(200).optional().or(z.literal("")),
	phone: optionalText(40),
	website: z.string().max(500).optional().default(""),
	startedAt: z.number().optional().default(0),
});

export const submitGuestRsvp = createServerFn({ method: "POST" })
	.validator((input: unknown) => guestRsvpSchema.parse(input))
	.handler(async ({ data }) => {
		// Demo club keeps no guest data (#1199): success-shaped, nothing written.
		await assertClubNotArchived(data.clubId);
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
			startedAt: data.startedAt,
		});
	});
