/**
 * `request_cover` — a member asks for cover on their OWN role through their own
 * agent (#1569, ADR-0028). One tool for the three cover writes: `release` (the
 * slot reopens and a cover request is written), `undo` (take the role back) and
 * `ask` (a dropped role becomes "finding cover").
 *
 * `audience: "member"`. The caller is the token owner's membership in the
 * meeting's club (`authorizeTokenForMeeting`); the input has no member id. The
 * cores in `cover-logic.ts` trust `actorMemberId`, so THIS tool is the gate: it
 * passes only the token's own membership.
 *
 * The tool sends nothing to anyone: the member tells people themselves (humans
 * send every message). It imports no mail module.
 */
import { and, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { slotCoverRequests } from "#/db/schema";
import { planHash } from "#/lib/mcp-plan";
import { isMemberNotComing } from "#/server/attendance-plan-logic";
import { lockClubForWrite } from "#/server/club-write-lock";
import { openCoverRequestOf } from "#/server/cover-close";
import {
	ALREADY_TAKEN_MESSAGE,
	askForCoverCore,
	NOT_COMING_UNDO_MESSAGE,
	ONLY_HOLDER_MESSAGE,
	ONLY_RELEASER_MESSAGE,
	releaseOwnSlotForCoverCore,
	undoReleaseForCoverCore,
} from "#/server/cover-logic";
import { authorizeTokenForMeeting } from "../authz-logic";
import { McpError } from "../errors";
import {
	type DbOrTx,
	type LabelledSlot,
	loadLabelledSlots,
	loadMeetingFacts,
	type MemberBlockingItem,
	meetingPlanHeader,
	meetingStateBlocking,
	PLAN_STALE_MESSAGE,
	throwIfLocked,
} from "../member-meeting";
import type { McpToolDefinition } from "../tool";

const TOOL = "request_cover";

const inputSchema = {
	meetingId: z.string().uuid().describe("From get_my_schedule."),
	role: z
		.string()
		.trim()
		.min(1)
		.max(80)
		.describe('The role name or label, e.g. "Timer" or "Speaker 2".'),
	action: z
		.enum(["release", "undo", "ask"])
		.describe(
			'"release": hand off a role you hold and ask for cover. "undo": take back a role you released, while nobody has taken it. "ask": change a role you dropped into "finding cover".',
		),
	kind: z
		.enum(["finding_cover", "dropped"])
		.optional()
		.describe(
			'Required for "release" only. "finding_cover": the member is looking for someone. "dropped": the role is simply given up.',
		),
	planHash: z
		.string()
		.optional()
		.describe(
			"Omit to preview. Pass the planHash a preview returned, with the same input, to apply it.",
		),
};

type Action = "release" | "undo" | "ask";
type Kind = "finding_cover" | "dropped";

interface Computed {
	plan: {
		meeting: ReturnType<typeof meetingPlanHeader>;
		action: Action;
		slotLabel: string | null;
		kind: Kind | null;
	};
	planHash: string;
	blocking: MemberBlockingItem[];
	slotId: string | null;
}

async function compute(
	conn: DbOrTx,
	args: { meetingId: string; role: string; action: Action; kind?: Kind },
	who: { clubId: string; userId: string; memberId: string },
): Promise<Computed> {
	const facts = await loadMeetingFacts(conn, args.meetingId);
	const slots = await loadLabelledSlots(conn, args.meetingId);
	const wanted = args.role.trim().toLowerCase();
	const matching: LabelledSlot[] = slots.filter(
		(s) =>
			s.label.toLowerCase() === wanted || s.roleName.toLowerCase() === wanted,
	);
	const requests =
		matching.length === 0
			? []
			: await conn
					.select({
						slotId: slotCoverRequests.slotId,
						releasedBy: slotCoverRequests.releasedByMemberId,
						kind: slotCoverRequests.kind,
					})
					.from(slotCoverRequests)
					.where(
						and(
							inArray(
								slotCoverRequests.slotId,
								matching.map((s) => s.slotId),
							),
							openCoverRequestOf(matching.map((s) => s.slotId)),
						),
					);
	const requestOf = new Map(requests.map((r) => [r.slotId, r] as const));

	const blocking = meetingStateBlocking(facts);
	let candidates: LabelledSlot[];
	let refusal: string;
	if (args.action === "release") {
		candidates = matching.filter((s) => s.holderMemberId === who.memberId);
		refusal = ONLY_HOLDER_MESSAGE;
		if (!args.kind) {
			blocking.push({
				code: "KIND_REQUIRED",
				message:
					'"release" needs a kind: "finding_cover" or "dropped". Ask the user which.',
			});
		}
	} else {
		candidates = matching.filter(
			(s) => requestOf.get(s.slotId)?.releasedBy === who.memberId,
		);
		refusal =
			args.action === "undo" ? ALREADY_TAKEN_MESSAGE : ONLY_RELEASER_MESSAGE;
	}
	const chosen = candidates.length === 1 ? (candidates[0] ?? null) : null;
	if (matching.length === 0) {
		blocking.push({
			code: "NO_SUCH_ROLE",
			message: `There is no "${args.role}" at that meeting.`,
		});
	} else if (candidates.length === 0) {
		blocking.push({ code: "NOT_YOURS", message: refusal });
	} else if (candidates.length > 1) {
		blocking.push({
			code: "AMBIGUOUS_ROLE",
			message: `More than one "${args.role}" matches (${candidates
				.map((s) => s.label)
				.join(", ")}). Ask the user which, and pass that label.`,
		});
	}
	if (chosen && args.action === "undo") {
		if (chosen.status !== "open") {
			blocking.push({ code: "ALREADY_TAKEN", message: ALREADY_TAKEN_MESSAGE });
		} else if (
			await isMemberNotComing(conn, {
				memberId: who.memberId,
				meetingId: args.meetingId,
			})
		) {
			blocking.push({
				code: "NOT_COMING",
				message: NOT_COMING_UNDO_MESSAGE,
			});
		}
	}

	const plan = {
		meeting: meetingPlanHeader(facts),
		action: args.action,
		slotLabel: chosen?.label ?? null,
		kind:
			args.action === "release"
				? (args.kind ?? null)
				: args.action === "ask"
					? ("finding_cover" as const)
					: null,
	};
	return {
		plan,
		planHash: planHash({
			tool: TOOL,
			clubId: who.clubId,
			userId: who.userId,
			plan: {
				...plan,
				status: args.action,
				state: {
					slotId: chosen?.slotId ?? null,
					matching: matching
						.map((s) => ({
							slotId: s.slotId,
							status: s.status,
							holderMemberId: s.holderMemberId,
							requestKind: requestOf.get(s.slotId)?.kind ?? null,
							requestBy: requestOf.get(s.slotId)?.releasedBy ?? null,
						}))
						.sort((a, b) => a.slotId.localeCompare(b.slotId)),
				},
			},
		}),
		blocking,
		slotId: chosen?.slotId ?? null,
	};
}

export const requestCoverTool: McpToolDefinition = {
	name: TOOL,
	audience: "member",
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
	},
	config: {
		title: "Ask for cover on my role",
		description:
			"Hand off a role the caller holds and record a cover request, take that " +
			"back, or mark a dropped role as finding cover. Always the person this " +
			"token belongs to; it takes no member id, and only their own role or " +
			"their own request. Call get_my_schedule first to find the meetingId. " +
			'action "release" needs kind ("finding_cover" or "dropped"); "undo" and ' +
			'"ask" act on a request the caller made. Call once WITHOUT planHash to ' +
			"preview, show it to the user, and only after they agree call again with " +
			"the same input plus the planHash. This sends nothing to anyone: the " +
			"member tells people themselves.",
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
				throw new McpError("PLAN_STALE", PLAN_STALE_MESSAGE, {
					plan: c.plan,
					planHash: c.planHash,
					blocking: c.blocking,
				});
			}
			const first = c.blocking[0];
			if (first || !c.slotId || !c.plan.slotLabel) {
				throw new McpError("BLOCKED", first?.message ?? "Nothing to change.", {
					blocking: c.blocking,
				});
			}
			const core = { slotId: c.slotId, actorMemberId: who.memberId };
			try {
				if (args.action === "release") {
					await releaseOwnSlotForCoverCore(tx, {
						...core,
						kind: args.kind as Kind,
					});
				} else if (args.action === "undo") {
					await undoReleaseForCoverCore(tx, core);
				} else {
					await askForCoverCore(tx, core);
				}
			} catch (e) {
				if (e instanceof McpError) throw e;
				throw new McpError(
					"BLOCKED",
					e instanceof Error ? e.message : "Could not change that role.",
					{ blocking: [] },
				);
			}
			return { done: args.action, role: c.plan.slotLabel };
		});
	},
};
