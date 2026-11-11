/**
 * `set_member_standing` — an admin changes one member's status (active,
 * inactive, former) and/or club role (admin, member) (#1577). The connector's
 * twin of the roster's "Set status" and "Set role", writing through THE SAME
 * WRITERS (`applySetMemberStatus`, `applySetMemberRole`) in one transaction
 * (`applyMemberStanding`): status first, then role, and a refusal by the second
 * leaves the first unapplied.
 *
 * The preview is the write-free verdict `memberStandingVerdict`
 * (`members-logic.ts`), which reads through the helpers the appliers use. It
 * states every side effect: the upcoming roles the change releases (going
 * inactive or former), the planned-attendance answers it deletes (going
 * former), what an admin may then do, and each refusal as a `blocking` item.
 *
 * Blocking items here are `{ code, message }` with codes local to this tool
 * (`LAST_ADMIN`, `FORMER_MEMBER_ROLE`); apply returns `BLOCKED` while any remain.
 *
 * Staleness: the plan hash covers the member's status and role, the exact slots
 * released and the exact answers deleted. The apply re-reads the verdict UNDER
 * the club write lock and refuses with `PLAN_STALE` and the fresh plan if it
 * differs, so a role the member claimed after the preview is never released
 * silently.
 *
 * Authorization: `audience: "officer"` through `authorizeToken` is the set
 * `requireClubRole(..., ["admin"])` admits in the app. `memberId` is looked up
 * inside the token's club, so another club's member is NOT_FOUND.
 */
import { z } from "zod";
import { db } from "#/db";
import { planHash } from "#/lib/mcp-plan";
import {
	applyMemberStanding,
	MemberStandingStaleError,
	type MemberStandingVerdict,
	memberStandingVerdict,
} from "#/server/members-logic";
import { authorizeToken } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

const TOOL = "set_member_standing";

const inputSchema = {
	clubId: z.string().uuid(),
	memberId: z.string().uuid().describe("The member, from find_people."),
	status: z
		.enum(["active", "inactive", "former"])
		.optional()
		.describe(
			"inactive: stood down for now, reversible. former: has left the club. Omit to leave it.",
		),
	clubRole: z
		.enum(["admin", "member"])
		.optional()
		.describe(
			"admin can edit the roster, meetings and settings. Omit to leave it.",
		),
	planHash: z
		.string()
		.optional()
		.describe(
			"Omit to preview. Pass the planHash a preview returned, with the same input, to apply it.",
		),
};

export const NOT_ON_ROSTER_MESSAGE =
	"That member is not on this club's roster. find_people lists who is.";
export const NOTHING_TO_SET_MESSAGE =
	"Pass at least one of status or clubRole.";
export const PLAN_STALE_MESSAGE =
	"The member changed since you previewed this. Review the fresh plan and ask the user again.";
export const ADMIN_POWER_NOTE =
	"This person will be able to edit the roster, meetings and club settings.";

interface Plan {
	memberId: string;
	name: string;
	status: { before: string; after: string };
	clubRole: { before: string; after: string };
	/** Fields whose value will not change, named so the caller sees them. */
	unchanged: ("status" | "clubRole")[];
	releasedRoles: {
		slotId: string;
		meetingId: string;
		meetingDate: string;
		role: string;
		/** The speech linked to this role is unlinked; it stays with its owner. */
		hasLinkedSpeech: boolean;
	}[];
	/** Open officer terms the End closes, by position. */
	closedOfficerTerms: string[];
	deletedPlanAnswers: {
		meetingId: string;
		meetingDate: string;
		status: string;
	}[];
	adminNote: string | null;
	blocking: { code: string; message: string }[];
}

function planOf(v: MemberStandingVerdict): Plan {
	const becomesAdmin = v.roleChanges && v.clubRole.after === "admin";
	return {
		memberId: v.member.id,
		name: v.member.name,
		status: v.status,
		clubRole: v.clubRole,
		unchanged: [
			...(v.statusChanges ? [] : (["status"] as const)),
			...(v.roleChanges ? [] : (["clubRole"] as const)),
		],
		releasedRoles: v.releasedRoles.map((r) => ({
			slotId: r.slotId,
			meetingId: r.meetingId,
			meetingDate: r.meetingDate.toISOString(),
			role: r.role,
			hasLinkedSpeech: r.hasLinkedSpeech,
		})),
		closedOfficerTerms: v.closedOfficerTerms,
		deletedPlanAnswers: v.deletedPlanAnswers.map((a) => ({
			meetingId: a.meetingId,
			meetingDate: a.meetingDate.toISOString(),
			status: a.status,
		})),
		adminNote: becomesAdmin ? ADMIN_POWER_NOTE : null,
		blocking: v.blocked,
	};
}

export const setMemberStandingTool: McpToolDefinition = {
	name: TOOL,
	audience: "officer",
	// It releases roles and deletes planned-attendance answers, and a second call
	// does not undo the first.
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
	},
	config: {
		title: "Change a member's status or club role",
		description:
			"Change one member's status (active, inactive, former) and/or club " +
			"role (admin, member), as a club admin would on the roster. Id from " +
			"find_people. inactive is the reversible way to stand someone down; " +
			"former is for someone who has left. Neither deletes the person. Going " +
			"inactive or former releases their upcoming roles; going former also " +
			"deletes their planned-attendance answers on meetings not yet completed " +
			"and closes their open officer terms. " +
			"Making someone an admin lets them edit the roster, meetings and club " +
			"settings. A club always keeps one active admin, and a former member " +
			"holds no role. Call once WITHOUT planHash to preview: it writes " +
			"nothing, lists each role released and answer deleted by meeting date, " +
			"names anything blocked, and returns a planHash. Show the plan to the " +
			"user in full; after they agree, call again with the same input plus " +
			"the planHash. GavelUp messages no one.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club, user } = await authorizeToken(ctx, args.clubId);
		if (args.status === undefined && args.clubRole === undefined) {
			throw new McpError("VALIDATION", NOTHING_TO_SET_MESSAGE);
		}
		const memberId = args.memberId.toLowerCase();
		const standing = {
			clubId: club.clubId,
			memberId,
			status: args.status,
			clubRole: args.clubRole,
		};

		const hashOf = (p: Plan) =>
			planHash({ tool: TOOL, clubId: club.clubId, userId: user.id, plan: p });
		const view = (p: Plan) => ({ clubId: club.clubId, ...p });

		const verdict = await memberStandingVerdict(db, standing);
		if (!verdict) throw new McpError("NOT_FOUND", NOT_ON_ROSTER_MESSAGE);
		const p = planOf(verdict);

		if (!args.planHash) {
			return { applied: false, plan: view(p), planHash: hashOf(p) };
		}
		if (hashOf(p) !== args.planHash) {
			throw new McpError("PLAN_STALE", PLAN_STALE_MESSAGE, {
				plan: view(p),
				planHash: hashOf(p),
			});
		}
		if (p.blocking.length > 0) {
			throw new McpError(
				"BLOCKED",
				`Nothing was changed — ${p.blocking.length} problem${p.blocking.length === 1 ? "" : "s"} to fix first.`,
				{ blocking: p.blocking },
			);
		}
		if (!verdict.statusChanges && !verdict.roleChanges) {
			return { applied: true, clubId: club.clubId, plan: view(p), changed: [] };
		}

		try {
			await applyMemberStanding(
				{ ...standing, actorMemberId: club.membershipId },
				{
					// Re-read under the club write lock: a role claimed, an answer
					// given or a status changed since the preview is a stale plan.
					assertFresh: (v) => v !== null && hashOf(planOf(v)) === args.planHash,
				},
			);
		} catch (e) {
			if (e instanceof MemberStandingStaleError) {
				const fresh = e.verdict ? planOf(e.verdict) : null;
				throw new McpError(
					fresh ? "PLAN_STALE" : "NOT_FOUND",
					fresh ? PLAN_STALE_MESSAGE : NOT_ON_ROSTER_MESSAGE,
					fresh ? { plan: view(fresh), planHash: hashOf(fresh) } : undefined,
				);
			}
			throw e;
		}
		return {
			applied: true,
			clubId: club.clubId,
			changed: [
				...(verdict.statusChanges ? (["status"] as const) : []),
				...(verdict.roleChanges ? (["clubRole"] as const) : []),
			],
			plan: view(p),
			note: "GavelUp tells no one. Let the member know yourself if they should hear of this.",
		};
	},
};
