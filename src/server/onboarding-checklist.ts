import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireClubAdminView, requireUser } from "./guards";
import { getOnboardingChecklistStatus } from "./onboarding-checklist-logic";

const uuid = z.string().uuid();

/**
 * Setup-checklist completion status for a club (#265) — drives the
 * dismissible onboarding checklist on `/officers`. ADMIN-only (effective
 * admin: stored `admin` role OR any elected office, or an active impersonation
 * session) via `requireClubAdminView`; never exposed to a plain member. This
 * module is imported by client route files, so it must export ONLY
 * createServerFns + types — the db logic lives in `onboarding-checklist-logic.ts`.
 * See `server-modules.guard.test.ts`.
 */
export const getOnboardingChecklist = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubAdminView(currentUser.id, clubId);
		return getOnboardingChecklistStatus(clubId);
	});
