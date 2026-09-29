// New-member orientation server fns (#940). Thin `createServerFn` wrappers
// ONLY: all db logic lives in `orientation-logic.ts` so the Start compiler
// strips it from the client bundle (enforced by `server-modules.guard.test.ts`).
//
//  - `getMyOrientation`: the caller's own checklist. Member-level read gate;
//    a read-only impersonator has no membership and gets null. Writes nothing.
//  - `getMemberOrientation`: a member's orientation status for the member
//    page. Admin view gate. Writes nothing.
//  - `setMyBasecampSetup` / `dismissMyOrientation`: the member's own row
//    only. The logic resolves that row from the session (`ownMembershipId`,
//    which runs `requireMembership`); the input names no member.
//  - `startOrientation`: an admin write about another person,
//    `requireClubRole(…, ["admin"])`.
// `orientation-authz.guard.test.ts` pins each gate before its call.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	requireClubAdminView,
	requireClubRole,
	requireClubViewAccess,
	requireUser,
} from "./guards";
import {
	dismissMyOrientation as dismissMyOrientationDb,
	dismissOrientationSchema,
	getMemberOrientation as getMemberOrientationDb,
	getOrientation as getOrientationDb,
	setBasecampSetupSchema,
	setMyBasecampSetup as setMyBasecampSetupDb,
	startOrientation as startOrientationDb,
	startOrientationSchema,
} from "./orientation-logic";

const clubScoped = z.object({ clubId: z.string().uuid() });
const memberScoped = z.object({
	clubId: z.string().uuid(),
	memberId: z.string().uuid(),
});

/** The signed-in member's own checklist in this club, or null. */
export const getMyOrientation = createServerFn({ method: "GET" })
	.validator((i: unknown) => clubScoped.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		const access = await requireClubViewAccess(user.id, data.clubId);
		if (!access.membership) return null;
		return getOrientationDb(access.membership.id);
	});

/** A member's orientation status, for an admin on the member page. */
export const getMemberOrientation = createServerFn({ method: "GET" })
	.validator((i: unknown) => memberScoped.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubAdminView(user.id, data.clubId);
		return getMemberOrientationDb(data);
	});

export const setMyBasecampSetup = createServerFn({ method: "POST" })
	.validator((i: unknown) => setBasecampSetupSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		return setMyBasecampSetupDb({ ...data, userId: user.id });
	});

export const dismissMyOrientation = createServerFn({ method: "POST" })
	.validator((i: unknown) => dismissOrientationSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		return dismissMyOrientationDb({ ...data, userId: user.id });
	});

export const startOrientation = createServerFn({ method: "POST" })
	.validator((i: unknown) => startOrientationSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		const membership = await requireClubRole(user.id, data.clubId, ["admin"]);
		return startOrientationDb({ ...data, actorMemberId: membership.id });
	});
