// Club identifier resolution. Lives away from the createServerFn wrapper
// (`clubs.ts`, client-imported) so its `db` import is never bundled into the
// client. See the header of `members-logic.ts`.
import { eq, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { clubs } from "#/db/schema";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ResolvedClub = {
	id: string;
	slug: string;
	name: string;
	timezone: string;
	clubNumber: string | null;
};

/**
 * Resolve a URL segment to a club by slug (case-insensitive), then club number,
 * then UUID. Returns null if nothing matches. Slug is tried first, so a slug
 * that happens to equal a club number still wins as a slug.
 */
export async function resolveClubByIdentifier(
	identifier: string,
): Promise<ResolvedClub | null> {
	const seg = identifier.trim();
	const lower = seg.toLowerCase();

	// Build match conditions. Only compare against `id` when the segment is a
	// real UUID — otherwise Postgres throws "invalid input syntax for type uuid".
	const conds: SQL[] = [eq(clubs.slug, lower), eq(clubs.clubNumber, seg)];
	if (UUID_RE.test(seg)) conds.push(eq(clubs.id, seg));

	const rows = await db
		.select({
			id: clubs.id,
			slug: clubs.slug,
			name: clubs.name,
			timezone: clubs.timezone,
			clubNumber: clubs.clubNumber,
		})
		.from(clubs)
		.where(or(...conds));

	if (rows.length === 0) return null;
	// Precedence: slug > club number > id.
	return (
		rows.find((r) => r.slug === lower) ??
		rows.find((r) => r.clubNumber === seg) ??
		rows[0]
	);
}

// ---------------------------------------------------------------------------
// Club profile (district / mission / meeting schedule) — printable-agenda fields.
// ---------------------------------------------------------------------------

export type ClubProfile = {
	name: string;
	district: string | null;
	mission: string | null;
	meetingSchedule: string | null;
};

/** The free-text profile fields for the club-settings form. Null if unset. */
export async function getClubProfile(
	clubId: string,
): Promise<ClubProfile | null> {
	const [row] = await db
		.select({
			name: clubs.name,
			district: clubs.district,
			mission: clubs.mission,
			meetingSchedule: clubs.meetingSchedule,
		})
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	return row ?? null;
}

// Empty strings collapse to null so cleared fields disappear from the agenda
// (no empty labels/artifacts) rather than persisting a blank value.
const emptyToNull = z
	.string()
	.trim()
	.transform((s) => (s.length === 0 ? null : s))
	.nullable()
	.optional();

export const clubProfileSchema = z.object({
	clubId: z.string().uuid(),
	district: emptyToNull,
	mission: emptyToNull,
	meetingSchedule: emptyToNull,
});
export type ClubProfileInput = z.infer<typeof clubProfileSchema>;

/** Set/clear the club's district, mission, and meeting schedule. Caller is
 *  responsible for the admin authorization check (see `updateClubProfile`). */
export async function applyClubProfileUpdate(input: ClubProfileInput) {
	const [updated] = await db
		.update(clubs)
		.set({
			district: input.district ?? null,
			mission: input.mission ?? null,
			meetingSchedule: input.meetingSchedule ?? null,
		})
		.where(eq(clubs.id, input.clubId))
		.returning({ id: clubs.id });
	if (!updated) throw new Error("Club not found.");
	return { ok: true as const };
}
