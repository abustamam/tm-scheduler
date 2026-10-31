// Input schema and bounds for the public guest RSVP (#1443), split out of
// `guest-rsvp.ts` for the same reason `access-requests-schemas.ts` is split out
// of its server-fn module: the schema is directly unit-testable and a client
// form can import the bounds, while the server-fn module may export only server
// fns and types (`server-modules.guard.test.ts`).
//
// Pure: no `#/db`. Keep the server-fn factory's name out of this file, prose
// included, or the guard's raw substring scan opts it back in.
import { z } from "zod";

/** Under this many ms between opening the form and sending it is a bot. */
export const MIN_FILL_MS = 3000;
/** An RSVP is for a meeting at most this many days away. */
export const MAX_DAYS_OUT = 60;
export const RSVP_MEETING_REFUSED_MESSAGE =
	"This meeting isn't taking RSVPs. Please check the date or ask an officer.";

const uuid = z.string().uuid();
const optionalText = (max: number) =>
	z.string().trim().max(max).optional().or(z.literal(""));

/**
 * The public guest RSVP (#1443). No session: the meeting link is the credential,
 * like `submitGuestBook`. NO guest id field: the retry identity is `clientKey`,
 * so a guest id seen elsewhere cannot RSVP as that guest (an extra `guestId`
 * key is stripped). `website` is the honeypot and `fillMs` how long the form
 * was open, measured on the CLIENT so no clock is compared with another.
 * Neither ever rejects: a missing, non-finite or negative `fillMs` reads as 0,
 * too fast, so a caller that omits it is treated as a bot.
 */
export const guestRsvpSchema = z.object({
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
	fillMs: z
		.unknown()
		.optional()
		.transform((v) =>
			typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0,
		),
});
