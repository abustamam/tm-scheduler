/**
 * `keyShareGuests`: the writer-side half of the guest-merge lock protocol
 * (ADR-0031, "The lock protocol", #1623).
 *
 * A writer whose `INSERT ... ON CONFLICT` names a guest (`castVote`'s ballot,
 * `addGuestPresent`'s check-in) writes its unique-index entry BEFORE the
 * statement's foreign-key check key-shares the guest. A guest merge that already
 * holds the kept guest `FOR UPDATE` and re-points the absorbed guest's row onto
 * it collides with that pending entry while the writer waits on the merge: a
 * 40P01. Calling this BEFORE the insert makes the writer wait on the merge's
 * guest lock holding no index entry.
 *
 * Two rules keep it from becoming the other end of a cycle:
 *  - every guest the write names is taken in ONE statement, in id order, the
 *    order the merge takes its own two guest rows (a voter and a candidate are
 *    both merge parties when the kept guest votes for the absorbed one);
 *  - a writer that updates an EXISTING row locks that row `FOR UPDATE` first
 *    (`castVote` does), because the merge and the guest delete lock the rows
 *    naming the guest BEFORE the guest rows (`lockRowsNamingGuest`): the writer
 *    then meets them at the same first row, never at a guest.
 *
 * `FOR KEY SHARE` is the lock the FK check would take anyway, so it blocks
 * nothing the insert would not. A null id is skipped.
 */
import { inArray } from "drizzle-orm";
import type { db } from "#/db";
import { guests } from "#/db/schema";

type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

export async function keyShareGuests(
	conn: DbOrTx,
	guestIds: ReadonlyArray<string | null | undefined>,
): Promise<void> {
	const ids = [
		...new Set(guestIds.filter((id): id is string => typeof id === "string")),
	];
	if (ids.length === 0) return;
	await conn
		.select({ id: guests.id })
		.from(guests)
		.where(inArray(guests.id, ids))
		.orderBy(guests.id)
		.for("key share");
}
