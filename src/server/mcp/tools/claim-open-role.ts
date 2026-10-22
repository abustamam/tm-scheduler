/**
 * `claim_open_role` — "put me down for Table Topics" through the member's own
 * agent (#1283, #985 part 2).
 *
 * `audience: "member"`. The claimant is the token owner's own membership in the
 * meeting's club (`authorizeTokenForMeeting`); the input has no member id. The
 * claim carries `proof: "connector"`, which `claimSlotCore` treats as a proven
 * self-claim: none of the rules that restrict an `asserted` caller apply.
 *
 * Preview, then apply with the `planHash`. The hash covers the chosen slot AND
 * the holder of every slot the `role` matches, so another member taking any of
 * them changes it; the apply recomputes inside a transaction under the club
 * write lock and answers `PLAN_STALE` with nothing written. Speech details are
 * not taken: the speaker sets them in the app.
 */
import { z } from "zod";
import { db } from "#/db";
import { planHash } from "#/lib/mcp-plan";
import { isMemberUnavailable } from "#/server/attendance-plan-logic";
import { lockClubForWrite } from "#/server/club-write-lock";
import { claimSlotCore } from "#/server/slots-logic";
import { authorizeTokenForMeeting } from "../authz-logic";
import { McpError } from "../errors";
import {
	type DbOrTx,
	type LabelledSlot,
	loadLabelledSlots,
	loadMeetingFacts,
	type MemberBlockingItem,
	meetingStateBlocking,
	throwIfLocked,
} from "../member-meeting";
import type { McpToolDefinition } from "../tool";
import { isoInTimezone } from "./get-my-schedule";

const TOOL = "claim_open_role";

const inputSchema = {
	meetingId: z.string().uuid().describe("From get_my_schedule."),
	role: z
		.string()
		.trim()
		.min(1)
		.max(80)
		.describe('The role name, e.g. "Table Topics Master" or "Speaker 2".'),
	planHash: z
		.string()
		.optional()
		.describe(
			"Omit to preview. Pass the planHash a preview returned, with the same input, to apply it.",
		),
};

interface Computed {
	plan: {
		meeting: {
			meetingId: string;
			clubName: string;
			startsAt: string;
			status: string;
		};
		slotLabel: string | null;
		alsoOpen: string[];
	};
	planHash: string;
	blocking: MemberBlockingItem[];
	slotId: string | null;
}

async function compute(
	conn: DbOrTx,
	args: { meetingId: string; role: string },
	who: { clubId: string; userId: string; memberId: string },
): Promise<Computed> {
	const facts = await loadMeetingFacts(conn, args.meetingId);
	const slots = await loadLabelledSlots(conn, args.meetingId);
	const wanted = args.role.trim().toLowerCase();
	const matching: LabelledSlot[] = slots.filter(
		(s) =>
			s.label.toLowerCase() === wanted || s.roleName.toLowerCase() === wanted,
	);
	const open = matching.filter((s) => s.status === "open");
	const chosen = open[0] ?? null;

	const blocking = meetingStateBlocking(facts);
	if (!chosen) {
		const openLabels = slots
			.filter((s) => s.status === "open")
			.map((s) => s.label);
		blocking.push({
			code: "NO_OPEN_SLOT",
			message: `There is no open "${args.role}" at that meeting. ${
				openLabels.length > 0
					? `Open roles: ${openLabels.join(", ")}.`
					: "Every role is taken."
			}`,
		});
	}
	if (
		await isMemberUnavailable(conn, {
			memberId: who.memberId,
			meetingId: args.meetingId,
		})
	) {
		blocking.push({
			code: "NOT_COMING",
			message:
				"You've said you can't make this meeting; say you're coming first (set_my_attendance).",
		});
	}

	const plan = {
		meeting: {
			meetingId: facts.meetingId,
			clubName: facts.clubName,
			startsAt: isoInTimezone(facts.scheduledAt, facts.timezone),
			status: facts.status,
		},
		slotLabel: chosen?.label ?? null,
		alsoOpen: open.slice(1).map((s) => s.label),
	};
	return {
		plan,
		planHash: planHash({
			tool: TOOL,
			clubId: who.clubId,
			userId: who.userId,
			plan: {
				...plan,
				status: "claim",
				state: {
					slotId: chosen?.slotId ?? null,
					matching: matching
						.map((s) => ({
							slotId: s.slotId,
							holderMemberId: s.holderMemberId,
						}))
						.sort((a, b) => a.slotId.localeCompare(b.slotId)),
				},
			},
		}),
		blocking,
		slotId: chosen?.slotId ?? null,
	};
}

export const claimOpenRoleTool: McpToolDefinition = {
	name: TOOL,
	audience: "member",
	config: {
		title: "Claim an open role",
		description:
			"Put the caller down for an OPEN role at one meeting. Always the person " +
			"this token belongs to; it takes no member id. Call get_my_schedule first " +
			"to find the meetingId, and ask the user which meeting when more than one " +
			"matches. Call once WITHOUT planHash to preview (it names the slot and " +
			"lists any alsoOpen slots of the same role), show it to the user, and only " +
			"after they agree call again with the same input plus the planHash. Speech " +
			"details are not taken here: the speaker sets them in the app.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club, user } = await authorizeTokenForMeeting(ctx, args.meetingId);
		const who = {
			clubId: club.clubId,
			userId: user.id,
			memberId: club.membershipId,
		};

		if (!args.planHash) {
			const c = await compute(db, args, who);
			return { plan: c.plan, planHash: c.planHash, blocking: c.blocking };
		}
		const hash = args.planHash;

		return db.transaction(async (tx) => {
			await lockClubForWrite(tx, who.clubId);
			const facts = await loadMeetingFacts(tx, args.meetingId);
			throwIfLocked(facts);
			const c = await compute(tx, args, who);
			if (c.planHash !== hash) {
				throw new McpError(
					"PLAN_STALE",
					"That meeting changed since you previewed it. Review the fresh plan and ask the user again.",
					{ plan: c.plan, planHash: c.planHash, blocking: c.blocking },
				);
			}
			const first = c.blocking[0];
			if (first || !c.slotId || !c.plan.slotLabel) {
				throw new McpError("BLOCKED", first?.message ?? "Nothing to claim.", {
					blocking: c.blocking,
				});
			}
			await claimSlotCore(tx, {
				slotId: c.slotId,
				memberId: who.memberId,
				actorMemberId: who.memberId,
				proof: "connector",
			});
			return { claimed: c.plan.slotLabel };
		});
	},
};
