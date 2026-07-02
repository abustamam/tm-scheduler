// Club identifier resolution. Lives away from the createServerFn wrapper
// (`clubs.ts`, client-imported) so its `db` import is never bundled into the
// client. See the header of `members-logic.ts`.
import { eq, or, type SQL } from "drizzle-orm";
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
