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
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { members } from "#/db/schema";
import { planHash } from "#/lib/mcp-plan";
import { assertMeetingAccepts } from "#/lib/meeting-lifecycle";
import {
	getPlanStatus,
	isMemberUnavailable,
	setPlanStatus,
} from "#/server/attendance-plan-logic";
import {
	connectorOfficerActor,
	HeldSlotsChangedError,
	releaseSlotsAndMarkUnavailable,
} from "#/server/availability-logic";
import { lockClubForWrite } from "#/server/club-write-lock";
import { lockMembershipsAgainstMerge } from "#/server/membership-merge-lock";
import { authorizeTokenForMeeting } from "../authz-logic";
import { McpError } from "../errors";
import {
	type DbOrTx,
	loadLabelledSlots,
	loadMeetingFacts,
	type MemberBlockingItem,
	meetingStateBlocking,
	throwIfLocked,
} from "../member-meeting";
import type { McpToolDefinition } from "../tool";
import { isoInTimezone } from "./get-my-schedule";

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

type Standing = "admin" | "officer" | "member";

interface Who {
	clubId: string;
	userId: string;
	/** The officer's own membership: the credited actor. */
	actorMemberId: string;
	standing: Standing;
}

interface Computed {
	plan: {
		meeting: {
			meetingId: string;
			clubName: string;
			startsAt: string;
			status: string;
		};
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
		.select({ name: members.name })
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
	const slots = await loadLabelledSlots(conn, args.meetingId);
	const held = subject
		? slots.filter((s) => s.holderMemberId === args.memberId)
		: [];
	const planStatus = subject
		? await getPlanStatus(conn, {
				memberId: args.memberId,
				meetingId: args.meetingId,
			})
		: null;
	const unavailable = subject
		? await isMemberUnavailable(conn, {
				memberId: args.memberId,
				meetingId: args.meetingId,
			})
		: false;
	const rolesToFree =
		args.status === "not_coming" ? held.map((s) => s.label) : [];

	const already =
		args.status === "coming"
			? planStatus === "coming" && !unavailable
			: unavailable && held.length === 0;
	if (subject && already && blocking.length === 0) {
		blocking.push({
			code: "ALREADY_THAT_STATUS",
			message: `${subject.name} is already down as ${args.status === "coming" ? "coming" : "not coming"} to that meeting.`,
		});
	}

	const plan = {
		meeting: {
			meetingId: facts.meetingId,
			clubName: facts.clubName,
			startsAt: isoInTimezone(facts.scheduledAt, facts.timezone),
			status: facts.status,
		},
		member: { memberId: args.memberId, name: subject?.name ?? null },
		status: args.status,
		rolesToFree,
		warning:
			rolesToFree.length > 0
				? `Confirming frees ${subject?.name ?? "this member"}'s roles: ${rolesToFree.join(", ")}. They will need cover.`
				: null,
	};
	const heldSlotIds = held.map((s) => s.slotId).sort();
	return {
		plan,
		planHash: planHash({
			tool: TOOL,
			clubId: who.clubId,
			userId: who.userId,
			plan: { ...plan, state: { heldSlotIds, planStatus, unavailable } },
		}),
		blocking,
		heldSlotIds,
	};
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
		const { club, user } = await authorizeTokenForMeeting(ctx, args.meetingId);
		const who: Who = {
			clubId: club.clubId,
			userId: user.id,
			actorMemberId: club.membershipId,
			standing: club.via,
		};
		// The distinct officer-connector path, resolved up front so a non-admin is
		// refused before anything is read about the subject.
		connectorOfficerActor(who.standing, who.actorMemberId);

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
				assertMeetingAccepts(facts.status, "plan");
				await lockMembershipsAgainstMerge(tx, [args.memberId]);
				await setPlanStatus(tx, {
					memberId: args.memberId,
					meetingId: args.meetingId,
					clubId: who.clubId,
					status: "coming",
					actorMemberId: who.actorMemberId,
					via: "connector",
					grantedVia: "officer",
					proof: "connector",
				});
				return { released: [], note: null };
			}

			let releasedSlots: Awaited<
				ReturnType<typeof releaseSlotsAndMarkUnavailable>
			>["releasedSlots"];
			try {
				({ releasedSlots } = await releaseSlotsAndMarkUnavailable(tx, {
					memberId: args.memberId,
					claimedActorMemberId: who.actorMemberId,
					meetingId: args.meetingId,
					clubId: who.clubId,
					via: "connector",
					proof: "connector",
					connectorStanding: who.standing,
					expectedHeldSlotIds: c.heldSlotIds,
				}));
			} catch (e) {
				if (!(e instanceof HeldSlotsChangedError)) throw e;
				const fresh = await compute(tx, args, who);
				throw new McpError(
					"PLAN_STALE",
					"That meeting changed since you previewed it. Review the fresh plan and ask the user again.",
					{
						plan: fresh.plan,
						planHash: fresh.planHash,
						blocking: fresh.blocking,
					},
				);
			}
			const released = releasedSlots.map((s) => s.label);
			return {
				released,
				note:
					released.length > 0
						? "Roles freed. GavelUp tells no one: find cover and tell the member and the Toastmaster or VPE yourself."
						: null,
			};
		});
	},
};
