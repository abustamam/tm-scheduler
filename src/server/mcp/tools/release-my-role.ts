/**
 * `release_my_role` — "I can't be Timer on the 14th, drop me" and "give my
 * Timer to Sam" through the member's own agent (#1568, child of #1560).
 *
 * `audience: "member"`. **Own role only** (maintainer decision, 2026-11-09): the
 * tool acts on a slot whose holder is the token owner's own membership
 * (`club.membershipId`) and on no other, whatever the input says. This is
 * narrower than the app, where `releaseSlot` / `reassignSlot` gate on a session
 * alone and any member may clear any role; it is the rule the other member
 * tools follow (#1283). Releasing or moving someone else's role stays with the
 * officer tool `assign_roles`.
 *
 * The writes are the app's own: `releaseSlotCore` (no `toMemberId`) and
 * `reassignSlotCore` (with it), both with `proof: "connector"` and the caller as
 * the actor. Preview, then apply with the `planHash`. The hash covers the chosen
 * slot, the holder of every slot the `role` matches and the recipient, so a
 * change of holder between the two answers `PLAN_STALE` with a fresh plan whose
 * blocking item says the caller no longer holds the role. The apply repeats the
 * holder check against the slot row it locks, before either core runs.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { members, roleDefinitions, roleSlots } from "#/db/schema";
import { planHash } from "#/lib/mcp-plan";
import { lockClubForWrite } from "#/server/club-write-lock";
import { lockMembershipsAgainstMerge } from "#/server/membership-merge-lock";
import {
	lockMemberForAssignment,
	reassignSlotCore,
	releaseSlotCore,
} from "#/server/slots-logic";
import { authorizeTokenForMeeting } from "../authz-logic";
import { McpError } from "../errors";
import {
	type DbOrTx,
	type LabelledSlot,
	loadLabelledSlots,
	loadMeetingFacts,
	type MemberBlockingItem,
	meetingStateBlocking,
	type Tx,
	throwIfLocked,
} from "../member-meeting";
import type { McpToolDefinition } from "../tool";
import { isoInTimezone } from "./get-my-schedule";

const TOOL = "release_my_role";

const inputSchema = {
	meetingId: z.string().uuid().describe("From get_my_schedule."),
	role: z
		.string()
		.trim()
		.min(1)
		.max(80)
		.describe('The role name, e.g. "Timer" or "Speaker 2".'),
	slotId: z
		.string()
		.uuid()
		.optional()
		.describe(
			"Only to pick one when you hold two slots with that role name; the preview lists them.",
		),
	toMemberId: z
		.string()
		.uuid()
		.optional()
		.describe(
			"Omit to release the role (it becomes open). Pass a member id from find_people to hand it to that member instead.",
		),
	planHash: z
		.string()
		.optional()
		.describe(
			"Omit to preview. Pass the planHash a preview returned, with the same input, to apply it.",
		),
};

const argsSchema = z.object(inputSchema);

interface Computed {
	plan: {
		meeting: {
			meetingId: string;
			clubName: string;
			startsAt: string;
			status: string;
		};
		slotLabel: string | null;
		action: "release" | "handoff";
		toMember: { memberId: string; name: string } | null;
		speech: string | null;
	};
	planHash: string;
	blocking: MemberBlockingItem[];
	slotId: string | null;
}

type Who = { clubId: string; userId: string; memberId: string };

async function compute(
	conn: DbOrTx,
	args: {
		meetingId: string;
		role: string;
		slotId?: string;
		toMemberId?: string;
	},
	who: Who,
): Promise<Computed> {
	const facts = await loadMeetingFacts(conn, args.meetingId);
	const slots = await loadLabelledSlots(conn, args.meetingId);
	const wanted = args.role.trim().toLowerCase();
	const matching: LabelledSlot[] = slots.filter(
		(s) =>
			s.label.toLowerCase() === wanted || s.roleName.toLowerCase() === wanted,
	);
	// Only slots the caller holds are ever candidates: `slotId` narrows among
	// them and cannot widen to someone else's.
	const held = matching.filter((s) => s.holderMemberId === who.memberId);

	const blocking = meetingStateBlocking(facts);
	let chosen: LabelledSlot | null = null;
	if (matching.length === 0) {
		blocking.push({
			code: "NO_SUCH_ROLE",
			message: `There is no "${args.role}" at that meeting.`,
		});
	} else if (held.length === 0) {
		blocking.push({
			code: "NOT_YOURS",
			message: `You don't hold "${args.role}" at that meeting. This tool only releases or hands off a role you hold; an officer can change someone else's.`,
		});
	} else if (args.slotId) {
		chosen = held.find((s) => s.slotId === args.slotId) ?? null;
		if (!chosen) {
			blocking.push({
				code: "NOT_YOURS",
				message: `You don't hold the slot ${args.slotId}. Your "${args.role}" slots: ${held
					.map((s) => `${s.label} (${s.slotId})`)
					.join(", ")}.`,
			});
		}
	} else if (held.length === 1) {
		chosen = held[0] ?? null;
	} else {
		blocking.push({
			code: "AMBIGUOUS_SLOT",
			message: `You hold more than one "${args.role}": ${held
				.map((s) => `${s.label} (${s.slotId})`)
				.join(", ")}. Ask which, then pass its slotId.`,
		});
	}

	let toMember: { memberId: string; name: string } | null = null;
	if (args.toMemberId) {
		const [target] = await conn
			.select({ id: members.id, name: members.name, status: members.status })
			.from(members)
			.where(
				and(eq(members.id, args.toMemberId), eq(members.clubId, who.clubId)),
			)
			.limit(1);
		if (target && target.status === "active") {
			toMember = { memberId: target.id, name: target.name };
		} else {
			blocking.push({
				code: "TARGET_NOT_ACTIVE",
				message:
					"That is not an active member of this club. Find the member with find_people.",
			});
		}
	}

	let speech: string | null = null;
	if (chosen) {
		const [row] = await conn
			.select({
				speechId: roleSlots.speechId,
				isSpeakerRole: roleDefinitions.isSpeakerRole,
			})
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.where(eq(roleSlots.id, chosen.slotId))
			.limit(1);
		if (row?.isSpeakerRole && row.speechId) {
			speech = args.toMemberId
				? "This slot has a speech attached. Handing the slot to another member unlinks it; the speech stays with you, unscheduled."
				: "This slot has a speech attached. Releasing unlinks it; the speech stays with you, unscheduled, and is not deleted.";
		}
	}

	const plan = {
		meeting: {
			meetingId: facts.meetingId,
			clubName: facts.clubName,
			startsAt: isoInTimezone(facts.scheduledAt, facts.timezone),
			status: facts.status,
		},
		slotLabel: chosen?.label ?? null,
		action: args.toMemberId ? ("handoff" as const) : ("release" as const),
		toMember,
		speech,
	};
	return {
		plan,
		planHash: planHash({
			tool: TOOL,
			clubId: who.clubId,
			userId: who.userId,
			plan: {
				...plan,
				state: {
					slotId: chosen?.slotId ?? null,
					toMemberId: args.toMemberId ?? null,
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

/** The holder, read from the slot row under its lock. */
async function lockedHolder(tx: Tx, slotId: string): Promise<string | null> {
	const [row] = await tx
		.select({ holder: roleSlots.assignedMemberId })
		.from(roleSlots)
		.where(eq(roleSlots.id, slotId))
		.limit(1)
		.for("update");
	return row?.holder ?? null;
}

export const releaseMyRoleTool: McpToolDefinition = {
	name: TOOL,
	audience: "member",
	// Clears the caller's own role (and unlinks a speaker slot's speech), or
	// moves it to another member. Not idempotent: a repeat finds the role gone.
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
	},
	config: {
		title: "Release or hand off my role",
		description:
			"Give up a role the CALLER holds at one meeting: release it (it becomes " +
			"open) or hand it to another member with toMemberId. Only the caller's own " +
			"role; it takes no member id for the holder, and an officer uses assign_roles " +
			"for anyone else's. Call get_my_schedule first to find the meetingId. Call " +
			"once WITHOUT planHash to preview (it names the role, who gets it, and what " +
			"happens to a speech), show it to the user, and only after they agree call " +
			"again with the same input plus the planHash. If the caller holds two slots " +
			"of that role the preview lists them with their ids: ask which and pass slotId.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = argsSchema.parse(input);
		const { club, user } = await authorizeTokenForMeeting(ctx, args.meetingId);
		const who: Who = {
			clubId: club.clubId,
			userId: user.id,
			memberId: club.membershipId,
		};
		if (args.toMemberId === who.memberId) {
			throw new McpError(
				"VALIDATION",
				"toMemberId is you: that would change nothing. Omit it to release the role.",
			);
		}

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
				throw new McpError("BLOCKED", first?.message ?? "Nothing to release.", {
					blocking: c.blocking,
				});
			}
			// The cores' own lock order: recipient first, then the slot row.
			if (args.toMemberId) {
				await lockMembershipsAgainstMerge(tx, [args.toMemberId]);
				await lockMemberForAssignment(tx, args.toMemberId);
			}
			// From the locked row, not the read above: only the caller's own role.
			if ((await lockedHolder(tx, c.slotId)) !== who.memberId) {
				throw new McpError("BLOCKED", "You no longer hold that role.", {
					blocking: [
						{
							code: "NOT_YOURS",
							message: "You no longer hold that role.",
						},
					],
				});
			}
			if (args.toMemberId) {
				await reassignSlotCore(tx, {
					slotId: c.slotId,
					memberId: args.toMemberId,
					actorMemberId: who.memberId,
					proof: "connector",
				});
				return { handedOff: c.plan.slotLabel, to: c.plan.toMember };
			}
			await releaseSlotCore(tx, {
				slotId: c.slotId,
				actorMemberId: who.memberId,
				proof: "connector",
			});
			return { released: c.plan.slotLabel };
		});
	},
};
