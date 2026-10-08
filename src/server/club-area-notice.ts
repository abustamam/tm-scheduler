// The server fn behind the Area Director notice on club settings (#1118). A
// thin `createServerFn` wrapper only: the query lives in
// `club-area-notice-logic.ts` so the compiler strips it, and `#/db`, from the
// client bundle (server-modules guard).
//
// Admin-gated like the rest of the club-settings loaders. The notice names the
// director and the area, which a plain member has no use for and #1115 does not
// promise them. `requireClubAdminView` also refuses an archived club.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { loadClubAreaNoticeDb } from "./club-area-notice-logic";
import { requireClubAdminView, requireUser } from "./guards";

/** The club's area, division, district and current Area Director (#1118), or
 *  null when the club is in no area this program year. AUTHED: club admins. */
export const loadClubAreaNotice = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => z.string().uuid().parse(clubId))
	.handler(async ({ data: clubId }) => {
		const user = await requireUser();
		await requireClubAdminView(user.id, clubId);
		return loadClubAreaNoticeDb(clubId);
	});
