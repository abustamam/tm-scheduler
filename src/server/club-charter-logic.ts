// Club charter status writes (#944), split out from the createServerFn wrappers
// (`clubs.ts` for the admin actions, `onboarding.ts` for the superadmin revert)
// so they are directly integration-testable and their `db` import never reaches
// the client bundle. See the header of `members-logic.ts`.
//
// The callers enforce authorization: marking a club chartered and editing its
// charter date are club-admin actions; moving a club BACK to chartering is
// superadmin-only, which is why that one is wrapped in `onboarding.ts`.
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { clubs } from "#/db/schema";
import {
	type CharterStatus,
	charterDateSchema,
	charterInvariantError,
	optionalClubNumberSchema,
} from "#/lib/club-charter";
import { isUniqueViolation } from "./pg-errors";

export interface ClubCharter {
	charterStatus: CharterStatus;
	/** `YYYY-MM-DD`, or null when not recorded (every backfilled club). */
	charteredAt: string | null;
	clubNumber: string | null;
}

/** A club's charter status, date and number. Throws when the club does not exist. */
export async function getClubCharter(clubId: string): Promise<ClubCharter> {
	const [row] = await db
		.select({
			charterStatus: clubs.charterStatus,
			charteredAt: clubs.charteredAt,
			clubNumber: clubs.clubNumber,
		})
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	if (!row) throw new Error("Club not found.");
	return row;
}

export const markClubCharteredSchema = z
	.object({
		clubId: z.string().uuid(),
		/** Required: a club moved to chartered through the app must supply it. */
		charteredAt: charterDateSchema,
		clubNumber: optionalClubNumberSchema,
	})
	.superRefine((v, ctx) => {
		const invariant = charterInvariantError({
			charterStatus: "chartered",
			clubNumber: v.clubNumber,
		});
		if (invariant) {
			ctx.addIssue({
				code: "custom",
				path: ["clubNumber"],
				message: invariant,
			});
		}
	});
export type MarkClubCharteredInput = z.output<typeof markClubCharteredSchema>;

export const ALREADY_CHARTERED_MESSAGE = "This club is already chartered.";
export const NOT_CHARTERED_MESSAGE =
	"This club hasn't chartered yet. Mark it as chartered first.";

function duplicateNumberMessage(clubNumber: string): string {
	return `A club with number ${clubNumber} already exists.`;
}

/**
 * Move a chartering club to chartered, recording its charter date and club
 * number (the number the club already holds is kept when the same one is sent).
 * Refused when the club is already chartered — the charter date of a chartered
 * club is edited with `updateClubCharterDate`, and the number is not this
 * action's to change after charter.
 *
 * The status is re-checked IN the update's WHERE, not only in the read before
 * it, so two admins marking the same club at once cannot both succeed.
 */
export async function markClubChartered(
	input: MarkClubCharteredInput,
): Promise<{ ok: true }> {
	const invariant = charterInvariantError({
		charterStatus: "chartered",
		clubNumber: input.clubNumber,
	});
	if (invariant) throw new Error(invariant);
	const clubNumber = input.clubNumber as string;

	const current = await getClubCharter(input.clubId);
	if (current.charterStatus === "chartered") {
		throw new Error(ALREADY_CHARTERED_MESSAGE);
	}

	// Friendly message for a number another club holds; the unique index is the
	// backstop for a concurrent race and is translated below.
	const [dupe] = await db
		.select({ id: clubs.id })
		.from(clubs)
		.where(and(eq(clubs.clubNumber, clubNumber), ne(clubs.id, input.clubId)))
		.limit(1);
	if (dupe) throw new Error(duplicateNumberMessage(clubNumber));

	let updated: { id: string }[];
	try {
		updated = await db
			.update(clubs)
			.set({
				charterStatus: "chartered",
				charteredAt: input.charteredAt,
				clubNumber,
			})
			.where(
				and(eq(clubs.id, input.clubId), eq(clubs.charterStatus, "chartering")),
			)
			.returning({ id: clubs.id });
	} catch (err) {
		if (isUniqueViolation(err)) {
			throw new Error(duplicateNumberMessage(clubNumber));
		}
		throw err;
	}
	if (updated.length === 0) throw new Error(ALREADY_CHARTERED_MESSAGE);
	return { ok: true };
}

export const updateCharterDateSchema = z.object({
	clubId: z.string().uuid(),
	charteredAt: charterDateSchema,
});
export type UpdateCharterDateInput = z.output<typeof updateCharterDateSchema>;

/**
 * Correct a chartered club's charter date, or record it for a club that was
 * backfilled without one. Refused for a chartering club: it has no charter date
 * until it is marked chartered, which is the action that sets one.
 */
export async function updateClubCharterDate(
	input: UpdateCharterDateInput,
): Promise<{ ok: true }> {
	const updated = await db
		.update(clubs)
		.set({ charteredAt: input.charteredAt })
		.where(
			and(eq(clubs.id, input.clubId), eq(clubs.charterStatus, "chartered")),
		)
		.returning({ id: clubs.id });
	if (updated.length === 0) {
		await getClubCharter(input.clubId); // "Club not found." when it isn't one
		throw new Error(NOT_CHARTERED_MESSAGE);
	}
	return { ok: true };
}

/**
 * Move a chartered club BACK to chartering — the correction for a club marked
 * chartered by mistake. SUPERADMIN-only (the caller enforces it). Clears the
 * charter date, since a chartering club has none; keeps the club number, since
 * a chartering club may hold one. Idempotent on a club already chartering.
 */
export async function revertClubToChartering(
	clubId: string,
): Promise<{ ok: true }> {
	const updated = await db
		.update(clubs)
		.set({ charterStatus: "chartering", charteredAt: null })
		.where(eq(clubs.id, clubId))
		.returning({ id: clubs.id });
	if (updated.length === 0) throw new Error("Club not found.");
	return { ok: true };
}
