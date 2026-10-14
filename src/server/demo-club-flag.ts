// The shared "is this club the demo club" read of `clubs.is_demo` (#1199), alone
// in a module with no heavy imports so the PUBLIC writers that discard for the
// demo club (`submitGuestBook`, `leaveFeedbackLogic`) can use it without pulling
// the fixture and the delete logic into their import graph. `demo-reset-logic.ts`
// re-exports it. It is not the only place the column is read: the area logic
// (`areas-logic.ts`, `area-health-logic.ts`) reads `is_demo` inline in queries
// that already select the club row (#1200).

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
