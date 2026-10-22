/**
 * `set_my_attendance` — "I'm not coming" / "put me down as coming" through the
 * member's own agent (#1283, #985 part 2).
 *
 * `audience: "member"`. WHO is acting comes from the credential alone: the
 * subject is `authorizeTokenForMeeting(ctx, meetingId).club.membershipId`, and
 * the input has no member, person or club id, so there is no argument a caller
 * could change to write somebody else's answer. The writes carry
 * `proof: "connector"`, which the seams accept only where actor === subject
 * (`isConnectorSelf`).
 *
 * Preview, then apply with the `planHash`. The hash covers the STATE the apply
 * depends on (which slots the member holds, their current answer), and the apply
 * recomputes it INSIDE a transaction under the club write lock: another member
 * claiming or releasing in between is `PLAN_STALE`, and nothing is written.
 *
 * `not_coming` does exactly what the app's "Can't make it" does
 * (`releaseSlotsAndMarkUnavailable`): frees every role the member holds and
 * records the answer. GavelUp tells NO ONE, so the result carries the duty
 * sentence and a drafted message the member sends themselves.
 */
import { z } from "zod";
import { db } from "#/db";
import { listRoles } from "#/lib/list-roles";
import { planHash } from "#/lib/mcp-plan";
import { assertMeetingAccepts } from "#/lib/meeting-lifecycle";
import { roleFreedDutyText } from "#/lib/role-duty-copy";
import {
	getPlanStatus,
	isMemberUnavailable,
	setPlanStatus,
} from "#/server/attendance-plan-logic";
import { releaseSlotsAndMarkUnavailable } from "#/server/availability-logic";
import { lockClubForWrite } from "#/server/club-write-lock";
import { loadTmodMemberId } from "#/server/meeting-authz-logic";
import { authorizeTokenForMeeting } from "../authz-logic";
import { McpError } from "../errors";
import {
	type DbOrTx,
	loadLabelledSlots,
	loadMeetingFacts,
	type MemberBlockingItem,
	meetingDayLabel,
	meetingStateBlocking,
	memberFirstName,
	throwIfLocked,
} from "../member-meeting";
import type { McpToolDefinition } from "../tool";
import { isoInTimezone } from "./get-my-schedule";

const TOOL = "set_my_attendance";

const inputSchema = {
	meetingId: z.string().uuid().describe("From get_my_schedule."),
	status: z.enum(["coming", "not_coming"]),
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
		status: "coming" | "not_coming";
		rolesToFree: string[];
	};
	planHash: string;
	blocking: MemberBlockingItem[];
	heldSlotIds: string[];
	heldLabels: string[];
	dayLabel: string;
	clubId: string;
	status: string;
}

async function compute(
	conn: DbOrTx,
	args: { meetingId: string; status: "coming" | "not_coming" },
	who: { clubId: string; userId: string; memberId: string },
): Promise<Computed> {
	const facts = await loadMeetingFacts(conn, args.meetingId);
	const slots = await loadLabelledSlots(conn, args.meetingId);
	const held = slots.filter((s) => s.holderMemberId === who.memberId);
	const planStatus = await getPlanStatus(conn, {
		memberId: who.memberId,
		meetingId: args.meetingId,
	});
	const unavailable = await isMemberUnavailable(conn, {
		memberId: who.memberId,
		meetingId: args.meetingId,
	});
	const rolesToFree =
		args.status === "not_coming" ? held.map((s) => s.label) : [];

	const blocking = meetingStateBlocking(facts);
	const already =
		args.status === "coming"
			? planStatus === "coming" && !unavailable
			: unavailable && held.length === 0;
	if (already && blocking.length === 0) {
		blocking.push({
			code: "ALREADY_THAT_STATUS",
			message:
				args.status === "coming"
					? "You're already down as coming to that meeting."
					: "You're already down as not coming to that meeting.",
		});
	}

	const plan = {
		meeting: {
			meetingId: facts.meetingId,
			clubName: facts.clubName,
			startsAt: isoInTimezone(facts.scheduledAt, facts.timezone),
			status: facts.status,
		},
		status: args.status,
		rolesToFree,
	};
	const heldSlotIds = held.map((s) => s.slotId).sort();
	return {
		plan,
		planHash: planHash({
			tool: TOOL,
			clubId: who.clubId,
			userId: who.userId,
			plan: {
				...plan,
				state: { heldSlotIds, planStatus, unavailable },
			},
		}),
		blocking,
		heldSlotIds,
		heldLabels: held.map((s) => s.label),
		dayLabel: meetingDayLabel(facts.scheduledAt, facts.timezone),
		clubId: facts.clubId,
		status: facts.status,
	};
}

export const setMyAttendanceTool: McpToolDefinition = {
	name: TOOL,
	audience: "member",
	config: {
		title: "Set my attendance",
		description:
			"Tell the club whether the caller is coming to one meeting: the same as " +
			'the app\'s "Can\'t make it" (not_coming) or "I\'m coming". Always the ' +
			"person this token belongs to; it takes no member id. Call " +
			"get_my_schedule first to find the meetingId, and ask the user which " +
			"meeting when more than one meeting or club matches. Call once WITHOUT " +
			"planHash to preview (rolesToFree lists the roles that would be freed), " +
			"show it to the user, and only after they agree call again with the same " +
			"input plus the planHash. not_coming frees every role they hold. " +
			"GavelUp tells NO ONE: the result has a dutyText and a draftMessage, and " +
			"the user must tell the Toastmaster or VPE themselves. GavelUp never " +
			"sends the draft.",
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
			if (first)
				throw new McpError("BLOCKED", first.message, { blocking: c.blocking });

			if (args.status === "coming") {
				// The plan write class by name, ahead of the plan seam (#1135):
				// `setPlanStatus` accepts a completed meeting and leaves it to its
				// callers. `throwIfLocked` above is the tool's `LOCKED` answer; this is
				// the refusal `meeting-writers.guard.test.ts` reads.
				assertMeetingAccepts(facts.status, "plan");
				// Overwrites a `not_coming` (the plan row IS the unavailability mark),
				// so a later claim_open_role is not blocked by NOT_COMING.
				await setPlanStatus(tx, {
					memberId: who.memberId,
					meetingId: args.meetingId,
					clubId: who.clubId,
					status: "coming",
					actorMemberId: who.memberId,
					via: "connector",
					grantedVia: "self",
					proof: "connector",
				});
				return { released: [], dutyText: null, draftMessage: null };
			}

			const { releasedSlots } = await releaseSlotsAndMarkUnavailable(db, {
				memberId: who.memberId,
				claimedActorMemberId: who.memberId,
				meetingId: args.meetingId,
				clubId: who.clubId,
				via: "connector",
				proof: "connector",
			});
			const released = releasedSlots.map((s) => s.label);
			if (released.length === 0) {
				return { released, dutyText: null, draftMessage: null };
			}
			const tmodId = await loadTmodMemberId(args.meetingId, tx);
			const tmodFirst =
				tmodId && tmodId !== who.memberId
					? await memberFirstName(tx, tmodId)
					: null;
			return {
				released,
				dutyText: roleFreedDutyText(released.length),
				draftMessage: `Hi ${tmodFirst ?? "VPE"}, I can't make the ${c.dayLabel} meeting, so I've freed ${listRoles(released)}. Could you help find cover?`,
			};
		});
	},
};
