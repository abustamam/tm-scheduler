// createServerFn wrappers for the reminder control layer (#274). This module is
// imported by client route files (/me, /admin/club-settings, /unsubscribe), so
// per the server-modules guard it exports ONLY createServerFns and types — all
// db logic lives in the sibling `notification-prefs-logic.ts`.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { verifyUnsubscribeToken } from "#/lib/unsubscribe-token";
import { requireClubRole, requireClubViewAccess, requireUser } from "./guards";
import {
	applyClubReminderSettings,
	clubReminderSettingsSchema,
	getClubReminderSettings,
	getReminderOptOutForUser,
	setPersonReminderOptOut,
	setReminderOptOutForUser,
} from "./notification-prefs-logic";

const uuid = z.string().uuid();

// ---------------------------------------------------------------------------
// Member-level opt-out (the signed-in user's own preference)
// ---------------------------------------------------------------------------

/** Read the signed-in user's reminder-email opt-out (for the /me toggle). */
export const getMyReminderOptOut = createServerFn({ method: "GET" }).handler(
	async () => {
		const currentUser = await requireUser();
		const optedOut = await getReminderOptOutForUser(currentUser.id);
		return { optedOut };
	},
);

/** Set the signed-in user's reminder-email opt-out. */
export const setMyReminderOptOut = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		z.object({ optedOut: z.boolean() }).parse(input),
	)
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		return setReminderOptOutForUser(currentUser.id, data.optedOut);
	});

// ---------------------------------------------------------------------------
// Club-level reminder settings
// ---------------------------------------------------------------------------

/** The club's reminder settings for the settings form. AUTHED — any member with
 *  view access (the route itself is admin-gated). */
export const loadClubReminderSettings = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubViewAccess(currentUser.id, clubId);
		return getClubReminderSettings(clubId);
	});

/** Enable/disable club role reminders and set the lead time. AUTHED — admin. */
export const updateClubReminderSettings = createServerFn({ method: "POST" })
	.validator((input: unknown) => clubReminderSettingsSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return applyClubReminderSettings(data);
	});

// ---------------------------------------------------------------------------
// No-auth one-click unsubscribe (from the link in every reminder email)
// ---------------------------------------------------------------------------

/**
 * Flip a person's opt-out to ON from the signed token in their reminder email —
 * NO sign-in required. PUBLIC by design: the HMAC signature (not a session)
 * authorizes the flip, so a forged/tampered token verifies to null and is
 * rejected. Idempotent. Called from the /unsubscribe route loader.
 */
export const unsubscribeFromReminders = createServerFn({ method: "GET" })
	.validator((token: unknown) => z.string().min(1).parse(token))
	.handler(async ({ data: token }) => {
		const personId = verifyUnsubscribeToken(token);
		if (!personId) return { ok: false as const };
		const { updated } = await setPersonReminderOptOut(personId, true);
		return { ok: updated };
	});
