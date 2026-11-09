/**
 * `edit_role_slots` — add and remove role slots on one meeting (#1542).
 *
 * The meeting page's "Add role" and the remove control, by asking. The tool
 * adds N places of a role the club defines (optionally seating a member in
 * each) and removes an EMPTY slot by id. It never touches a held slot: that is
 * `assign_roles`' clear, then a remove.
 *
 * ## Preview, then apply, in the conversation
 *
 * The `edit_agenda` shape. A call WITHOUT `planHash` writes nothing and returns
 * the plan, its `planHash`, the blocking items and the club's addable roles. The
 * SAME call with that hash locks the meeting row, re-plans from what is stored
 * now, answers `PLAN_STALE` (carrying the fresh plan) when the hash no longer
 * matches, and only then writes — in ONE transaction, through
 * `addRoleSlotCore` / `removeRoleSlotCore` / `reassignSlotCore`, the same bodies
 * the app's own Add role, remove and assign paths run. They take the caller's
 * transaction: calling the server-fn wrappers from here would open a second
 * connection that waits on the lock this one holds.
 *
 * The plan hashes the meeting's whole slot list as well as the operations, so
 * any slot that appeared, vanished or changed hands since the preview is stale.
 *
 * ## Blocking, never guessing
 *
 * A problem with any operation blocks the whole call. A member given by NAME
 * matches an active member of this club exactly (case-insensitive); two matches
 * are `AMBIGUOUS_MEMBER` with the candidates listed, never a pick. The club
 * comes from the meeting (`authorizeTokenForMeeting`), as in every meeting tool.
 *
 * Lock order: the target members' merge lock (shared) first, then the meeting
 * row, then the club's archive gate, then the slots (`removeRoleSlotCore` locks
 * each slot it removes). A member's ROW is locked later still, inside
 * `reassignSlotCore`, after the meeting lock; `assign_roles` takes the same
 * order for the same calls.
 *
 * An empty `operations` list is valid: a preview returns just the club's
 * addable roles, and an apply of that (empty) plan writes nothing.
 */
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import {
	clubs,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { MEETING_LOCKED_BLOCKING_MESSAGE } from "#/lib/assign-roles-plan";
import { CLUB_ARCHIVED_MESSAGE, isClubArchived } from "#/lib/club-archive";
import {
	MAX_ROLE_SLOT_OPS,
	MAX_ROLE_SLOTS_PER_ADD,
	MAX_ROLE_SLOTS_TOTAL_ADDED,
} from "#/lib/mcp-limits";
import { planHash } from "#/lib/mcp-plan";
import {
	isMeetingCancelled,
	MEETING_CANCELLED_MESSAGE,
} from "#/lib/meeting-cancellation-notice";
import { isMeetingLocked } from "#/lib/meeting-lifecycle";
import { pairedRoleIds } from "#/lib/meeting-roles";
import { lockMeetingForSlotEdit } from "#/server/meeting-slot-lock";
import {
	type DbOrTx,
	loadMeetingShapeDefs,
	roleDefScope,
} from "#/server/meeting-templates-logic";
import { lockMembershipsAgainstMerge } from "#/server/membership-merge-lock";
import {
	addRoleSlotCore,
	isSlotHeld,
	reassignSlotCore,
	removeRoleSlotCore,
} from "#/server/slots-logic";
import { authorizeTokenForMeeting } from "../authz-logic";
import { type McpBlockingItem, McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

export const EDIT_ROLE_SLOTS_TOOL = "edit_role_slots";

type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

const PLAN_STALE_MESSAGE =
	"This meeting's roles changed since that preview. Show the user the fresh plan and ask again.";

const opSchema = z.discriminatedUnion("op", [
	z
		.object({
			op: z.literal("add"),
			role: z.string().trim().min(1).max(120),
			count: z.number().int().min(1).max(MAX_ROLE_SLOTS_PER_ADD).optional(),
			member: z.string().trim().min(1).max(120).optional(),
		})
		.strict()
		.refine((o) => o.member === undefined || (o.count ?? 1) === 1, {
			message: "A member can only be seated when adding one place.",
		}),
	z
		.object({
			op: z.literal("remove"),
			// Lowercased at the edge, as `assign_roles` does (#1418): an uppercase
			// id must not read as another meeting's slot.
			slotId: z.string().uuid().toLowerCase(),
		})
		.strict(),
]);

type Op = z.infer<typeof opSchema>;

const inputSchema = {
	meetingId: z.string().uuid(),
	operations: z
		.array(opSchema)
		.max(MAX_ROLE_SLOT_OPS)
		.refine(
			(ops) =>
				ops.reduce((n, o) => n + (o.op === "add" ? (o.count ?? 1) : 0), 0) <=
				MAX_ROLE_SLOTS_TOTAL_ADDED,
			{
				message: `At most ${MAX_ROLE_SLOTS_TOTAL_ADDED} places can be added in one call.`,
			},
		)
		.describe(
			"Empty to just list the club's addable roles (a preview). " +
				"Applied in order, all or none. {op:'add', role, count?, member?}: " +
				"`role` is a name or id from the addableRoles a preview returns; " +
				"`member` is a member's name or id and needs count 1. " +
				"{op:'remove', slotId}: an EMPTY slot id from get_agenda.",
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

interface RoleDef {
	id: string;
	name: string;
	enabled: boolean;
}

interface SlotRow {
	id: string;
	roleDefinitionId: string;
	roleName: string;
	slotIndex: number;
	open: boolean;
	holderMemberId: string | null;
	holderGuestId: string | null;
}

interface RosterMember {
	id: string;
	name: string;
	status: string;
}

type PlanAddition = {
	opIndex: number;
	role: string;
	roleDefinitionId: string;
	slotIndex: number;
	assignee: { memberId: string; name: string } | null;
};

type PlanRemoval = {
	opIndex: number;
	slotId: string;
	role: string;
	slotIndex: number;
};

type Plan = {
	meetingId: string;
	status: string;
	operations: Op[];
	additions: PlanAddition[];
	removals: PlanRemoval[];
	/** The slots as they stand now: what the hash binds, so a meeting that
	 *  changed in any way since the preview is stale. */
	slots: SlotRow[];
	blocking: McpBlockingItem[];
};

type PlanStep =
	| { kind: "add"; roleDefinitionId: string; memberId: string | null }
	| { kind: "remove"; slotId: string };

const isUuid = (s: string) => z.string().uuid().safeParse(s).success;

/** The club's role bank, name and enabled flag. */
async function loadRoles(conn: DbOrTx, clubId: string): Promise<RoleDef[]> {
	return conn
		.select({
			id: roleDefinitions.id,
			name: roleDefinitions.name,
			enabled: roleDefinitions.enabled,
		})
		.from(roleDefinitions)
		.where(roleDefScope(clubId))
		.orderBy(asc(roleDefinitions.sortOrder), asc(roleDefinitions.id));
}

async function loadRoster(
	conn: DbOrTx,
	clubId: string,
): Promise<RosterMember[]> {
	return conn
		.select({ id: members.id, name: members.name, status: members.status })
		.from(members)
		.where(eq(members.clubId, clubId))
		.orderBy(asc(members.id));
}

async function loadSlots(conn: DbOrTx, meetingId: string): Promise<SlotRow[]> {
	const rows = await conn
		.select({
			id: roleSlots.id,
			roleDefinitionId: roleSlots.roleDefinitionId,
			roleName: roleDefinitions.name,
			slotIndex: roleSlots.slotIndex,
			status: roleSlots.status,
			holderMemberId: roleSlots.assignedMemberId,
			holderGuestId: roleSlots.assignedGuestId,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.where(eq(roleSlots.meetingId, meetingId))
		.orderBy(asc(roleSlots.roleDefinitionId), asc(roleSlots.slotIndex));
	return rows.map(({ status, ...r }) => ({
		...r,
		open: !isSlotHeld({
			status,
			assignedMemberId: r.holderMemberId,
			assignedGuestId: r.holderGuestId,
		}),
	}));
}

type MemberResolution =
	| { ok: true; id: string; name: string }
	| { ok: false; blocking: Omit<McpBlockingItem, "entryIndex"> };

/** A member given by id or by name, among the club's ACTIVE members. A name
 *  matches exactly, case-insensitively; more than one match is ambiguous and
 *  is never resolved here. */
function resolveMember(roster: RosterMember[], ref: string): MemberResolution {
	const notActive = (): MemberResolution => ({
		ok: false,
		blocking: {
			code: "NOT_A_MEMBER",
			message: `"${ref}" is not an active member of this club. find_people lists who can take a role.`,
			detail: { member: ref },
		},
	});
	if (isUuid(ref)) {
		const m = roster.find((r) => r.id === ref.toLowerCase());
		return m && m.status === "active"
			? { ok: true, id: m.id, name: m.name }
			: notActive();
	}
	const want = ref.trim().toLowerCase();
	const hits = roster.filter(
		(r) => r.status === "active" && r.name.trim().toLowerCase() === want,
	);
	if (hits.length === 0) return notActive();
	const [only] = hits;
	if (hits.length === 1 && only) {
		return { ok: true, id: only.id, name: only.name };
	}
	return {
		ok: false,
		blocking: {
			code: "AMBIGUOUS_MEMBER",
			message: `More than one active member is named "${ref}". Ask the user which one, then pass that member's id.`,
			detail: {
				member: ref,
				candidates: hits.map((h) => ({ memberId: h.id, name: h.name })),
			},
		},
	};
}

type MeetingRow = {
	id: string;
	clubId: string;
	status: string;
	templateId: string | null;
};

/**
 * Plan `ops` against the meeting as `conn` sees it. Pure over what it reads, so
 * the preview and the apply's re-plan differ only through what is stored. The
 * operations are simulated in order against an in-memory copy of the slot list,
 * which is how a `remove` then `add` of one role numbers its new place the way
 * `addRoleSlotCore` will.
 */
async function buildPlan(
	conn: DbOrTx,
	meeting: MeetingRow,
	ops: Op[],
): Promise<{
	plan: Plan;
	steps: PlanStep[];
	addable: { roleId: string; name: string }[];
}> {
	const [roles, roster, slots, shape] = await Promise.all([
		loadRoles(conn, meeting.clubId),
		loadRoster(conn, meeting.clubId),
		loadSlots(conn, meeting.id),
		loadMeetingShapeDefs(conn, meeting.clubId, meeting.templateId),
	]);
	const paired = pairedRoleIds(shape);
	const addable = roles
		.filter((r) => r.enabled && !paired.has(r.id))
		.map((r) => ({ roleId: r.id, name: r.name }));

	const blocking: McpBlockingItem[] = [];
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

	const simulatedSlots = slots.map((s) => ({ ...s }));
	const additions: PlanAddition[] = [];
	const removals: PlanRemoval[] = [];
	const steps: PlanStep[] = [];
	const removed = new Set<string>();

	for (const [opIndex, op] of ops.entries()) {
		if (op.op === "remove") {
			const slot = simulatedSlots.find((s) => s.id === op.slotId);
			if (removed.has(op.slotId)) {
				blocking.push({
					code: "DUPLICATE_SLOT",
					entryIndex: opIndex,
					message: "That slot is removed more than once. Send one operation.",
					detail: { slotId: op.slotId },
				});
			} else if (!slot) {
				blocking.push({
					code: "SLOT_NOT_IN_MEETING",
					entryIndex: opIndex,
					message:
						"That slot does not belong to this meeting. Slot ids come from get_agenda for the meeting you are editing.",
					detail: { slotId: op.slotId },
				});
			} else if (paired.has(slot.roleDefinitionId)) {
				blocking.push({
					code: "ROLE_NOT_EDITABLE",
					entryIndex: opIndex,
					message: `${slot.roleName} is a speaker or evaluator role: the speaker controls remove those.`,
					detail: { slotId: op.slotId },
				});
			} else if (!slot.open) {
				blocking.push({
					code: "SLOT_HELD",
					entryIndex: opIndex,
					message: `${slot.roleName} ${slot.slotIndex + 1} is held. Clear it first (assign_roles with clear: true), then remove it.`,
					detail: { slotId: op.slotId },
				});
			} else {
				removed.add(op.slotId);
				removals.push({
					opIndex,
					slotId: slot.id,
					role: slot.roleName,
					slotIndex: slot.slotIndex,
				});
				simulatedSlots.splice(simulatedSlots.indexOf(slot), 1);
				steps.push({ kind: "remove", slotId: slot.id });
			}
			continue;
		}

		// An add. The role by id, else by name among the club's roles, preferring
		// enabled ones so a retired namesake does not shadow the live role.
		const byRef = isUuid(op.role)
			? roles.filter((r) => r.id === op.role.toLowerCase())
			: roles.filter(
					(r) => r.name.trim().toLowerCase() === op.role.trim().toLowerCase(),
				);
		const live = byRef.filter((r) => r.enabled);
		const candidates = live.length > 0 ? live : byRef;
		const roleBlock = (message: string) =>
			blocking.push({
				code: "ROLE_NOT_EDITABLE",
				entryIndex: opIndex,
				message,
				detail: { role: op.role },
			});
		const [role] = candidates;
		if (!role) {
			roleBlock(
				`This club defines no role "${op.role}". The addable roles are listed in the preview.`,
			);
			continue;
		}
		if (candidates.length > 1) {
			roleBlock(
				`More than one enabled role is named "${op.role}". Pass the role's id from addableRoles.`,
			);
			continue;
		}
		if (!role.enabled) {
			roleBlock(`${role.name} is currently disabled for this club.`);
			continue;
		}
		if (paired.has(role.id)) {
			roleBlock(
				`${role.name} is a speaker or evaluator role: the speaker controls add those.`,
			);
			continue;
		}

		let assignee: PlanAddition["assignee"] = null;
		if (op.member !== undefined) {
			const resolved = resolveMember(roster, op.member);
			if (!resolved.ok) {
				blocking.push({ ...resolved.blocking, entryIndex: opIndex });
				continue;
			}
			assignee = { memberId: resolved.id, name: resolved.name };
		}

		for (let n = 0; n < (op.count ?? 1); n++) {
			const same = simulatedSlots.filter((s) => s.roleDefinitionId === role.id);
			const slotIndex =
				same.length === 0 ? 0 : Math.max(...same.map((s) => s.slotIndex)) + 1;
			simulatedSlots.push({
				id: `new:${opIndex}:${n}`,
				roleDefinitionId: role.id,
				roleName: role.name,
				slotIndex,
				open: true,
				holderMemberId: null,
				holderGuestId: null,
			});
			additions.push({
				opIndex,
				role: role.name,
				roleDefinitionId: role.id,
				slotIndex,
				assignee,
			});
			steps.push({
				kind: "add",
				roleDefinitionId: role.id,
				memberId: assignee?.memberId ?? null,
			});
		}
	}

	return {
		plan: {
			meetingId: meeting.id,
			status: meeting.status,
			operations: ops,
			additions,
			removals,
			slots,
			blocking,
		},
		steps,
		addable,
	};
}

function summarize(plan: Plan): string {
	const added = plan.additions.length;
	const removed = plan.removals.length;
	const seated = plan.additions.filter((a) => a.assignee).length;
	const parts = [
		added > 0
			? `${added} place${added === 1 ? "" : "s"} added${seated > 0 ? ` (${seated} with a member)` : ""}`
			: null,
		removed > 0 ? `${removed} removed` : null,
	].filter((p) => p !== null);
	return parts.join(", ") || "No changes";
}

export const editRoleSlotsTool: McpToolDefinition = {
	name: EDIT_ROLE_SLOTS_TOOL,
	audience: "officer",
	// Removes slots. Not idempotent: a fresh preview of the same adds applies
	// them again.
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
	},
	config: {
		title: "Add or remove role slots",
		description:
			"Add places of a role the club defines to one meeting (optionally " +
			"seating a member by name or id), or remove an EMPTY slot by id. " +
			"Without planHash this writes nothing: it returns the plan, a " +
			"planHash, any blocking items and the club's addable roles. Show the " +
			"plan to the user; call again with the same input plus that planHash " +
			"to apply it. All operations apply or none do. A held slot, a paired " +
			"speaker/evaluator role, a disabled or unknown role, an ambiguous or " +
			"inactive member and a completed or cancelled meeting are refused. " +
			"Never guess between members of the same name: ask the user.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const ops = args.operations;
		const { club, user } = await authorizeTokenForMeeting(ctx, args.meetingId);
		const hashOf = (plan: Plan) =>
			planHash({
				tool: EDIT_ROLE_SLOTS_TOOL,
				clubId: club.clubId,
				userId: user.id,
				plan,
			});

		if (args.planHash === undefined) {
			const [meeting] = await db
				.select({
					id: meetings.id,
					clubId: meetings.clubId,
					status: meetings.status,
					templateId: meetings.templateId,
				})
				.from(meetings)
				.where(eq(meetings.id, args.meetingId))
				.limit(1);
			if (!meeting) throw new McpError("NOT_FOUND", "Meeting not found.");
			const { plan, addable } = await buildPlan(db, meeting, ops);
			return {
				applied: false,
				meetingId: args.meetingId,
				clubId: club.clubId,
				summary: summarize(plan),
				plan,
				planHash: hashOf(plan),
				blocking: plan.blocking,
				addableRoles: addable,
			};
		}

		const expected = args.planHash;
		const result = await db.transaction(async (tx) => {
			// The target members' merge lock BEFORE the meeting lock, the order
			// `assign_roles` takes (#1327). Only members that resolve now; the
			// re-plan below decides again under the lock.
			const roster = await loadRoster(tx, club.clubId);
			const wanted = [
				...new Set(
					ops.flatMap((op) => {
						if (op.op !== "add" || op.member === undefined) return [];
						const r = resolveMember(roster, op.member);
						return r.ok ? [r.id] : [];
					}),
				),
			].sort();
			await lockMembershipsAgainstMerge(tx, wanted);

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
			const { plan, steps } = await buildPlan(tx, meeting, ops);
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
			await writeSteps(tx, args.meetingId, club.membershipId, steps);
			return { plan, slots: await loadSlots(tx, args.meetingId) };
		});

		return {
			applied: true,
			meetingId: args.meetingId,
			clubId: club.clubId,
			summary: summarize(result.plan),
			plan: result.plan,
			// Read back from what is now stored.
			slots: result.slots,
		};
	},
};

async function writeSteps(
	tx: Tx,
	meetingId: string,
	actorMemberId: string | null,
	steps: PlanStep[],
): Promise<void> {
	for (const step of steps) {
		if (step.kind === "remove") {
			await removeRoleSlotCore(tx, {
				slotId: step.slotId,
				meetingId,
				actorMemberId,
			});
			continue;
		}
		const created = await addRoleSlotCore(tx, {
			meetingId,
			roleDefinitionId: step.roleDefinitionId,
			actorMemberId,
		});
		if (step.memberId) {
			await reassignSlotCore(tx, {
				slotId: created.slotId,
				memberId: step.memberId,
				actorMemberId,
			});
		}
	}
}
