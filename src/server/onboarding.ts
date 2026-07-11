import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSuperadmin, requireUser } from "./guards";
import {
	createClubSchema,
	createClubWithAdmin,
	getClubConsoleDetail,
	listClubsForConsole,
	updateAdminEmailSchema,
	updateUnclaimedAdminEmail,
} from "./onboarding-logic";

// Superadmin onboarding console (#182). Every fn is gated by `requireSuperadmin`
// server-side (the client route guard is defense-in-depth only). This module is
// imported by client route files, so it must export ONLY createServerFns + types
// — the db logic lives in `onboarding-logic.ts`. See server-modules.guard.test.ts.

/** All clubs with member count + first-admin claim status. SUPERADMIN-only. */
export const listConsoleClubs = createServerFn({ method: "GET" }).handler(
	async () => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return listClubsForConsole();
	},
);

/** One club's detail (first admin + claim status) for the console. SUPERADMIN-only. */
export const getConsoleClubDetail = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => z.string().uuid().parse(clubId))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return getClubConsoleDetail(data);
	});

/** Provision a new club: club + standard role template + first admin, atomically.
 *  SUPERADMIN-only. */
export const provisionClub = createServerFn({ method: "POST" })
	.validator((input: unknown) => createClubSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return createClubWithAdmin(data);
	});

/** Correct an UNCLAIMED first admin's email (refused once linked). SUPERADMIN-only. */
export const updateConsoleAdminEmail = createServerFn({ method: "POST" })
	.validator((input: unknown) => updateAdminEmailSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return updateUnclaimedAdminEmail(data);
	});
