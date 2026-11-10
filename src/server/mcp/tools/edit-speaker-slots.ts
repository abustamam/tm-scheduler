/**
 * `edit_speaker_slots` — add, remove and reorder a meeting's speaker slots
 * (#1576), the meeting page's "+ / − speaker" and the speaker and evaluator
 * arrows, by asking.
 *
 * A speaker slot comes paired with an evaluator slot, so this is its own tool
 * and `edit_role_slots` refuses those roles. Who HOLDS a slot is `assign_roles`;
 * this tool never touches a holder. Authorization is the meeting's `agenda`
 * capability (`authorizeDelegateForMeeting`, #1567): an officer or the meeting's
 * Toastmaster, the same two the app lets use the speaker controls.
 *
 * ## One code path for preview and apply
 *
 * The steps run through the app's OWN bodies (`applyAddSpeakerSlot`,
 * `applyRemoveSpeakerSlot`, `applyMoveSpeakerSlot`, `applyMoveEvaluatorSlot`),
 * on one transaction, so the tool never re-derives which pair a removal takes or
 * how the pairing is realigned. A preview runs them and ROLLS BACK (it throws a
 * sentinel out of the transaction), so it writes nothing, takes the meeting lock
 * only for its own duration, and shows exactly what an apply would produce. An
 * apply runs them, compares the hash of what it built with the hash it was
 * given, and either commits or throws (`PLAN_STALE`, `BLOCKED`), which rolls
 * every step back: a half-applied line-up cannot happen.
 *
 * Steps run in a fixed order: adds or removals, then `moveSpeakers`, then
 * `moveEvaluators`, each in the order given.
 *
 * ## Blocking, never choosing
 *
 * A step that cannot run is a blocking item and the whole call is blocked. The
 * tool makes its OWN checks before each step (the slot is of this meeting's
 * speaker or evaluator line-up, the move is not past an end, the role is
 * enabled) and raises the code itself. The one thing it learns from the app's refusal is that the pair the app would remove is held (`isSpeakerRemovalHeldRefusal`); WHO holds is then read from the rows again, never inferred from the message. It never
 * removes a different pair than the app's function takes.
 *
 * ## Locks
 *
 * The meeting row first (`lockMeetingForSlotEdit`), then the club's archive
 * gate, then whatever the cores lock (the pair's rows). Every step re-takes the
 * meeting lock, a no-op in the same transaction.
 */
import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { clubs, guests, members, roleSlots } from "#/db/schema";
import { MEETING_LOCKED_BLOCKING_MESSAGE } from "#/lib/assign-roles-plan";
import { CLUB_ARCHIVED_MESSAGE, isClubArchived } from "#/lib/club-archive";
import { planHash } from "#/lib/mcp-plan";
import {
	isMeetingCancelled,
	MEETING_CANCELLED_MESSAGE,
} from "#/lib/meeting-cancellation-notice";
import { isMeetingLocked } from "#/lib/meeting-lifecycle";
import { MAX_MOVES, MAX_SPEAKER_COUNT } from "#/lib/speaker-slot-limits";
import { lockMeetingForSlotEdit } from "#/server/meeting-slot-lock";
import {
	applyAddSpeakerSlot,
	applyMoveEvaluatorSlot,
	applyMoveSpeakerSlot,
	applyRemoveSpeakerSlot,
	clubRoles,
	isSlotHeld,
	isSpeakerRemovalHeldRefusal,
	SPEAKER_CLAIMED_MESSAGE,
} from "#/server/slots-logic";
import { authorizeDelegateForMeeting } from "../authz-logic";
import { type McpBlockingItem, McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

export const EDIT_SPEAKER_SLOTS_TOOL = "edit_speaker_slots";

type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

const PLAN_STALE_MESSAGE =
	"This meeting's speaker line-up changed since that preview. Show the user the fresh plan and ask again.";

const moveSchema = z
	.object({
		slotId: z.string().uuid().toLowerCase(),
		direction: z.enum(["up", "down"]),
	})
	.strict();

const inputSchema = {
	meetingId: z.string().uuid(),
	addSpeakers: z
		.number()
		.int()
		.min(1)
		.max(MAX_SPEAKER_COUNT)
		.optional()
		.describe(
			"Add this many speaker slots, each with its paired evaluator slot.",
		),
	removeSpeakers: z
		.number()
		.int()
		.min(1)
		.max(MAX_SPEAKER_COUNT)
		.optional()
		.describe(
			"Remove this many speaker slots with their evaluators, taking the pair " +
				"the app takes each time. Blocked if that pair is held. Not with addSpeakers.",
		),
	moveSpeakers: z
		.array(moveSchema)
		.max(MAX_MOVES)
		.optional()
		.describe(
			"[{slotId, direction: 'up'|'down'}] applied in order: moves a speaker " +
				"one place earlier (up) or later (down). Slot ids come from the preview's `before`.",
		),
	moveEvaluators: z
		.array(moveSchema)
		.max(MAX_MOVES)
		.optional()
		.describe(
			"[{slotId, direction}] applied in order, after moveSpeakers: reorders evaluators.",
		),
	planHash: z
		.string()
		.min(1)
		.max(200)
		.optional()
		.describe(
			"Omit to preview. Pass the planHash a preview returned to apply that plan.",
		),
};

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

type Holder = { kind: "member" | "guest"; name: string } | null;

type LineupSlot = {
	slotId: string;
	/** 1-based place in its own role's order. */
	position: number;
	holder: Holder;
	/** Evaluators only: the position of the speaker this one evaluates. */
	evaluates?: number | null;
};

type Lineup = { speakers: LineupSlot[]; evaluators: LineupSlot[] };

/** The line-up with no slot ids, for what the plan promises AFTER the steps: a
 *  slot added by a preview is rolled back, so its id would differ from the one an
 *  apply creates, and a hash over it could never match. */
type AfterSlot = Omit<LineupSlot, "slotId">;

type Plan = {
	meetingId: string;
	status: string;
	request: {
		addSpeakers: number | null;
		removeSpeakers: number | null;
		moveSpeakers: z.infer<typeof moveSchema>[];
		moveEvaluators: z.infer<typeof moveSchema>[];
	};
	before: Lineup;
	after: { speakers: AfterSlot[]; evaluators: AfterSlot[] };
	blocking: McpBlockingItem[];
};

type MeetingRow = {
	id: string;
	clubId: string;
	status: string;
	templateId: string | null;
};

/** The speaker and evaluator line-ups as `conn` sees them: the PICKED pair of
 *  roles for this meeting's shape, in order, with holders' names. */
async function loadLineup(
	conn: Tx,
	meetingId: string,
	speakerRoleId: string,
	evaluatorRoleId: string | null,
): Promise<Lineup> {
	const pairedEvaluator =
		evaluatorRoleId && evaluatorRoleId !== speakerRoleId
			? evaluatorRoleId
			: null;
	const roleIds = pairedEvaluator
		? [speakerRoleId, pairedEvaluator]
		: [speakerRoleId];
	const rows = await conn
		.select({
			id: roleSlots.id,
			roleDefinitionId: roleSlots.roleDefinitionId,
			slotIndex: roleSlots.slotIndex,
			status: roleSlots.status,
			memberId: roleSlots.assignedMemberId,
			guestId: roleSlots.assignedGuestId,
			evaluatesSlotId: roleSlots.evaluatesSlotId,
		})
		.from(roleSlots)
		.where(eq(roleSlots.meetingId, meetingId))
		.orderBy(asc(roleSlots.slotIndex), asc(roleSlots.id));
	const wanted = rows.filter((r) => roleIds.includes(r.roleDefinitionId));
	const memberIds = wanted.flatMap((r) => (r.memberId ? [r.memberId] : []));
	const guestIds = wanted.flatMap((r) => (r.guestId ? [r.guestId] : []));
	const [memberRows, guestRows] = await Promise.all([
		memberIds.length > 0
			? conn
					.select({ id: members.id, name: members.name })
					.from(members)
					.where(inArray(members.id, memberIds))
			: Promise.resolve([]),
		guestIds.length > 0
			? conn
					.select({ id: guests.id, name: guests.name })
					.from(guests)
					.where(inArray(guests.id, guestIds))
			: Promise.resolve([]),
	]);
	const holderOf = (r: (typeof wanted)[number]): Holder => {
		if (r.memberId) {
			return {
				kind: "member",
				name: memberRows.find((m) => m.id === r.memberId)?.name ?? "A member",
			};
		}
		if (r.guestId) {
			return {
				kind: "guest",
				name: guestRows.find((g) => g.id === r.guestId)?.name ?? "A guest",
			};
		}
		// A held slot with no person on it (a status other than open): still held.
		return isSlotHeld({
			status: r.status,
			assignedMemberId: null,
			assignedGuestId: null,
		})
			? { kind: "member", name: "Someone" }
			: null;
	};
	const ofRole = (roleId: string) =>
		wanted
			.filter((r) => r.roleDefinitionId === roleId)
			.sort((a, b) => a.slotIndex - b.slotIndex || a.id.localeCompare(b.id));
	const speakerRows = ofRole(speakerRoleId);
	const speakers: LineupSlot[] = speakerRows.map((r, i) => ({
		slotId: r.id,
		position: i + 1,
		holder: holderOf(r),
	}));
	const evaluators: LineupSlot[] = pairedEvaluator
		? ofRole(pairedEvaluator).map((r, i) => {
				const at = speakerRows.findIndex((s) => s.id === r.evaluatesSlotId);
				return {
					slotId: r.id,
					position: i + 1,
					holder: holderOf(r),
					evaluates: at === -1 ? null : at + 1,
				};
			})
		: [];
	return { speakers, evaluators };
}

const stripIds = (l: Lineup): Plan["after"] => ({
	speakers: l.speakers.map(({ slotId: _s, ...rest }) => rest),
	evaluators: l.evaluators.map(({ slotId: _s, ...rest }) => rest),
});

/** The slots whose holders stop the app's removal, read from the current
 *  line-up. No speaker free: every held speaker. Otherwise the pair's evaluator
 *  is held (or, with no recorded pairing, any held evaluator): the one on the
 *  highest-placed speaker that is itself free, which is the pair the app takes. */
function heldHolders(now: Lineup, message: string): LineupSlot[] {
	if (message === SPEAKER_CLAIMED_MESSAGE) {
		return now.speakers.filter((s) => s.holder !== null);
	}
	const free = new Set(
		now.speakers.filter((s) => s.holder === null).map((s) => s.position),
	);
	const blocked = now.evaluators.filter(
		(e) => e.holder !== null && (e.evaluates == null || free.has(e.evaluates)),
	);
	blocked.sort((a, b) => (b.evaluates ?? 0) - (a.evaluates ?? 0));
	return blocked.slice(0, 1);
}

/**
 * Run the request's steps on `tx` and describe the result. Writes whatever the
 * steps write: the caller either commits (apply) or rolls back (preview).
 * Refusals the tool knows about become blocking items and the step is skipped;
 * anything else propagates and becomes INTERNAL.
 */
async function runSteps(
	tx: Tx,
	meeting: MeetingRow,
	args: Args,
	actorMemberId: string | null,
): Promise<Plan> {
	const roles = await clubRoles(tx, meeting.clubId, meeting.templateId);
	const read = () =>
		loadLineup(tx, meeting.id, roles.speakerRoleId, roles.evaluatorRoleId);
	const before = await read();
	const blocking: McpBlockingItem[] = [];
	const request: Plan["request"] = {
		addSpeakers: args.addSpeakers ?? null,
		removeSpeakers: args.removeSpeakers ?? null,
		moveSpeakers: args.moveSpeakers ?? [],
		moveEvaluators: args.moveEvaluators ?? [],
	};
	const plan = (after: Lineup): Plan => ({
		meetingId: meeting.id,
		status: meeting.status,
		request,
		before,
		after: stripIds(after),
		blocking,
	});

	if (isMeetingLocked(meeting.status)) {
		blocking.push({
			code: "MEETING_LOCKED",
			message: MEETING_LOCKED_BLOCKING_MESSAGE,
		});
	}
	if (isMeetingCancelled(meeting.status)) {
		blocking.push({
			code: "MEETING_LOCKED",
			message: MEETING_CANCELLED_MESSAGE,
		});
	}
	if (blocking.length > 0) return plan(before);

	const actor = { meetingId: meeting.id, actorMemberId };

	if (request.addSpeakers !== null) {
		if (!roles.speakerEnabled) {
			blocking.push({
				code: "ROLE_NOT_EDITABLE",
				message: "This club's Speaker role is currently disabled.",
			});
		} else {
			for (let n = 0; n < request.addSpeakers; n++) {
				await applyAddSpeakerSlot(actor, tx);
			}
		}
	}

	if (request.removeSpeakers !== null) {
		for (let n = 0; n < request.removeSpeakers; n++) {
			const now = await read();
			if (now.speakers.length === 0) {
				blocking.push({
					code: "ROLE_NOT_EDITABLE",
					message: "This meeting has no speaker slots to remove.",
				});
				break;
			}
			try {
				await applyRemoveSpeakerSlot(actor, tx);
			} catch (err) {
				if (
					!(err instanceof Error) ||
					err instanceof McpError ||
					!isSpeakerRemovalHeldRefusal(err.message)
				) {
					throw err;
				}
				// Who holds is read again NOW, not inferred from the message: it is
				// built from a stored slot index (which has gaps) and from a read
				// that a claim may have outrun. The refusal is a JS throw after the
				// core's queries, so the transaction is still usable.
				const holders = heldHolders(await read(), err.message);
				blocking.push({
					code: "SLOT_HELD",
					message: `${err.message} Clear the holder first (assign_roles with clear: true), then remove.`,
					detail: {
						slotId: holders[0]?.slotId ?? null,
						holder: holders[0]?.holder?.name ?? null,
						holders: holders.map((h) => ({
							slotId: h.slotId,
							holder: h.holder?.name ?? null,
						})),
						removal: n + 1,
					},
				});
				break;
			}
		}
	}

	const moves: {
		list: "moveSpeakers" | "moveEvaluators";
		kind: "speaker" | "evaluator";
	}[] = [
		{ list: "moveSpeakers", kind: "speaker" },
		{ list: "moveEvaluators", kind: "evaluator" },
	];
	for (const { list, kind } of moves) {
		for (const [entryIndex, move] of request[list].entries()) {
			const now = await read();
			const line = kind === "speaker" ? now.speakers : now.evaluators;
			const at = line.findIndex((s) => s.slotId === move.slotId);
			if (at === -1) {
				blocking.push({
					code: "SLOT_NOT_IN_MEETING",
					entryIndex,
					message: `That slot is not a ${kind} slot of this meeting. Slot ids come from the preview's before line-up.`,
					detail: { list, slotId: move.slotId },
				});
				continue;
			}
			const edge = move.direction === "up" ? at === 0 : at === line.length - 1;
			if (edge) {
				blocking.push({
					code: "ROLE_NOT_EDITABLE",
					entryIndex,
					message: `${kind === "speaker" ? "Speaker" : "Evaluator"} ${at + 1} is already ${move.direction === "up" ? "first" : "last"}, so it cannot move ${move.direction}.`,
					detail: { list, slotId: move.slotId },
				});
				continue;
			}
			const input = {
				slotId: move.slotId,
				direction: move.direction,
				actorMemberId,
			};
			if (kind === "speaker") await applyMoveSpeakerSlot(input, tx);
			else await applyMoveEvaluatorSlot(input, tx);
		}
	}

	return plan(await read());
}

function describeLine(slots: AfterSlot[]): string {
	return slots.length === 0 ? "no" : String(slots.length);
}

function summarize(plan: Plan): string {
	const added = plan.after.speakers.length - plan.before.speakers.length;
	const parts = [
		added > 0 ? `${added} speaker slot${added === 1 ? "" : "s"} added` : null,
		added < 0
			? `${-added} speaker slot${added === -1 ? "" : "s"} removed`
			: null,
		plan.request.moveSpeakers.length > 0
			? `${plan.request.moveSpeakers.length} speaker move${plan.request.moveSpeakers.length === 1 ? "" : "s"}`
			: null,
		plan.request.moveEvaluators.length > 0
			? `${plan.request.moveEvaluators.length} evaluator move${plan.request.moveEvaluators.length === 1 ? "" : "s"}`
			: null,
	].filter((p) => p !== null);
	return `${parts.join(", ") || "No changes"} (${describeLine(plan.after.speakers)} speakers after)`;
}

/** Thrown out of a preview's transaction so it rolls back; carries the plan. */
class PreviewRollback extends Error {
	constructor(readonly plan: Plan) {
		super("preview rollback");
	}
}

export const editSpeakerSlotsTool: McpToolDefinition = {
	name: EDIT_SPEAKER_SLOTS_TOOL,
	audience: "member",
	// Removes slots. Not idempotent: applying "add 2" twice adds four.
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
	},
	config: {
		title: "Add, remove or reorder speaker slots",
		description:
			"For a meeting's officer or Toastmaster. Add speaker slots (each with " +
			"its paired evaluator slot), remove unclaimed ones, or reorder the " +
			"speakers and the evaluators. Steps run in this order: add or remove, " +
			"then moveSpeakers, then moveEvaluators. Without planHash this writes " +
			"nothing: it returns the speaker and evaluator line-up before and after, " +
			"with holders' names, a planHash and any blocking items. Show it to the " +
			"user; call again with the same input plus that planHash to apply. All " +
			"steps apply or none do. A held speaker or evaluator is never removed " +
			"(release it with assign_roles first); a move past either end, a slot " +
			"that is not of this meeting's line-up, and a completed or cancelled " +
			"meeting are refused. For every other role use edit_role_slots; for who " +
			"holds a slot use assign_roles.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		if (
			args.addSpeakers === undefined &&
			args.removeSpeakers === undefined &&
			(args.moveSpeakers ?? []).length === 0 &&
			(args.moveEvaluators ?? []).length === 0
		) {
			throw new McpError(
				"VALIDATION",
				"Give at least one of addSpeakers, removeSpeakers, moveSpeakers or moveEvaluators.",
			);
		}
		if (args.addSpeakers !== undefined && args.removeSpeakers !== undefined) {
			throw new McpError(
				"VALIDATION",
				"addSpeakers and removeSpeakers cannot be sent together. Send one, apply it, then the other.",
			);
		}
		const { club, user, actorMemberId } = await authorizeDelegateForMeeting(
			ctx,
			args.meetingId,
			"agenda",
		);
		const hashOf = (plan: Plan) =>
			planHash({
				tool: EDIT_SPEAKER_SLOTS_TOOL,
				clubId: club.clubId,
				userId: user.id,
				plan,
			});

		if (args.planHash === undefined) {
			let plan: Plan;
			try {
				await db.transaction(async (tx) => {
					const meeting = await lockMeetingForSlotEdit(tx, args.meetingId);
					throw new PreviewRollback(
						await runSteps(tx, meeting, args, actorMemberId),
					);
				});
				throw new Error("unreachable: a preview always rolls back");
			} catch (err) {
				if (!(err instanceof PreviewRollback)) throw err;
				plan = err.plan;
			}
			return {
				applied: false,
				meetingId: args.meetingId,
				clubId: club.clubId,
				summary: summarize(plan),
				plan,
				planHash: hashOf(plan),
				blocking: plan.blocking,
			};
		}

		const expected = args.planHash;
		const result = await db.transaction(async (tx) => {
			const meeting = await lockMeetingForSlotEdit(tx, args.meetingId);
			// The archive gate UNDER the lock: authorization read it before the
			// transaction, and the club may have been archived since.
			const [clubRow] = await tx
				.select({ archivedAt: clubs.archivedAt })
				.from(clubs)
				.where(eq(clubs.id, meeting.clubId))
				.limit(1);
			if (!clubRow) throw new McpError("NOT_FOUND", "Club not found.");
			if (isClubArchived(clubRow)) {
				throw new McpError("ARCHIVED", CLUB_ARCHIVED_MESSAGE);
			}
			// Throwing from here on rolls back every step already run.
			const plan = await runSteps(tx, meeting, args, actorMemberId);
			const freshHash = hashOf(plan);
			if (freshHash !== expected) {
				throw new McpError("PLAN_STALE", PLAN_STALE_MESSAGE, {
					plan,
					planHash: freshHash,
					summary: summarize(plan),
				});
			}
			if (plan.blocking.length > 0) {
				throw new McpError(
					"BLOCKED",
					`Nothing was changed — ${plan.blocking.length} problem${plan.blocking.length === 1 ? "" : "s"} to fix first.`,
					{ blocking: plan.blocking },
				);
			}
			const roles = await clubRoles(tx, meeting.clubId, meeting.templateId);
			return {
				plan,
				lineup: await loadLineup(
					tx,
					meeting.id,
					roles.speakerRoleId,
					roles.evaluatorRoleId,
				),
			};
		});

		return {
			applied: true,
			meetingId: args.meetingId,
			clubId: club.clubId,
			summary: summarize(result.plan),
			plan: result.plan,
			// Read back from what is now stored, with the new slots' ids.
			lineup: result.lineup,
		};
	},
};
