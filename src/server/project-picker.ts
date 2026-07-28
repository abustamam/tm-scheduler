/**
 * Server fns for the Pathways project picker (#418). Exports ONLY
 * `createServerFn`s and types — the db logic lives in
 * `project-picker-logic.ts`, because a plain db-touching export here would drag
 * `#/db` → `pg` → `Buffer` into the client bundle and white-screen the page.
 * Enforced by `server-modules.guard.test.ts`.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSessionUser } from "./guards";
import {
	listProjectOptions,
	type PickerPath,
	type PickerProject,
	resolveMemberSubject,
	viewerMaySeeProgress,
} from "./project-picker-logic";

export type { PickerPath, PickerProject };

const optionsSchema = z.object({ memberId: z.string().uuid() });

/**
 * The paths + projects a member may pick from when claiming or editing a
 * speaker slot.
 *
 * Takes only a `memberId` and derives the club from that row. The claim sheet
 * changes subject as the claimant picks their name, so threading a clubId
 * through every call site would only add a way for the two to disagree — and
 * the club is never the caller's to assert here anyway, it's a property of the
 * member.
 *
 * PUBLIC — no session required, because claiming a speaker slot doesn't need
 * one: on the public club page the claimant picks their name and books
 * themselves in. What it returns is already public: the enrolled path names,
 * plus the TI project catalog. The agenda prints
 * "Engaging Humor · Ice Breaker · Level 1" on that same public page today.
 *
 * Completion marks are the one thing session-gated. Which projects someone has
 * FINISHED is a personal educational record feeding award eligibility, and the
 * public club page is only a soft honor-system name-pick — the same line that
 * already keeps member email and phone behind sign-in. So marks ride along only
 * for the member themselves or an admin of their club; everyone else gets the
 * identical option list with every `complete` false.
 */
export const getProjectOptions = createServerFn({ method: "GET" })
	.validator((input: unknown) => optionsSchema.parse(input))
	.handler(async ({ data }): Promise<PickerPath[]> => {
		const subject = await resolveMemberSubject(data.memberId);
		if (!subject) return [];

		const user = await getSessionUser();
		const includeProgress = user
			? await viewerMaySeeProgress({ userId: user.id, ...subject })
			: false;

		return listProjectOptions(subject.personId, { includeProgress });
	});
