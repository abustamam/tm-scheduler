// Server-fn wrappers for the minutes-email flow (#165). Per the server-module
// rule (enforced by server-modules.guard.test.ts), this file exports ONLY
// createServerFns + types — all db/logic lives in `minutes-email-logic.ts` and
// the concrete port in `minutes-email-port.stub.ts`, so the Start compiler can
// strip the db-touching code from the client bundle.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { sendEmail } from "#/lib/email";
import { requireClubRole, requireUser } from "./guards";
import {
	resolveMinutesRecipients,
	sendMinutesEmail,
} from "./minutes-email-logic";
import { createMinutesEmailPortStub } from "./minutes-email-port.stub";

const recipientSchema = z.object({
	name: z.string().trim().min(1),
	// A UI-added address; nullable so the resolver can surface "no email on file".
	email: z.string().trim().email().nullable(),
});

const sendSchema = z.object({
	clubId: z.string().uuid(),
	meetingId: z.string().uuid(),
	// Admin-curated to-list from the editable UI. Omit to use the default
	// (active members + present guests) resolved server-side.
	recipients: z.array(recipientSchema).optional(),
	subject: z.string().trim().min(1).optional(),
	body: z.string().optional(),
});

/**
 * Email the meeting's minutes PDF to the club. ADMIN-ONLY
 * (`requireClubRole(..., ["admin"])`). Resolves the recipient list (skipping
 * anyone without an email), renders the #152 PDF via the injected port,
 * base64-encodes it, and sends one email with the PDF attached. With no
 * RESEND_API_KEY the transport logs recipients + intent instead of sending.
 */
export const sendMeetingMinutesEmail = createServerFn({ method: "POST" })
	.validator((i: unknown) => sendSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		const port = createMinutesEmailPortStub();
		return sendMinutesEmail(
			port,
			{ sendEmail },
			{
				meetingId: data.meetingId,
				recipients: data.recipients,
				subject: data.subject,
				body: data.body,
			},
		);
	});

/**
 * Resolve the DEFAULT recipient list (active members + present guests) for a
 * meeting, split into `recipients` (have email) and `skipped` (no email on
 * file), for prefilling the "Send minutes" editor. ADMIN-ONLY.
 *
 * INTEGRATION TODO: this depends on the port's `loadRecipients`, which is
 * stubbed until #152 lands (see minutes-email-port.stub.ts). Until wired it
 * throws; the UI can instead be seeded with recipients #152's Minutes tab
 * already has on hand (the `initialRecipients` prop).
 */
export const getMinutesRecipients = createServerFn({ method: "GET" })
	.validator((i: unknown) =>
		z
			.object({ clubId: z.string().uuid(), meetingId: z.string().uuid() })
			.parse(i),
	)
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		const port = createMinutesEmailPortStub();
		return resolveMinutesRecipients(await port.loadRecipients(data.meetingId));
	});
