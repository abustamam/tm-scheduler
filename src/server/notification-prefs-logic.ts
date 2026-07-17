// Reminder control-layer DB logic (#274). Two layers of control over reminder
// emails, plus the reader helpers the role-reminder producer (#272) consumes:
//
//   A. Member level — a per-Person opt-out (`people.reminder_opt_out`). Default
//      opted-in; flipped from /me or the no-auth /unsubscribe link.
//   B. Club level — `enabled` + `lead_time_days` (`clubs.reminder_enabled`,
//      `clubs.reminder_lead_time_days`), set by an admin on /admin/club-settings.
//
// Lives in a `*-logic.ts` (not a createServerFn module) so it is integration-
// testable against a test db and NEVER pulled into the client bundle — see
// `CLAUDE.md` "Data layer" and `members-logic.ts` for the split. The
// createServerFn wrappers are in the sibling `notification-prefs.ts`.
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { clubs, people } from "#/db/schema";

// ---------------------------------------------------------------------------
// Club-level reminder settings
// ---------------------------------------------------------------------------

/** A club's role-reminder configuration (the control-layer, club half). */
export interface ClubReminderSettings {
	/** Master switch: when false the club sends no role reminders at all. */
	enabled: boolean;
	/** How many days before a meeting to remind slot holders. */
	leadTimeDays: number;
}

/**
 * Fallback for the (unexpected) missing-club case — `getClubReminderSettings`
 * returns these only when no club row is found. Matches the schema column
 * defaults: reminders OFF (opt-in per club — soft launch, see schema.ts / #272),
 * 3 days ahead.
 */
export const DEFAULT_CLUB_REMINDER_SETTINGS: ClubReminderSettings = {
	enabled: false,
	leadTimeDays: 3,
};

/**
 * Read a club's reminder settings. THE reader #272 calls to decide whether to
 * enqueue role reminders and at what lead time. Falls back to the conservative
 * defaults if the club row is somehow missing (never throws) so a producer can
 * treat the result as always-present.
 */
export async function getClubReminderSettings(
	clubId: string,
): Promise<ClubReminderSettings> {
	const [row] = await db
		.select({
			enabled: clubs.reminderEnabled,
			leadTimeDays: clubs.reminderLeadTimeDays,
		})
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	return row ?? DEFAULT_CLUB_REMINDER_SETTINGS;
}

// Lead time is bounded [0, 60] days — 0 = same-day, 60 is a generous ceiling
// that still keeps the producer from scheduling absurdly far ahead of a slot.
export const clubReminderSettingsSchema = z.object({
	clubId: z.string().uuid(),
	enabled: z.boolean(),
	leadTimeDays: z.number().int().min(0).max(60),
});
export type ClubReminderSettingsInput = z.infer<
	typeof clubReminderSettingsSchema
>;

/** Persist a club's reminder settings. Caller enforces admin authz (see the
 *  `updateClubReminderSettings` wrapper). */
export async function applyClubReminderSettings(
	input: ClubReminderSettingsInput,
): Promise<{ ok: true }> {
	const [updated] = await db
		.update(clubs)
		.set({
			reminderEnabled: input.enabled,
			reminderLeadTimeDays: input.leadTimeDays,
		})
		.where(eq(clubs.id, input.clubId))
		.returning({ id: clubs.id });
	if (!updated) throw new Error("Club not found.");
	return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Member-level opt-out (per Person)
// ---------------------------------------------------------------------------

/**
 * Read a person's reminder opt-out preference. Missing person ⇒ opted-in
 * (`false`) — the default — so callers never special-case an absent row.
 */
export async function getPersonReminderOptOut(
	personId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ optOut: people.reminderOptOut })
		.from(people)
		.where(eq(people.id, personId))
		.limit(1);
	return row?.optOut ?? false;
}

/** Flip a person's opt-out preference. Used by the no-auth /unsubscribe route
 *  (personId recovered from the signed token) and re-subscribe. Returns whether
 *  a matching person row was updated. */
export async function setPersonReminderOptOut(
	personId: string,
	optedOut: boolean,
): Promise<{ ok: true; updated: boolean }> {
	const rows = await db
		.update(people)
		.set({ reminderOptOut: optedOut })
		.where(eq(people.id, personId))
		.returning({ id: people.id });
	return { ok: true as const, updated: rows.length > 0 };
}

/**
 * Resolve a signed-in user → their Person (people.user_id) and read the opt-out.
 * Powers the /me toggle. Missing person ⇒ opted-in (`false`).
 */
export async function getReminderOptOutForUser(
	userId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ optOut: people.reminderOptOut })
		.from(people)
		.where(eq(people.userId, userId))
		.limit(1);
	return row?.optOut ?? false;
}

/**
 * Set the opt-out for the Person linked to a signed-in user (people.user_id).
 * Returns whether a linked person existed (a signed-in user with no roster
 * Person has no reminders to control — a graceful no-op).
 */
export async function setReminderOptOutForUser(
	userId: string,
	optedOut: boolean,
): Promise<{ ok: true; updated: boolean }> {
	const rows = await db
		.update(people)
		.set({ reminderOptOut: optedOut })
		.where(eq(people.userId, userId))
		.returning({ id: people.id });
	return { ok: true as const, updated: rows.length > 0 };
}

// ---------------------------------------------------------------------------
// Reader helpers for the role-reminder producer (#272)
// ---------------------------------------------------------------------------

/**
 * Given candidate person ids, return the subset that has OPTED OUT of reminder
 * emails, as a Set for O(1) membership tests. The #272 producer subtracts these
 * from its recipients before enqueuing. Empty input ⇒ empty set (no query).
 */
export async function listOptedOutPersonIds(
	personIds: string[],
): Promise<Set<string>> {
	if (personIds.length === 0) return new Set();
	const rows = await db
		.select({ id: people.id })
		.from(people)
		.where(and(inArray(people.id, personIds), eq(people.reminderOptOut, true)));
	return new Set(rows.map((r) => r.id));
}

/**
 * Convenience for #272: drop the members whose Person has opted out, preserving
 * every other field on the row. Generic over any shape carrying a `personId`, so
 * the producer can pass its own richer member objects and keep the survivors.
 * (The producer is still responsible for skipping guests / unlinked members —
 * this helper only applies the opt-out preference.)
 */
export async function filterRemindableMembers<T extends { personId: string }>(
	members: T[],
): Promise<T[]> {
	if (members.length === 0) return [];
	const optedOut = await listOptedOutPersonIds(members.map((m) => m.personId));
	return members.filter((m) => !optedOut.has(m.personId));
}
