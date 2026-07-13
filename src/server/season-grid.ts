import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireMembership, requireUser } from "./guards";
import { loadSeasonGrid } from "./season-grid-logic";

const seasonGridInput = z.object({
	clubId: z.string().uuid(),
	count: z.union([z.literal(4), z.literal(8), z.literal("all")]),
});

// Re-export the payload types so client code keeps importing them from
// `#/server/season-grid`. The db-touching `loadSeasonGrid` lives in
// `season-grid-logic.ts` (never imported by client routes) so it can't leak
// `#/db` into the browser bundle — see `server-modules.guard.test.ts`.
export type {
	SeasonGridCell,
	SeasonGridCount,
	SeasonGridData,
	SeasonGridMeeting,
	SeasonGridMember,
	SeasonGridRow,
	SlotStatus,
} from "./season-grid-logic";

/**
 * Authed season grid — the shared sign-up sheet in the workspace. Any member of
 * the club may view it (it's a member-facing self-serve surface, #198); the
 * cells enforce their own act-on-your-own rules client-side + the claim/release
 * server fns re-check membership. (Was admin-only before #198.)
 */
export const getSeasonGrid = createServerFn({ method: "GET" })
	.validator((input: unknown) => seasonGridInput.parse(input))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireMembership(user.id, data.clubId);
		return loadSeasonGrid(data);
	});

/**
 * PUBLIC season grid — same data, no session required, for the no-auth club
 * shell (`club/$clubId/*`). Mirrors the trust model of `listUpcomingMeetings` /
 * `listMembers`: anyone with the club link can read the sheet. Claim/release
 * are still guarded by `requireMemberInClub` in `slots.ts`.
 */
export const getPublicSeasonGrid = createServerFn({ method: "GET" })
	.validator((input: unknown) => seasonGridInput.parse(input))
	.handler(async ({ data }) => loadSeasonGrid(data));
