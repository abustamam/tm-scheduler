/**
 * `set_attendance` — an officer marks ANOTHER member coming / not coming through
 * their agent (#1303). The officer-side sibling of `set_my_attendance` (#1283).
 *
 * `audience: "officer"`: `authorizeTokenForMeeting` refuses a plain member of the
 * meeting's club with the same not-an-officer answer as every officer tool, so a
 * member token never reaches the writes. The authorization is the token owner's
 * standing in THIS meeting's club (`club.via`, an admin or an open office, the
 * app's effective admin), never a Toastmaster arm, and it travels into the
 * writers as the distinct officer-connector path (`connectorOfficerActor`,
 * `connectorStanding`) rather than by loosening the self-only connector path.
 * The subject is a `memberId` that must be an ACTIVE member of that same club.
 *
 * Preview, then apply with the `planHash`; the apply recomputes it INSIDE a
 * transaction under the club write lock, so a slot given to the subject in
 * between is `PLAN_STALE` and nothing is freed unseen.
 *
 * `not_coming` frees every role the member holds, exactly the app's release,
 * credited to the officer with `via: "connector"` and the subject as
 * `fromMemberId`. GavelUp tells NO ONE: the result lists what was freed so the
 * officer can find cover, and a human sends any message.
 */
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { members, officerTerms, people } from "#/db/schema";
import { assertMeetingAccepts } from "#/lib/meeting-lifecycle";
import type { ConnectorOfficerActor } from "#/lib/write-proof";
import { setPlanStatus } from "#/server/attendance-plan-logic";
import {
	connectorOfficerActor,
	releaseSlotsAndMarkUnavailable,
} from "#/server/availability-logic";
import { lockMembershipsAgainstMerge } from "#/server/membership-merge-lock";
import {
	authorizeTokenForMeeting,
	NOT_OFFICER_MESSAGE,
	type TokenClub,
} from "../authz-logic";
import { McpError } from "../errors";
import {
	attendancePlanHash,
	type DbOrTx,
	isAlreadyStatus,
	loadMeetingFacts,
	loadMemberAttendanceState,
	type MemberBlockingItem,
	meetingPlanHeader,
	meetingStateBlocking,
	runAttendanceTool,
	type Tx,
} from "../member-meeting";
import type { McpToolDefinition } from "../tool";

const TOOL = "set_attendance";

const inputSchema = {
	meetingId: z.string().uuid().describe("From list_meetings."),
	memberId: z
		.string()
		.uuid()
		.describe("The member to mark, from find_people. Never the caller's id."),
	status: z.enum(["coming", "not_coming"]),
	planHash: z
		.string()
		.optional()
		.describe(
			"Omit to preview. Pass the planHash a preview returned, with the same input, to apply it.",
		),
};

interface Who {
	clubId: string;
	userId: string;
	/** The officer's own membership: the credited actor. */
	actorMemberId: string;
}

interface Computed {
	plan: {
		meeting: ReturnType<typeof meetingPlanHeader>;
		member: { memberId: string; name: string | null };
		status: "coming" | "not_coming";
		rolesToFree: string[];
		warning: string | null;
	};
	planHash: string;
	blocking: MemberBlockingItem[];
	heldSlotIds: string[];
}

async function compute(
	conn: DbOrTx,
	args: {
		meetingId: string;
		memberId: string;
		status: "coming" | "not_coming";
	},
	who: Who,
): Promise<Computed> {
	const facts = await loadMeetingFacts(conn, args.meetingId);
	const [subject] = await conn
		.select({ id: members.id, name: members.name })
		.from(members)
		.where(
			and(
				eq(members.id, args.memberId),
				eq(members.clubId, who.clubId),
				eq(members.status, "active"),
			),
		)
		.limit(1);
	const blocking = meetingStateBlocking(facts);
	if (!subject) {
		blocking.unshift({
			code: "NOT_A_MEMBER",
			message:
				"That person is not an active member of this club. find_people lists who is.",
		});
	}
	// Every id from here on is the `members.id` the query returned, never the
	// request's spelling of it: the JS comparison in `loadMemberAttendanceState`
	// and the text-keyed locks are case-sensitive where the SQL match is not.
	const state = subject
		? await loadMemberAttendanceState(conn, {
				meetingId: facts.meetingId,
				memberId: subject.id,
			})
		: { held: [], heldSlotIds: [], planStatus: null, unavailable: false };
	const rolesToFree =
		args.status === "not_coming" ? state.held.map((s) => s.label) : [];
	if (subject && isAlreadyStatus(args.status, state) && blocking.length === 0) {
		blocking.push({
			code: "ALREADY_THAT_STATUS",
			message: `${subject.name} is already down as ${args.status === "coming" ? "coming" : "not coming"} to that meeting.`,
		});
	}

	const plan = {
		meeting: meetingPlanHeader(facts),
		member: {
			memberId: subject?.id ?? args.memberId,
			name: subject?.name ?? null,
		},
		status: args.status,
		rolesToFree,
		warning:
			rolesToFree.length > 0
				? `Confirming frees ${subject?.name ?? "this member"}'s roles: ${rolesToFree.join(", ")}. They will need cover.`
				: null,
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
	};
}

/**
 * The officer's standing in this club RIGHT NOW, read through the apply's own
 * transaction after the club write lock: the same rule `memberClubsForUser`
 * gives the token (an active membership, then a stored admin role or an open
 * officer term). The preview-time `club.via` is a snapshot, and a demotion
 * between the preview and the apply must not be honoured.
 */
async function standingNow(tx: Tx, who: Who): Promise<TokenClub["via"] | null> {
	const rows = await tx
		.select({
			clubRole: members.clubRole,
			officerTermId: officerTerms.id,
		})
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.leftJoin(
			officerTerms,
			and(
				eq(officerTerms.membershipId, members.id),
				isNull(officerTerms.termEnd),
			),
		)
		.where(
			and(
				eq(members.id, who.actorMemberId),
				eq(members.clubId, who.clubId),
				eq(members.status, "active"),
				eq(people.userId, who.userId),
			),
		);
	if (rows.length === 0) return null;
	if (rows.some((r) => r.clubRole === "admin")) return "admin";
	return rows.some((r) => r.officerTermId !== null) ? "officer" : "member";
}

export const setAttendanceTool: McpToolDefinition = {
	name: TOOL,
	audience: "officer",
	config: {
		title: "Set a member's attendance",
		description:
			"Mark ANOTHER member coming or not coming to one meeting, as a club " +
			"admin would in the app. Find the memberId with find_people and the " +
			"meetingId with list_meetings; ask the user which when more than one " +
			"matches. Call once WITHOUT planHash to preview (rolesToFree lists every " +
			"role the member holds, which confirming frees), show it to the user in " +
			"full, and only after they agree call again with the same input plus the " +
			"planHash. GavelUp tells NO ONE: a freed role needs cover, and the user " +
			"must tell the member and the Toastmaster or VPE themselves.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		// A uuid is case-insensitive to the schema and to SQL, not to the text-keyed
		// locks or a JS comparison. So the request's spelling is only ever an
		// argument to SQL: every id a write or a comparison uses comes back from
		// the database (`facts.meetingId`, `subject.id`).
		const { meetingId, memberId } = args;
		const { club, user } = await authorizeTokenForMeeting(ctx, meetingId);
		const who: Who = {
			clubId: club.clubId,
			userId: user.id,
			actorMemberId: club.membershipId,
		};
		// The distinct officer-connector path, resolved up front so a non-admin is
		// refused before anything is read about the subject.
		connectorOfficerActor(club.via, who.actorMemberId);
		if (memberId.toLowerCase() === who.actorMemberId) {
			throw new McpError(
				"BLOCKED",
				"That is your own membership. Use set_my_attendance to change your own attendance.",
			);
		}
		const a = { meetingId, memberId, status: args.status };
		let officer: ConnectorOfficerActor | undefined;

		return runAttendanceTool({
			planHash: args.planHash,
			meetingId,
			clubId: who.clubId,
			compute: (conn) => compute(conn, a, who),
			// After the club lock: the standing the apply rests on is read again, so a
			// token whose owner was demoted since the preview writes nothing.
			underLock: async (tx) => {
				const standing = await standingNow(tx, who);
				if (!standing || standing === "member") {
					throw new McpError("FORBIDDEN", NOT_OFFICER_MESSAGE);
				}
				officer = connectorOfficerActor(standing, who.actorMemberId);
			},
			apply: async (tx, c, facts) => {
				if (!officer) throw new McpError("FORBIDDEN", NOT_OFFICER_MESSAGE);
				if (args.status === "coming") {
					assertMeetingAccepts(facts.status, "plan");
					await lockMembershipsAgainstMerge(tx, [c.plan.member.memberId]);
					await setPlanStatus(tx, {
						memberId: c.plan.member.memberId,
						meetingId: facts.meetingId,
						clubId: who.clubId,
						status: "coming",
						actorMemberId: officer.actorMemberId,
						via: "connector",
						grantedVia: officer.via,
						proof: officer.proof,
						connectorOfficer: officer,
					});
					return { released: [], note: null };
				}

				const { releasedSlots } = await releaseSlotsAndMarkUnavailable(tx, {
					memberId: c.plan.member.memberId,
					claimedActorMemberId: officer.actorMemberId,
					meetingId: facts.meetingId,
					clubId: who.clubId,
					via: "connector",
					proof: "connector",
					connectorOfficer: officer,
					expectedHeldSlotIds: c.heldSlotIds,
				});
				const released = releasedSlots.map((s) => s.label);
				return {
					released,
					note:
						released.length > 0
							? "Roles freed. GavelUp tells no one: find cover and tell the member and the Toastmaster or VPE yourself."
							: null,
				};
			},
		});
	},
};
