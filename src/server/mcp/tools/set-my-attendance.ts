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
import { listRoles } from "#/lib/list-roles";
import { assertMeetingAccepts } from "#/lib/meeting-lifecycle";
import { roleFreedDutyText } from "#/lib/role-duty-copy";
import { setPlanStatus } from "#/server/attendance-plan-logic";
import { releaseSlotsAndMarkUnavailable } from "#/server/availability-logic";
import { loadTmodMemberId } from "#/server/meeting-authz-logic";
import { authorizeTokenForMeeting } from "../authz-logic";
import {
	attendancePlanHash,
	type DbOrTx,
	isAlreadyStatus,
	loadMeetingFacts,
	loadMemberAttendanceState,
	type MemberBlockingItem,
	meetingDayLabel,
	meetingPlanHeader,
	meetingStateBlocking,
	memberFirstName,
	runAttendanceTool,
} from "../member-meeting";
import type { McpToolDefinition } from "../tool";

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
		meeting: ReturnType<typeof meetingPlanHeader>;
		status: "coming" | "not_coming";
		rolesToFree: string[];
	};
	planHash: string;
	blocking: MemberBlockingItem[];
	heldSlotIds: string[];
	dayLabel: string;
}

async function compute(
	conn: DbOrTx,
	args: { meetingId: string; status: "coming" | "not_coming" },
	who: { clubId: string; userId: string; memberId: string },
): Promise<Computed> {
	const facts = await loadMeetingFacts(conn, args.meetingId);
	const state = await loadMemberAttendanceState(conn, {
		meetingId: facts.meetingId,
		memberId: who.memberId,
	});
	const rolesToFree =
		args.status === "not_coming" ? state.held.map((s) => s.label) : [];

	const blocking = meetingStateBlocking(facts);
	if (isAlreadyStatus(args.status, state) && blocking.length === 0) {
		blocking.push({
			code: "ALREADY_THAT_STATUS",
			message:
				args.status === "coming"
					? "You're already down as coming to that meeting."
					: "You're already down as not coming to that meeting.",
		});
	}

	const plan = {
		meeting: meetingPlanHeader(facts),
		status: args.status,
		rolesToFree,
	};
	return {
		plan,
		planHash: attendancePlanHash({
			tool: TOOL,
			clubId: who.clubId,
			userId: who.userId,
			plan,
			state,
		}),
		blocking,
		heldSlotIds: state.heldSlotIds,
		dayLabel: meetingDayLabel(facts.scheduledAt, facts.timezone),
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
		// A uuid is case-insensitive to the schema and to SQL, but not to the
		// text-keyed locks: the request's spelling is only ever an argument to SQL,
		// and the writes use `facts.meetingId`, read from the database. The subject
		// is the token's own membership id, also read from the database.
		const { meetingId } = args;
		const { club, user } = await authorizeTokenForMeeting(ctx, meetingId);
		const who = {
			clubId: club.clubId,
			userId: user.id,
			memberId: club.membershipId,
		};
		const a = { meetingId, status: args.status };

		return runAttendanceTool({
			planHash: args.planHash,
			meetingId,
			clubId: who.clubId,
			compute: (conn) => compute(conn, a, who),
			apply: async (tx, c, facts) => {
				if (args.status === "coming") {
					// The plan write class by name, ahead of the plan seam (#1135):
					// `setPlanStatus` accepts a completed meeting and leaves it to its
					// callers. `throwIfLocked` is the tool's `LOCKED` answer; this is
					// the refusal `meeting-writers.guard.test.ts` reads.
					assertMeetingAccepts(facts.status, "plan");
					// Overwrites a `not_coming` (the plan row IS the unavailability mark),
					// so a later claim_open_role is not blocked by NOT_COMING.
					await setPlanStatus(tx, {
						memberId: who.memberId,
						meetingId: facts.meetingId,
						clubId: who.clubId,
						status: "coming",
						actorMemberId: who.memberId,
						via: "connector",
						grantedVia: "self",
						proof: "connector",
					});
					return { released: [], dutyText: null, draftMessage: null };
				}

				// On `tx`, not `db`: the release nests as a savepoint of THIS transaction,
				// so it shares the checked connection, commits or rolls back with the
				// answer, and re-checks the previewed held set under the attendance lock
				// (a slot assigned after the hash check is PLAN_STALE, never freed unseen).
				const { releasedSlots } = await releaseSlotsAndMarkUnavailable(tx, {
					memberId: who.memberId,
					claimedActorMemberId: who.memberId,
					meetingId: facts.meetingId,
					clubId: who.clubId,
					via: "connector",
					proof: "connector",
					expectedHeldSlotIds: c.heldSlotIds,
				});
				const released = releasedSlots.map((s) => s.label);
				if (released.length === 0) {
					return { released, dutyText: null, draftMessage: null };
				}
				const tmodId = await loadTmodMemberId(facts.meetingId, tx);
				const tmodFirst =
					tmodId && tmodId !== who.memberId
						? await memberFirstName(tx, tmodId)
						: null;
				return {
					released,
					dutyText: roleFreedDutyText(released.length),
					draftMessage: `Hi ${tmodFirst ?? "VPE"}, I can't make the ${c.dayLabel} meeting, so I've freed ${listRoles(released)}. Could you help find cover?`,
				};
			},
		});
	},
};
