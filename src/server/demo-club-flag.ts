// The one read of `clubs.is_demo` (#1199), alone in a module with no heavy
// imports so the two PUBLIC writers that discard for the demo club
// (`submitGuestBook`, `leaveFeedbackLogic`) can use it without pulling the
// fixture and the delete logic into their import graph.
// `demo-reset-logic.ts` re-exports it.

import { eq } from "drizzle-orm";
import { clubs } from "#/db/schema";
import type { DbOrTx } from "./meeting-templates-logic";

/** Whether `clubId` is the demo club. False for a club that does not exist. */
export async function isDemoClub(
	conn: DbOrTx,
	clubId: string,
): Promise<boolean> {
	const [row] = await conn
		.select({ isDemo: clubs.isDemo })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	return row?.isDemo === true;
}
