// Server-fn wrapper for the minutes-email draft (#165, #903). Per the
// server-module rule (enforced by server-modules.guard.test.ts), this file
// exports ONLY createServerFns + types — all db/logic lives in
// `minutes-email-logic.ts` and the concrete port in
// `minutes-email-port-logic.ts`, so the Start compiler can strip the
// db-touching code from the client bundle.
//
// There is no send fn here any more (#903). Every message to a person is sent
// by a human: the officer opens a draft in their own mail app, built client-side
// by `buildMinutesMailto` (`#/lib/minutes-mailto`), and attaches the guest copy
// from `GET /api/meetings/$id/minutes/pdf?view=guests`.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireClubAdminView, requireUser } from "./guards";
import { resolveMinutesRecipients } from "./minutes-email-logic";
import { createMinutesEmailPort } from "./minutes-email-port-logic";

/**
 * Resolve the DEFAULT recipient list (active members + present guests) for a
 * meeting, split into `recipients` (have email) and `skipped` (no email on
 * file), for prefilling the "Email the minutes" draft. ADMIN-ONLY.
 */
export const getMinutesRecipients = createServerFn({ method: "GET" })
	.validator((i: unknown) =>
		z
			.object({ clubId: z.string().uuid(), meetingId: z.string().uuid() })
			.parse(i),
	)
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubAdminView(user.id, data.clubId);
		const port = createMinutesEmailPort();
		return resolveMinutesRecipients(await port.loadRecipients(data.meetingId));
	});
