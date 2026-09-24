/**
 * `assign_roles` — fill and clear one meeting's role slots (#809, epic #771).
 *
 * Filling roles is the weekly job, and the one an officer most wants to do by
 * asking rather than by clicking. `get_agenda` returns every slot with its
 * assignee or `open`, and the slot ids it hands back are what this takes.
 *
 * ## It applies in the same call, and that is the decision this tool settles
 *
 * #806 moved `record_guest_book` behind an authenticated confirm page for two
 * reasons: an LLM's transcription of handwriting could not be verified because
 * the tool masked the field most likely to be misread, and the write MINTS PII
 * for people who are not users. Neither reaches here. There is no
 * transcription — every id in the input came from `get_agenda` — no PII, and a
 * wrong assignment is two clicks to fix on the agenda page the officer already
 * has open.
 *
 * The rule, stated once for both tools: **a page when the write is hard to see
 * or hard to undo.** `upsert_agendas` gets one because a single call can create
 * 52 meetings. This does not. It returns the plan anyway (`plan`, below) —
 * not as something to approve, but as the account of what happened, and the
 * only place an officer sees that someone came off a role they never mentioned.
 * Nothing here writes an `mcp_pending_plans` row and there is no `planHash`;
 * see `src/lib/mcp-plan.ts`, which records this tool as the exemption to
 * "every write tool returns `{plan, planHash}`".
 *
 * ## One transaction, or nothing
 *
 * The meeting row is locked `FOR NO KEY UPDATE` first, then every slot the
 * call names is locked `FOR UPDATE`, in one transaction; every
 * check runs against that locked state, and the three apply seams all take
 * that transaction. A half-applied agenda is worse than a refused one: the
 * half that landed is invisible next to the half that did not, and the caller
 * is an LLM that will report success. So a problem with any assignment is a
 * BLOCKING item and the whole call writes nothing.
 *
 * ## The club comes from the MEETING
 *
 * `authorizeTokenForMeeting`, never a `clubId` in the input — this tool takes
 * none. A caller pairing their own club id with another club's meeting would
 * be checked against the first and act on the second.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "#/db";
import {
	guests,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import {
	type AssignmentPlanLine,
	findDuplicateSlots,
	MEETING_LOCKED_BLOCKING_MESSAGE,
	OPEN_LABEL,
	planLine,
} from "#/lib/assign-roles-plan";
import { MAX_ROLE_ASSIGNMENTS } from "#/lib/mcp-limits";
import { isMeetingLocked } from "#/lib/meeting-lifecycle";
import { applyAssignGuestToSlot } from "#/server/guests-logic";
import { lockMeetingForSlotEdit } from "#/server/meeting-slot-lock";
import { reassignSlotCore, releaseSlotCore } from "#/server/slots-logic";
import { authorizeTokenForMeeting } from "../authz-logic";
import { type McpBlockingItem, McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

const assignmentSchema = z.union([
	z.object({ slotId: z.string().uuid(), memberId: z.string().uuid() }).strict(),
	z.object({ slotId: z.string().uuid(), guestId: z.string().uuid() }).strict(),
	z.object({ slotId: z.string().uuid(), clear: z.literal(true) }).strict(),
]);

const inputSchema = {
	meetingId: z.string().uuid(),
	assignments: z
		.array(assignmentSchema)
		.min(1)
		.max(MAX_ROLE_ASSIGNMENTS)
		.describe(
			"One instruction per slot: {slotId, memberId}, {slotId, guestId}, or " +
				"{slotId, clear: true}. Slot ids come from get_agenda.",
		),
};

type Assignment = z.infer<typeof assignmentSchema>;

/** Which of the three things one assignment asks for. */
function kindOf(a: Assignment): "member" | "guest" | "clear" {
	if ("memberId" in a) return "member";
	if ("guestId" in a) return "guest";
	return "clear";
}

/** What a slot looked like when the batch locked it. */
interface LockedSlot {
	id: string;
	slotIndex: number;
	status: string;
	assignedMemberId: string | null;
	assignedGuestId: string | null;
	speechId: string | null;
	speechTitle: string | null;
	isSpeakerRole: boolean;
	roleName: string;
	/** Prior member holder's Person, for the speech keep-or-unlink rule. */
	fromPersonId: string | null;
	/** Prior holder's rendered name, or null when the slot is open. */
	fromName: string | null;
}

export const assignRolesTool: McpToolDefinition = {
	name: "assign_roles",
	config: {
		title: "Assign roles",
		description:
			"Fill and clear one meeting's role slots. Each assignment names a slot " +
			"id from get_agenda and either a memberId, a guestId, or clear: true. " +
			"Returns a plan saying what every change did, in `from → to` form, and " +
			"applies it in the same call. The whole batch applies or none of it " +
			"does — a problem with any one assignment blocks all of them.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		// The club comes from the meeting and from nothing else. This tool takes
		// no clubId at all, so there is no second id to disagree with it.
		const { club } = await authorizeTokenForMeeting(ctx, args.meetingId);
		// The token's membership in THIS club is the actor every write is
		// credited to. `requestWriteActor` is the browser's equivalent and is
		// request-scoped, which is why `releaseSlotCore` takes its actor as an
		// argument rather than resolving one.
		const actorMemberId = club.membershipId;

		return db.transaction(async (tx) => {
			const blocking: McpBlockingItem[] = [];

			// Duplicates are decided from the input alone, before any read — two
			// instructions about one slot means one of them was a mistake, and
			// applying the later one silently picks which.
			for (const dup of findDuplicateSlots(
				args.assignments.map((a) => a.slotId),
			)) {
				blocking.push({
					code: "DUPLICATE_SLOT",
					entryIndex: dup.indexes[0],
					message: `That slot is named more than once (assignments ${dup.indexes.join(", ")}). Send one instruction per slot.`,
					detail: { slotId: dup.slotId, indexes: dup.indexes },
				});
			}

			// LOCKED, and before the slots below, through the SAME helper every
			// lineup editor takes it through — so a batch cannot deadlock against
			// an agenda edit, and the lock's strength is one declaration. #874
			// existed because this was a private copy that stayed `FOR UPDATE`
			// after #839 moved the helper to NO KEY UPDATE: a member's claim holds
			// its slot row and then writes its planned attendance, whose FK needs
			// KEY SHARE on this row, and FOR UPDATE refused it while this batch
			// waited on that slot below — 40P01 for one of them.
			//
			// Without the lock, the check here and the one `reassignSlotCore` and
			// `releaseSlotCore` make under the row lock could disagree: READ
			// COMMITTED lets a concurrent "complete meeting" commit between two
			// statements of this transaction, and the second refusal would
			// surface as an unexplained `INTERNAL` rather than as the blocking
			// item this tool is built to return. Holding the row makes the
			// answer below the answer for the whole batch.
			//
			// Its not-found throw is a plain Error, which the tool layer reports
			// as INTERNAL. Unreachable: authorization above resolved this
			// meeting's club, and the row cannot vanish while we hold a lock on it.
			const meeting = await lockMeetingForSlotEdit(tx, args.meetingId);
			if (isMeetingLocked(meeting.status)) {
				blocking.push({
					code: "MEETING_LOCKED",
					message: MEETING_LOCKED_BLOCKING_MESSAGE,
				});
			}

			const locked = await lockSlots(
				tx,
				args.meetingId,
				args.assignments.map((a) => a.slotId),
			);

			// Scoped to the authorized meeting, so a slot id from anywhere else is
			// simply absent — this never locks, and never reports on, a row in a
			// club the token does not administer.
			for (const [index, a] of args.assignments.entries()) {
				if (!locked.has(a.slotId)) {
					blocking.push({
						code: "SLOT_NOT_IN_MEETING",
						entryIndex: index,
						message:
							"That slot does not belong to this meeting. Slot ids come from get_agenda for the meeting you are editing.",
						detail: { slotId: a.slotId },
					});
				}
			}

			const targetMembers = await loadTargetMembers(
				tx,
				club.clubId,
				args.assignments,
			);
			const targetGuests = await loadTargetGuests(
				tx,
				club.clubId,
				args.assignments,
			);

			for (const [index, a] of args.assignments.entries()) {
				if ("memberId" in a && !targetMembers.has(a.memberId)) {
					blocking.push({
						code: "NOT_A_MEMBER",
						entryIndex: index,
						message:
							"That member is not an active member of this club. find_people lists who can take a role.",
						detail: { memberId: a.memberId },
					});
				}
				if ("guestId" in a) {
					const guest = targetGuests.get(a.guestId);
					if (!guest) {
						blocking.push({
							code: "NOT_A_GUEST",
							entryIndex: index,
							message:
								"That guest is not a guest of this club. find_people lists who can take a role.",
							detail: { guestId: a.guestId },
						});
					} else if (guest.convertedMembershipId) {
						// A guest who joined is a member now (#637). Assigning the guest
						// row would re-split a human whose guest and member records were
						// deliberately joined up, so this refuses here rather than
						// letting `applyAssignGuestToSlot` throw prose the tool layer
						// must never read (`errors.ts`).
						blocking.push({
							code: "NOT_A_GUEST",
							entryIndex: index,
							message: `${guest.name} is a member of this club now — assign them as a member, not as a guest.`,
							detail: {
								guestId: a.guestId,
								memberId: guest.convertedMembershipId,
							},
						});
					}
				}
			}

			// Nothing has been written yet, and nothing will be: the throw aborts
			// the transaction that holds every lock taken above.
			if (blocking.length > 0) {
				// The count is of PROBLEMS, not of assignments: a locked meeting is
				// one item and belongs to the call rather than to any line.
				throw new McpError(
					"BLOCKED",
					`Nothing was changed — ${blocking.length} problem${blocking.length === 1 ? "" : "s"} to fix first.`,
					{ blocking },
				);
			}

			const plan = args.assignments.map((a, index) =>
				planLineFor(index, a, { locked, targetMembers, targetGuests }),
			);

			for (const a of args.assignments) {
				if ("memberId" in a) {
					await reassignSlotCore(tx, {
						slotId: a.slotId,
						memberId: a.memberId,
						actorMemberId,
					});
				} else if ("guestId" in a) {
					// The caller's transaction, so this commits with the rest of the
					// batch rather than independently — and so it does not reach for a
					// second pooled connection while this one holds the row locks.
					await applyAssignGuestToSlot(
						{ slotId: a.slotId, guestId: a.guestId, actorMemberId },
						tx,
					);
				} else {
					await releaseSlotCore(tx, { slotId: a.slotId, actorMemberId });
				}
			}

			const kinds = args.assignments.map((a) => kindOf(a));
			return {
				applied: true,
				meetingId: args.meetingId,
				clubId: club.clubId,
				summary: {
					members: kinds.filter((k) => k === "member").length,
					guests: kinds.filter((k) => k === "guest").length,
					cleared: kinds.filter((k) => k === "clear").length,
				},
				plan,
			};
		});
	},
};

/**
 * Lock every named slot of this meeting `FOR UPDATE`, with its role, its
 * current holder's name and any linked speech.
 *
 * A second query rather than `loadMeetingSlots`, which `get_agenda` reads
 * through: that loader hardcodes `db`, so it can neither join this
 * transaction nor take a lock, and the whole correctness argument here is that
 * the state the plan describes is the state the writes act on. Ordered by id
 * so two concurrent batches take the same locks in the same order and cannot
 * deadlock against each other.
 *
 * **Two statements: lock, then read** (#874). The lock is a bare
 * `SELECT id … FOR UPDATE` on `role_slots`; the joined read comes after it.
 * One joined `SELECT … FOR UPDATE OF role_slots` is wrong under READ
 * COMMITTED whenever it has to WAIT: once the holder commits, Postgres
 * re-reads the locked row but keeps the joined rows from the statement's
 * original snapshot. A slot claimed while this batch waited then came back
 * `claimed`, assigned to the claimant, with a NULL holder name — so the plan
 * said `open → Sam` for a slot it had just taken off someone, and the speech
 * sentence was decided from a stale Person. The second statement takes a fresh
 * snapshot after the wait, and the slot rows are ours by then, so their holder
 * and speech ids cannot change before the writes. Only `role_slots` is locked:
 * a joined name or title can still change underneath, which is harmless here
 * because the plan only reports them.
 */
async function lockSlots(
	tx: Parameters<Parameters<(typeof db)["transaction"]>[0]>[0],
	meetingId: string,
	slotIds: string[],
): Promise<Map<string, LockedSlot>> {
	// Ordered by id so concurrent batches take these in one order. Nothing
	// here reads a column: see the doc comment for why the read is separate.
	const lockedIds = await tx
		.select({ id: roleSlots.id })
		.from(roleSlots)
		.where(
			and(eq(roleSlots.meetingId, meetingId), inArray(roleSlots.id, slotIds)),
		)
		.orderBy(asc(roleSlots.id))
		.for("update");
	if (lockedIds.length === 0) return new Map();

	const holder = alias(members, "slot_holder");
	const guestHolder = alias(guests, "slot_guest_holder");
	const rows = await tx
		.select({
			id: roleSlots.id,
			slotIndex: roleSlots.slotIndex,
			status: roleSlots.status,
			assignedMemberId: roleSlots.assignedMemberId,
			assignedGuestId: roleSlots.assignedGuestId,
			speechId: roleSlots.speechId,
			speechTitle: speeches.title,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
			roleName: roleDefinitions.name,
			holderName: holder.name,
			holderPersonId: holder.personId,
			guestHolderName: guestHolder.name,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.leftJoin(holder, eq(holder.id, roleSlots.assignedMemberId))
		.leftJoin(guestHolder, eq(guestHolder.id, roleSlots.assignedGuestId))
		.leftJoin(speeches, eq(speeches.id, roleSlots.speechId))
		// The meeting filter again, as defence in depth: the ids above were
		// already scoped to it, so this changes nothing unless they were not.
		.where(
			and(
				eq(roleSlots.meetingId, meetingId),
				inArray(
					roleSlots.id,
					lockedIds.map((r) => r.id),
				),
			),
		);

	return new Map(
		rows.map((r) => [
			r.id,
			{
				id: r.id,
				slotIndex: r.slotIndex,
				status: r.status,
				assignedMemberId: r.assignedMemberId,
				assignedGuestId: r.assignedGuestId,
				speechId: r.speechId,
				speechTitle: r.speechTitle,
				isSpeakerRole: r.isSpeakerRole,
				roleName: r.roleName,
				fromPersonId: r.holderPersonId,
				fromName: r.holderName ?? r.guestHolderName,
			} satisfies LockedSlot,
		]),
	);
}

interface TargetMember {
	id: string;
	name: string;
	personId: string;
}

/** The members this call assigns to, club-scoped and ACTIVE only. */
async function loadTargetMembers(
	tx: Parameters<Parameters<(typeof db)["transaction"]>[0]>[0],
	clubId: string,
	assignments: Assignment[],
): Promise<Map<string, TargetMember>> {
	const ids = [
		...new Set(
			assignments.flatMap((a) => ("memberId" in a ? [a.memberId] : [])),
		),
	];
	if (ids.length === 0) return new Map();
	const rows = await tx
		.select({ id: members.id, name: members.name, personId: members.personId })
		.from(members)
		.where(
			and(
				inArray(members.id, ids),
				eq(members.clubId, clubId),
				// Parity with `requireMemberInClub`: an inactive member did not renew
				// and is hidden from every picker, so a tool must not put them on an
				// agenda either.
				eq(members.status, "active"),
			),
		);
	return new Map(rows.map((r) => [r.id, r]));
}

interface TargetGuest {
	id: string;
	name: string;
	convertedMembershipId: string | null;
}

/** The guests this call assigns to, club-scoped. */
async function loadTargetGuests(
	tx: Parameters<Parameters<(typeof db)["transaction"]>[0]>[0],
	clubId: string,
	assignments: Assignment[],
): Promise<Map<string, TargetGuest>> {
	const ids = [
		...new Set(assignments.flatMap((a) => ("guestId" in a ? [a.guestId] : []))),
	];
	if (ids.length === 0) return new Map();
	const rows = await tx
		.select({
			id: guests.id,
			name: guests.name,
			convertedMembershipId: guests.convertedMembershipId,
		})
		.from(guests)
		.where(and(inArray(guests.id, ids), eq(guests.clubId, clubId)));
	return new Map(rows.map((r) => [r.id, r]));
}

/**
 * One assignment's plan line, from the state locked above.
 *
 * The speech sentence is the part that needs care. A release and a guest
 * assignment always unlink a linked speech; a member reassignment unlinks it
 * only when the Person actually changes (ADR-0009), which is the same rule
 * `reassignSlotCore` applies under the lock — so the plan is computed from the
 * same two Person ids that decide the write, not from a guess about it.
 */
function planLineFor(
	index: number,
	a: Assignment,
	batch: {
		locked: Map<string, LockedSlot>;
		targetMembers: Map<string, TargetMember>;
		targetGuests: Map<string, TargetGuest>;
	},
): AssignmentPlanLine {
	const { locked, targetMembers, targetGuests } = batch;
	// Present: every absent slot blocked the call before this runs.
	// biome-ignore lint/style/noNonNullAssertion: validated above
	const slot = locked.get(a.slotId)!;
	const base = {
		index,
		slotId: a.slotId,
		role: slot.roleName,
		slotIndex: slot.slotIndex,
		from: slot.fromName ?? OPEN_LABEL,
	};
	const linked = slot.speechId !== null ? slot.speechTitle : null;

	if ("memberId" in a) {
		// biome-ignore lint/style/noNonNullAssertion: validated above
		const to = targetMembers.get(a.memberId)!;
		const personChanges =
			slot.isSpeakerRole && slot.fromPersonId !== to.personId;
		return planLine({
			...base,
			to: to.name,
			unlinksSpeechTitled: personChanges ? linked : null,
		});
	}
	if ("guestId" in a) {
		// biome-ignore lint/style/noNonNullAssertion: validated above
		const to = targetGuests.get(a.guestId)!;
		// A guest cannot own a Person-owned speech, so the link always goes.
		return planLine({ ...base, to: to.name, unlinksSpeechTitled: linked });
	}
	return planLine({ ...base, to: OPEN_LABEL, unlinksSpeechTitled: linked });
}
