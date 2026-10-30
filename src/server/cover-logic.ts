// Cover requests (#1438): the writes and reads behind `cover.ts` (a
// createServerFn module the guard test forbids from exporting db-touching
// functions). Integration-testable by mocking `#/db`.
//
// A cover request is a member-driven handoff of their OWN role. The slot goes
// back to `open` (so the fill-blank claim works unchanged), and a
// `slot_cover_requests` row remembers who left, when, and who covered it. The
// app suggests and drafts; the member sends.
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "#/db";
import {
	guests,
	meetings,
	members,
	roleSlots,
	slotCoverRequests,
} from "#/db/schema";
import { resolveEffectiveRung } from "#/lib/attendance-panel";
import type { CoverKind } from "#/lib/cover";
import { assertMeetingAccepts } from "#/lib/meeting-lifecycle";
import { logActivity } from "./activity";
import {
	isMemberNotComing,
	listPlanForMeetings,
	lockMemberAttendance,
} from "./attendance-plan-logic";
import { openCoverRequestOf } from "./cover-close";
import { assertClubNotArchived } from "./guards";
import { meetingAcceptsWrite } from "./meeting-write-gate";
import { lockMembershipsAgainstMerge } from "./membership-merge-lock";
import { loadRoleRecency } from "./role-recency-logic";
import { lockMemberForAssignment, releaseSlotCore } from "./slots-logic";

type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

export const ONLY_HOLDER_MESSAGE =
	"Only the person holding this role can hand it off.";
export const ALREADY_TAKEN_MESSAGE = "Someone already took it.";
export const NOT_A_COVER_RELEASE_MESSAGE =
	"That role was dropped when you said you can't come, so there is nothing to undo.";
export const NOT_COMING_UNDO_MESSAGE =
	"You're marked as not coming to that meeting.";
export const ONLY_RELEASER_MESSAGE =
	"Only the person who dropped this role can ask for cover.";
/** How many people the asker is offered. */
export const COVER_CANDIDATE_LIMIT = 5;

/**
 * Hand off the caller's OWN role and record a cover request (#1438).
 *
 * `releaseSlot` takes any slot for any signed-in member (sheet parity,
 * CONTEXT.md), so "own" is enforced HERE: the slot's holder must be
 * `actorMemberId`, read under the row lock, so a reassign that lands first
 * makes this refuse instead of releasing someone else's role. One transaction:
 * `releaseSlotCore` (the same archive and meeting-status gates, the activity
 * row, the speech unlink), then the request row. An open request already on the
 * slot is replaced.
 *
 * The `prior_*` columns record what the release wipes, so
 * {@link undoReleaseForCoverCore} can restore it (eng review D4).
 */
export async function releaseOwnSlotForCoverCore(
	tx: Tx,
	args: { slotId: string; actorMemberId: string | null; kind: CoverKind },
): Promise<{ clubId: string; meetingId: string }> {
	const [slot] = await tx
		.select({
			id: roleSlots.id,
			status: roleSlots.status,
			claimedAt: roleSlots.claimedAt,
			speechId: roleSlots.speechId,
			assignedMemberId: roleSlots.assignedMemberId,
			meetingId: roleSlots.meetingId,
			clubId: meetings.clubId,
			meetingStatus: meetings.status,
		})
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(eq(roleSlots.id, args.slotId))
		.limit(1)
		.for("update", { of: roleSlots });
	if (!slot) throw new Error("Role not found.");

	// A taken-down club answers for that reason, before anything about the role.
	await assertClubNotArchived(slot.clubId, tx);
	assertMeetingAccepts(slot.meetingStatus, "plan");
	if (!args.actorMemberId || slot.assignedMemberId !== args.actorMemberId) {
		throw new Error(ONLY_HOLDER_MESSAGE);
	}

	await releaseSlotCore(tx, {
		slotId: slot.id,
		actorMemberId: args.actorMemberId,
		proof: "session",
	});

	await tx.delete(slotCoverRequests).where(openCoverRequestOf(slot.id));
	await tx.insert(slotCoverRequests).values({
		clubId: slot.clubId,
		meetingId: slot.meetingId,
		slotId: slot.id,
		releasedByMemberId: args.actorMemberId,
		kind: args.kind,
		priorStatus: slot.status,
		priorClaimedAt: slot.claimedAt,
		priorSpeechId: slot.speechId,
	});
	return { clubId: slot.clubId, meetingId: slot.meetingId };
}

/**
 * Take a cover release back (#1438, D4). Allowed only while the slot is still
 * open and the caller is the open request's releaser; otherwise "Someone already
 * took it."
 *
 * Deletes the request and writes the three `prior_*` values back onto the slot
 * with the releaser as holder, in one transaction, and NOT through
 * `claimSlotCore`: a claim would reset the status to `claimed`, stamp `claimed_at`
 * now and drop the speech, so a confirmed speaker would come back as an
 * unconfirmed one with no speech. Deleting first also keeps `closeCoverRequest`
 * from marking the request covered by the person it was a request for.
 *
 * The speech is restored only if no other slot took it since (the unique index
 * allows one), and it is never recreated: a speech deleted meanwhile is already
 * NULL here through the FK.
 */
export async function undoReleaseForCoverCore(
	tx: Tx,
	args: { slotId: string; actorMemberId: string | null },
): Promise<{ clubId: string; meetingId: string }> {
	// Lock order as `claimSlotCore`'s: merge lock, member row, then slots.
	if (args.actorMemberId) {
		await lockMembershipsAgainstMerge(tx, [args.actorMemberId]);
		await lockMemberForAssignment(tx, args.actorMemberId);
	}
	// The attendance lock comes BEFORE the slot lock, as a decline takes them
	// (attendance, then the slots it frees): the other order deadlocks. The
	// meeting id is an unlocked read; the locked read below is the authority.
	const [unlocked] = await tx
		.select({ meetingId: roleSlots.meetingId })
		.from(roleSlots)
		.where(eq(roleSlots.id, args.slotId))
		.limit(1);
	if (unlocked && args.actorMemberId) {
		await lockMemberAttendance(tx, unlocked.meetingId, args.actorMemberId);
	}
	const [slot] = await tx
		.select({
			id: roleSlots.id,
			status: roleSlots.status,
			meetingId: roleSlots.meetingId,
			clubId: meetings.clubId,
			meetingStatus: meetings.status,
		})
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(eq(roleSlots.id, args.slotId))
		.limit(1)
		.for("update", { of: roleSlots });
	if (!slot) throw new Error("Role not found.");
	await assertClubNotArchived(slot.clubId, tx);
	assertMeetingAccepts(slot.meetingStatus, "plan");

	const [request] = await tx
		.select()
		.from(slotCoverRequests)
		.where(openCoverRequestOf(slot.id))
		.limit(1)
		.for("update");
	if (
		!request ||
		slot.status !== "open" ||
		!args.actorMemberId ||
		request.releasedByMemberId !== args.actorMemberId
	) {
		throw new Error(ALREADY_TAKEN_MESSAGE);
	}
	// Undo is for a release the member made to find cover. A `dropped` row is a
	// decline's, and a late "not coming" answer outranks a role handed back:
	// `claimSlotCore` refuses that member the same way. Both before any write.
	if (request.kind === "dropped") throw new Error(NOT_A_COVER_RELEASE_MESSAGE);
	if (
		await isMemberNotComing(tx, {
			memberId: args.actorMemberId,
			meetingId: slot.meetingId,
		})
	) {
		throw new Error(NOT_COMING_UNDO_MESSAGE);
	}

	await tx
		.delete(slotCoverRequests)
		.where(eq(slotCoverRequests.id, request.id));

	let speechId = request.priorSpeechId;
	if (speechId) {
		const [elsewhere] = await tx
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.where(eq(roleSlots.speechId, speechId))
			.limit(1);
		if (elsewhere) speechId = null;
	}
	const restored = await tx
		.update(roleSlots)
		.set({
			assignedMemberId: args.actorMemberId,
			assignedGuestId: null,
			status: request.priorStatus,
			claimedAt: request.priorClaimedAt,
			speechId,
		})
		.where(
			and(
				eq(roleSlots.id, slot.id),
				eq(roleSlots.status, "open"),
				isNull(roleSlots.assignedMemberId),
				isNull(roleSlots.assignedGuestId),
				meetingAcceptsWrite(tx, "plan", roleSlots.meetingId),
			),
		)
		.returning({ id: roleSlots.id });
	// Zero rows rolls the delete back with the throw.
	if (restored.length === 0) throw new Error(ALREADY_TAKEN_MESSAGE);

	await logActivity(tx, {
		clubId: slot.clubId,
		actorMemberId: args.actorMemberId,
		action: "claim",
		targetType: "slot",
		targetId: slot.id,
		detail: { memberId: args.actorMemberId, proof: "session", undoCover: true },
	});
	return { clubId: slot.clubId, meetingId: slot.meetingId };
}

/**
 * The releaser upgrades an open `dropped` request to `finding_cover` (#1438, D5):
 * a decline freed the role first, and now the member wants to find cover. Refused
 * for anyone else, and when there is no open request left (it was covered).
 */
export async function askForCoverCore(
	tx: Tx,
	args: { slotId: string; actorMemberId: string | null },
): Promise<{ clubId: string; meetingId: string }> {
	const [slot] = await tx
		.select({
			id: roleSlots.id,
			meetingId: roleSlots.meetingId,
			clubId: meetings.clubId,
			meetingStatus: meetings.status,
		})
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(eq(roleSlots.id, args.slotId))
		.limit(1)
		.for("update", { of: roleSlots });
	if (!slot) throw new Error("Role not found.");
	await assertClubNotArchived(slot.clubId, tx);
	assertMeetingAccepts(slot.meetingStatus, "plan");

	const [request] = await tx
		.select({
			id: slotCoverRequests.id,
			releasedByMemberId: slotCoverRequests.releasedByMemberId,
		})
		.from(slotCoverRequests)
		.where(openCoverRequestOf(slot.id))
		.limit(1)
		.for("update");
	if (
		!request ||
		!args.actorMemberId ||
		request.releasedByMemberId !== args.actorMemberId
	) {
		throw new Error(ONLY_RELEASER_MESSAGE);
	}
	await tx
		.update(slotCoverRequests)
		.set({ kind: "finding_cover" })
		.where(eq(slotCoverRequests.id, request.id));
	return { clubId: slot.clubId, meetingId: slot.meetingId };
}

export interface CoverCandidate {
	memberId: string;
	name: string;
	/** ISO instant of the last time they held this role, or null: never. */
	lastServedAt: string | null;
}

/**
 * Who to ask (#1438): active members likely to be at the meeting, never-held
 * first and then longest-ago, at most {@link COVER_CANDIDATE_LIMIT}.
 *
 * Likely to be there is `resolveEffectiveRung`'s answer (O6): a stored `coming`,
 * or a confirmed role that no explicit answer outranks. An explicit `not_coming`
 * beats the assumption. Excluded: the releaser, and anyone already holding this
 * role on this meeting.
 *
 * Returns the id and name only. NO contact: the member shares from their own
 * phone, and a signed-in member of the club is not an officer.
 */
export async function loadCoverCandidatesCore(args: {
	meetingId: string;
	slotId: string;
}): Promise<CoverCandidate[]> {
	const [slot] = await db
		.select({
			roleDefinitionId: roleSlots.roleDefinitionId,
			meetingId: roleSlots.meetingId,
			clubId: meetings.clubId,
			scheduledAt: meetings.scheduledAt,
		})
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(eq(roleSlots.id, args.slotId))
		.limit(1);
	if (!slot || slot.meetingId !== args.meetingId) {
		throw new Error("Role not found.");
	}

	const [openRequest] = await db
		.select({ releasedByMemberId: slotCoverRequests.releasedByMemberId })
		.from(slotCoverRequests)
		.where(openCoverRequestOf(args.slotId))
		.limit(1);

	const [roster, plans, held, recency] = await Promise.all([
		db
			.select({ id: members.id, name: members.name })
			.from(members)
			.where(
				and(eq(members.clubId, slot.clubId), eq(members.status, "active")),
			),
		// Through the plan seam, never an inline read of the table (its guard).
		listPlanForMeetings(db, [args.meetingId], { activeOnly: true }),
		db
			.select({
				memberId: roleSlots.assignedMemberId,
				roleDefinitionId: roleSlots.roleDefinitionId,
				status: roleSlots.status,
			})
			.from(roleSlots)
			.where(
				and(
					eq(roleSlots.meetingId, args.meetingId),
					isNotNull(roleSlots.assignedMemberId),
				),
			),
		loadRoleRecency({ clubId: slot.clubId, before: slot.scheduledAt }),
	]);

	const stored = new Map(plans.map((p) => [p.memberId, p.status] as const));
	const confirmed = new Set<string>();
	const holdsThisRole = new Set<string>();
	for (const h of held) {
		if (!h.memberId) continue;
		if (h.status === "confirmed") confirmed.add(h.memberId);
		if (h.roleDefinitionId === slot.roleDefinitionId) {
			holdsThisRole.add(h.memberId);
		}
	}
	const lastServed = new Map(
		recency
			.filter((r) => r.roleDefinitionId === slot.roleDefinitionId)
			.map((r) => [r.memberId, r.lastServedAt] as const),
	);

	return roster
		.filter((m) => m.id !== openRequest?.releasedByMemberId)
		.filter((m) => !holdsThisRole.has(m.id))
		.filter(
			(m) =>
				resolveEffectiveRung(stored.get(m.id) ?? null, {
					confirmed: confirmed.has(m.id),
				}).status === "coming",
		)
		.map((m) => ({
			memberId: m.id,
			name: m.name,
			lastServedAt: lastServed.get(m.id) ?? null,
		}))
		.sort((a, b) => {
			// Never-held first, then the longest ago; name breaks a tie so the order
			// is stable between two loads.
			if (a.lastServedAt === null && b.lastServedAt !== null) return -1;
			if (a.lastServedAt !== null && b.lastServedAt === null) return 1;
			if (a.lastServedAt && b.lastServedAt) {
				const d = a.lastServedAt.getTime() - b.lastServedAt.getTime();
				if (d !== 0) return d;
			}
			return a.name.localeCompare(b.name);
		})
		.slice(0, COVER_CANDIDATE_LIMIT)
		.map((c) => ({
			memberId: c.memberId,
			name: c.name,
			lastServedAt: c.lastServedAt?.toISOString() ?? null,
		}));
}

export interface MeetingCoverRequest {
	slotId: string;
	kind: CoverKind;
	releasedName: string;
	releasedAt: Date;
	coveredName: string | null;
	coveredAt: Date | null;
}

/**
 * The meeting payload's `coverRequests` (#1438): the newest request per slot, as
 * names only (the public page already shows assignee names). A releaser or
 * coverer who is no longer an ACTIVE member reads as "Someone" (#1342: the
 * payload is public, and a member who left must not be named on it).
 *
 * Two rows are hidden WITHOUT being written:
 *  - a `covered` one once the slot's assignee is no longer the person who
 *    covered it (a plain release or a reassign after the cover);
 *  - an open one on a slot somebody holds, which means a fill site did not
 *    close it, and the page must not claim someone is still finding cover for
 *    a role that has a name on it.
 */
export async function loadMeetingCoverRequests(
	meetingId: string,
	slots: {
		id: string;
		assigneeId: string | null;
		assigneeGuestId: string | null;
	}[],
): Promise<MeetingCoverRequest[]> {
	const releaser = db
		.select({ id: members.id, name: members.name })
		.from(members)
		.where(eq(members.status, "active"))
		.as("releaser");
	const coverer = db
		.select({ id: members.id, name: members.name })
		.from(members)
		.where(eq(members.status, "active"))
		.as("coverer");
	const rows = await db
		.select({
			slotId: slotCoverRequests.slotId,
			kind: slotCoverRequests.kind,
			releasedAt: slotCoverRequests.releasedAt,
			coveredAt: slotCoverRequests.coveredAt,
			coveredByMemberId: slotCoverRequests.coveredByMemberId,
			coveredGuestId: slotCoverRequests.coveredGuestId,
			releasedName: releaser.name,
			coveredMemberName: coverer.name,
			coveredGuestName: guests.name,
		})
		.from(slotCoverRequests)
		.leftJoin(releaser, eq(releaser.id, slotCoverRequests.releasedByMemberId))
		.leftJoin(coverer, eq(coverer.id, slotCoverRequests.coveredByMemberId))
		.leftJoin(guests, eq(guests.id, slotCoverRequests.coveredGuestId))
		.where(eq(slotCoverRequests.meetingId, meetingId))
		.orderBy(desc(slotCoverRequests.releasedAt));

	const slotById = new Map(slots.map((s) => [s.id, s] as const));
	const seen = new Set<string>();
	const out: MeetingCoverRequest[] = [];
	for (const r of rows) {
		// Newest first, so the first row per slot is the one that counts; an older
		// row is never shown in its place when the newest is hidden.
		if (seen.has(r.slotId)) continue;
		seen.add(r.slotId);
		const slot = slotById.get(r.slotId);
		if (!slot) continue;
		const held = slot.assigneeId !== null || slot.assigneeGuestId !== null;
		if (r.coveredAt === null) {
			if (held) continue;
		} else {
			const stillCovering =
				(r.coveredByMemberId !== null &&
					slot.assigneeId === r.coveredByMemberId) ||
				(r.coveredGuestId !== null &&
					slot.assigneeGuestId === r.coveredGuestId);
			if (!stillCovering) continue;
		}
		out.push({
			slotId: r.slotId,
			kind: r.kind,
			releasedName: r.releasedName ?? "Someone",
			releasedAt: r.releasedAt,
			coveredName: r.coveredAt
				? (r.coveredMemberName ?? r.coveredGuestName ?? "Someone")
				: null,
			coveredAt: r.coveredAt,
		});
	}
	return out;
}
