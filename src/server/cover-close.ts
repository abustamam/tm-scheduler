// Closing a cover request (#1438). Its own module, not part of `cover-logic.ts`:
// the fill sites (`claimSlotCore`, `reassignSlotCore`, the guest assignment)
// live in modules `cover-logic.ts` itself imports from, and a cycle there is a
// module-level `undefined` waiting for the full suite to find it. This file
// imports only the schema.
import { and, eq, isNull } from "drizzle-orm";
import type { db } from "#/db";
import { slotCoverRequests } from "#/db/schema";

type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * Mark the slot's open cover request covered by whoever just filled it. A no-op
 * when the slot has none, so every fill site calls it unconditionally.
 *
 * MUST run in the same transaction as the write that filled the slot, AFTER that
 * write succeeded: a refused fill must leave the request open. The partial unique
 * index guarantees at most one row matches.
 *
 * `cover-close.guard.test.ts` fails when a fill site stops calling it.
 */
export async function closeCoverRequest(
	conn: DbOrTx,
	slotId: string,
	by: { memberId: string } | { guestId: string },
): Promise<void> {
	await conn
		.update(slotCoverRequests)
		.set({
			coveredByMemberId: "memberId" in by ? by.memberId : null,
			coveredGuestId: "guestId" in by ? by.guestId : null,
			coveredAt: new Date(),
		})
		.where(
			and(
				eq(slotCoverRequests.slotId, slotId),
				isNull(slotCoverRequests.coveredAt),
			),
		);
}
