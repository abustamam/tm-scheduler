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
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { coverRequestKindEnum, slotCoverRequests } from "#/db/schema";
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

const actionSchema = z.enum(["release", "undo", "ask"]);

const inputSchema = {
	meetingId: z.string().uuid().describe("From get_my_schedule."),
	role: z
		.string()
		.trim()
		.min(1)
		.max(80)
		.describe('The role name or label, e.g. "Timer" or "Speaker 2".'),
	action: actionSchema.describe(
		'"release": hand off a role you hold and ask for cover. "undo": take back a role you released, while nobody has taken it. "ask": change a role you dropped into "finding cover".',
	),
	kind: z
		.enum(coverRequestKindEnum.enumValues)
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

type Action = z.infer<typeof actionSchema>;
type Kind = (typeof coverRequestKindEnum.enumValues)[number];

/** The cover cores throw plain Errors; only these sentences are the app's own refusals. */
const CORE_REFUSALS = new Set<string>([
	ONLY_HOLDER_MESSAGE,
	ALREADY_TAKEN_MESSAGE,
	ONLY_RELEASER_MESSAGE,
	NOT_COMING_UNDO_MESSAGE,
]);

const NO_REQUEST_MESSAGE = "You have no cover request on that role.";

const PLAN_KIND: Record<Action, (kind: Kind | undefined) => Kind | null> = {
	release: (kind) => kind ?? null,
	ask: () => "finding_cover",
	undo: () => null,
};

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

function requestState(
	r:
		| {
				id: string;
				kind: Kind;
				releasedBy: string | null;
				priorStatus: string;
				priorClaimedAt: Date | null;
				priorSpeechId: string | null;
		  }
		| undefined,
) {
	if (!r) return null;
	return {
		id: r.id,
		kind: r.kind,
		releasedBy: r.releasedBy,
		priorStatus: r.priorStatus,
		priorClaimedAt: r.priorClaimedAt?.toISOString() ?? null,
		priorSpeechId: r.priorSpeechId,
	};
}

async function compute(
	conn: DbOrTx,
	args: { meetingId: string; role: string; action: Action; kind?: Kind },
	who: { clubId: string; userId: string; memberId: string },
): Promise<Computed> {
	const facts = await loadMeetingFacts(conn, args.meetingId);
	const slots = await loadLabelledSlots(conn, args.meetingId);
	const wanted = args.role.toLowerCase();
	const matching: LabelledSlot[] = slots.filter(
		(s) =>
			s.label.toLowerCase() === wanted || s.roleName.toLowerCase() === wanted,
	);
	const requests =
		matching.length === 0
			? []
			: await conn
					.select({
						id: slotCoverRequests.id,
						slotId: slotCoverRequests.slotId,
						releasedBy: slotCoverRequests.releasedByMemberId,
						kind: slotCoverRequests.kind,
						priorStatus: slotCoverRequests.priorStatus,
						priorClaimedAt: slotCoverRequests.priorClaimedAt,
						priorSpeechId: slotCoverRequests.priorSpeechId,
					})
					.from(slotCoverRequests)
					.where(openCoverRequestOf(matching.map((s) => s.slotId)));
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
		refusal = ONLY_RELEASER_MESSAGE;
	}
	const chosen = candidates.length === 1 ? (candidates[0] ?? null) : null;
	if (matching.length === 0) {
		blocking.push({
			code: "NO_SUCH_ROLE",
			message: `There is no "${args.role}" at that meeting.`,
		});
	} else if (candidates.length === 0) {
		if (args.action === "undo" && requests.length === 0) {
			// No open request on any match: either the caller's request was closed
			// because someone took the slot, or they never released it.
			const closed = await conn
				.select({ id: slotCoverRequests.id })
				.from(slotCoverRequests)
				.where(
					and(
						eq(slotCoverRequests.releasedByMemberId, who.memberId),
						isNotNull(slotCoverRequests.coveredAt),
						inArray(
							slotCoverRequests.slotId,
							matching.map((s) => s.slotId),
						),
					),
				)
				.limit(1);
			blocking.push(
				closed.length > 0
					? { code: "ALREADY_TAKEN", message: ALREADY_TAKEN_MESSAGE }
					: { code: "NO_COVER_REQUEST", message: NO_REQUEST_MESSAGE },
			);
		} else {
			blocking.push({ code: "NOT_YOURS", message: refusal });
		}
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
		kind: PLAN_KIND[args.action](args.kind),
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
					matching: matching
						.map((s) => ({
							slotId: s.slotId,
							status: s.status,
							holderMemberId: s.holderMemberId,
							request: requestState(requestOf.get(s.slotId)),
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
	// Writes the caller's own role and request. Destructive (the slot is emptied
	// or a request is deleted) and not idempotent: a repeat after an apply is
	// refused or changes a different state.
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
				if (args.action === "release" && c.plan.kind) {
					await releaseOwnSlotForCoverCore(tx, { ...core, kind: c.plan.kind });
				} else if (args.action === "release") {
					// Unreachable: KIND_REQUIRED blocks a release without a kind.
					throw new McpError("BLOCKED", "A release needs a kind.");
				} else if (args.action === "undo") {
					await undoReleaseForCoverCore(tx, core);
				} else {
					await askForCoverCore(tx, core);
				}
			} catch (e) {
				if (e instanceof Error && CORE_REFUSALS.has(e.message)) {
					throw new McpError("BLOCKED", e.message, { blocking: [] });
				}
				throw e;
			}
			return { done: args.action, role: c.plan.slotLabel };
		});
	},
};
