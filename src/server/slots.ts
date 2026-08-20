import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings, members, roleDefinitions, roleSlots } from "#/db/schema";
import { logActivity } from "./activity";
import {
	assertClubNotArchived,
	requireClubRole,
	requireMeetingAgendaEditor,
	requireMemberInClub,
	requireUser,
} from "./guards";
import { assertMeetingNotLocked } from "./meeting-authz-logic";
import {
	applyAddRoleSlot,
	applyAddSpeakerSlot,
	applyMoveSpeakerSlot,
	applyRemoveRoleSlot,
	applyRemoveSpeakerSlot,
	attachSpeechToSlot,
	editSlotSpeech,
	markComingOnSelfClaim,
	reassignSlotCore,
} from "./slots-logic";
import {
	speakerDetailsSchema,
	speakerDetailsUpdateSchema,
} from "./speaker-details-schema";
import { requestWriteActor } from "./write-actor-logic";

const claimSchema = z.object({
	slotId: z.string().uuid(),
	memberId: z.string().uuid(),
	actorMemberId: z.string().uuid(),
	speakerDetails: speakerDetailsSchema.optional(),
});

/** Claim an open slot for the given member. Speaker details are optional; a
 *  blank/missing speech title defaults to "TBA".
 *  PUBLIC — no session required; trust guard via requireMemberInClub. */
export const claimSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => claimSchema.parse(input))
	.handler(async ({ data }) => {
		const [slot] = await db
			.select({
				id: roleSlots.id,
				status: roleSlots.status,
				meetingId: roleSlots.meetingId,
				isSpeakerRole: roleDefinitions.isSpeakerRole,
				clubId: meetings.clubId,
				meetingStatus: meetings.status,
			})
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);

		if (!slot) {
			throw new Error("Role not found.");
		}
		assertMeetingNotLocked(slot.meetingStatus);
		// Trust guard: memberId must be a roster member of this club.
		await requireMemberInClub(data.memberId, slot.clubId);
		// Actor provenance (#396): a signed-in caller is credited as themselves; an
		// anonymous one keeps the name-pick, club-scoped to THIS slot's club.
		const actorMemberId = await requestWriteActor({
			clubId: slot.clubId,
			claimedActorMemberId: data.actorMemberId,
		});

		return db.transaction(async (tx) => {
			// Conditional UPDATE is the race guard: only one claim can flip 'open'.
			const updated = await tx
				.update(roleSlots)
				.set({
					assignedMemberId: data.memberId,
					assignedGuestId: null,
					status: "claimed",
					claimedAt: new Date(),
				})
				.where(and(eq(roleSlots.id, data.slotId), eq(roleSlots.status, "open")))
				.returning({ id: roleSlots.id });

			if (updated.length === 0) {
				throw new Error("Sorry — this role was just claimed by someone else.");
			}

			if (slot.isSpeakerRole) {
				// Claiming a speaker slot captures a Speech owned by the claimant's
				// Person (ADR-0009). Pure-TBA/empty input creates none — the slot
				// stays TBA (speech_id NULL) until a speech is attached later.
				const [claimant] = await tx
					.select({ personId: members.personId })
					.from(members)
					.where(eq(members.id, data.memberId))
					.limit(1);
				if (!claimant) throw new Error("Claiming member not found.");
				await attachSpeechToSlot(tx, {
					slotId: data.slotId,
					personId: claimant.personId,
					input: data.speakerDetails,
				});
			}

			await markComingOnSelfClaim(tx, {
				memberId: data.memberId,
				actorMemberId,
				meetingId: slot.meetingId,
				clubId: slot.clubId,
			});

			await logActivity(tx, {
				clubId: slot.clubId,
				actorMemberId,
				action: "claim",
				targetType: "slot",
				targetId: data.slotId,
				detail: { memberId: data.memberId },
			});

			return { ok: true as const };
		});
	});

const releaseSchema = z.object({
	slotId: z.string().uuid(),
	actorMemberId: z.string().uuid(),
});

/** Release a slot back to open. Only the assignee may do this (trust-based).
 *  PUBLIC — no session required; trust guard via requireMemberInClub. */
export const releaseSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => releaseSchema.parse(input))
	.handler(async ({ data }) => {
		const [slot] = await db
			.select({
				id: roleSlots.id,
				assignedMemberId: roleSlots.assignedMemberId,
				clubId: meetings.clubId,
				meetingStatus: meetings.status,
			})
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);

		if (!slot) {
			throw new Error("Role not found.");
		}
		// #555. PUBLIC — no session, so `requireMembership` never runs and the
		// archive check never arrives for free. Before the lock check, because a
		// taken-down club should refuse for the reason it was taken down rather
		// than for the meeting's status.
		await assertClubNotArchived(slot.clubId);
		assertMeetingNotLocked(slot.meetingStatus);

		// Trust guard + actor provenance (#396): the actor must be a roster member
		// of THIS slot's club, and a signed-in caller is credited as themselves.
		// Sheet-parity model — any club member may release/clear any slot; the
		// activity log records who did it (mirrors reassignSlot).
		const actorMemberId = await requestWriteActor({
			clubId: slot.clubId,
			claimedActorMemberId: data.actorMemberId,
		});

		return db.transaction(async (tx) => {
			// Release unlinks the speech (speech_id → NULL) but never deletes it:
			// the speech persists Person-owned and unscheduled (ADR-0009).
			await tx
				.update(roleSlots)
				.set({
					assignedMemberId: null,
					assignedGuestId: null,
					status: "open",
					claimedAt: null,
					speechId: null,
				})
				.where(eq(roleSlots.id, slot.id));

			await logActivity(tx, {
				clubId: slot.clubId,
				actorMemberId,
				action: "release",
				targetType: "slot",
				targetId: data.slotId,
				detail: { fromMemberId: slot.assignedMemberId },
			});

			return { ok: true as const };
		});
	});

const confirmSchema = z.object({
	slotId: z.string().uuid(),
});

/** Confirm a claimed slot. Only club admins/VPEs may do this.
 *  AUTHED — requires VPE/admin session. */
export const confirmSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => confirmSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();

		const [slot] = await db
			.select({
				id: roleSlots.id,
				status: roleSlots.status,
				assignedMemberId: roleSlots.assignedMemberId,
				clubId: meetings.clubId,
				meetingStatus: meetings.status,
			})
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);

		if (!slot) {
			throw new Error("Role not found.");
		}
		assertMeetingNotLocked(slot.meetingStatus);

		// The actor is the resolved admin membership — never the client (#396).
		const membership = await requireClubRole(currentUser.id, slot.clubId, [
			"admin",
		]);

		if (slot.status !== "claimed") {
			throw new Error("Only a claimed role can be confirmed.");
		}

		return db.transaction(async (tx) => {
			// Conditional UPDATE: only flips 'claimed' → 'confirmed'; a concurrent
			// release that races us back to 'open' will produce zero rows.
			const updated = await tx
				.update(roleSlots)
				.set({ status: "confirmed" })
				.where(
					and(eq(roleSlots.id, data.slotId), eq(roleSlots.status, "claimed")),
				)
				.returning({ id: roleSlots.id });

			if (updated.length === 0) {
				throw new Error(
					"Slot was no longer claimed — it may have been released concurrently.",
				);
			}

			await logActivity(tx, {
				clubId: slot.clubId,
				actorMemberId: membership.id,
				action: "claim",
				targetType: "slot",
				targetId: data.slotId,
				detail: { confirmed: true },
			});

			return { ok: true as const };
		});
	});

const unconfirmSchema = z.object({
	slotId: z.string().uuid(),
});

/** Un-confirm a slot back to claimed. Only club admins/VPEs may do this.
 *  AUTHED — requires VPE/admin session. */
export const unconfirmSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => unconfirmSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();

		const [slot] = await db
			.select({
				id: roleSlots.id,
				status: roleSlots.status,
				assignedMemberId: roleSlots.assignedMemberId,
				clubId: meetings.clubId,
				meetingStatus: meetings.status,
			})
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);

		if (!slot) {
			throw new Error("Role not found.");
		}
		assertMeetingNotLocked(slot.meetingStatus);

		// The actor is the resolved admin membership — never the client (#396).
		const membership = await requireClubRole(currentUser.id, slot.clubId, [
			"admin",
		]);

		return db.transaction(async (tx) => {
			// Conditional UPDATE: only flips 'confirmed' → 'claimed'.
			const updated = await tx
				.update(roleSlots)
				.set({ status: "claimed" })
				.where(
					and(eq(roleSlots.id, data.slotId), eq(roleSlots.status, "confirmed")),
				)
				.returning({ id: roleSlots.id });

			if (updated.length === 0) {
				throw new Error("Slot was not confirmed.");
			}

			await logActivity(tx, {
				clubId: slot.clubId,
				actorMemberId: membership.id,
				action: "release",
				targetType: "slot",
				targetId: data.slotId,
				detail: { unconfirmed: true },
			});

			return { ok: true as const };
		});
	});

const reassignSchema = z.object({
	slotId: z.string().uuid(),
	memberId: z.string().uuid(),
	actorMemberId: z.string().uuid(),
});

/** Reassign a claimed slot to a different member (trust-based).
 *  PUBLIC — no session required; trust guard via requireMemberInClub for both members. */
export const reassignSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => reassignSchema.parse(input))
	.handler(async ({ data }) => {
		// Cheap pre-read solely to resolve clubId for the trust guards; the
		// authoritative read-and-write happens under a row lock in
		// reassignSlotCore (ADR-0005 atomicity — this row may change before the tx).
		const [slot] = await db
			.select({ clubId: meetings.clubId })
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);

		if (!slot) {
			throw new Error("Role not found.");
		}

		// Trust guards: both the actor and the target must be club roster members;
		// a signed-in caller is credited as themselves rather than the name they
		// asserted (#396).
		const actorMemberId = await requestWriteActor({
			clubId: slot.clubId,
			claimedActorMemberId: data.actorMemberId,
		});
		await requireMemberInClub(data.memberId, slot.clubId);

		await db.transaction((tx) =>
			reassignSlotCore(tx, {
				slotId: data.slotId,
				memberId: data.memberId,
				actorMemberId,
			}),
		);

		return { ok: true as const };
	});

const updateSpeakerDetailsSchema = z.object({
	slotId: z.string().uuid(),
	actorMemberId: z.string().uuid(),
	// The TRUNCATING variant, not the rejecting one `claimSlot` uses. The edit
	// sheet prefills and resubmits every field, so a value stored before #522's
	// caps must not block edits to the others — see `#/lib/speaker-limits`.
	speakerDetails: speakerDetailsUpdateSchema,
});

/** Edit a speaker slot's speech details (trust-based). Blank title → "TBA".
 *  PUBLIC — no session required; trust guard via requireMemberInClub. */
export const updateSpeakerDetails = createServerFn({ method: "POST" })
	.validator((input: unknown) => updateSpeakerDetailsSchema.parse(input))
	.handler(async ({ data }) => {
		const [slot] = await db
			.select({
				id: roleSlots.id,
				isSpeakerRole: roleDefinitions.isSpeakerRole,
				clubId: meetings.clubId,
				meetingStatus: meetings.status,
				speechId: roleSlots.speechId,
				assignedMemberId: roleSlots.assignedMemberId,
				personId: members.personId,
			})
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.leftJoin(members, eq(members.id, roleSlots.assignedMemberId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);

		if (!slot) {
			throw new Error("Role not found.");
		}
		// #555 — see releaseSlot above.
		await assertClubNotArchived(slot.clubId);
		assertMeetingNotLocked(slot.meetingStatus);
		if (!slot.isSpeakerRole) {
			throw new Error("Only speaker roles have speech details.");
		}
		// A speech is Person-owned, so it needs an assignee to own it.
		if (!slot.assignedMemberId || !slot.personId) {
			throw new Error("Assign a member before adding speech details.");
		}
		// No activity row here, but the same trust guard applies: the caller must
		// resolve to a member of THIS club (session first, name-pick second, #396).
		await requestWriteActor({
			clubId: slot.clubId,
			claimedActorMemberId: data.actorMemberId,
		});

		await db.transaction(async (tx) => {
			await editSlotSpeech(tx, {
				slotId: data.slotId,
				personId: slot.personId as string,
				currentSpeechId: slot.speechId,
				input: data.speakerDetails,
			});
		});

		return { ok: true as const };
	});

// No `actorMemberId` on the wire (#396): the agenda-editor guard already knows
// who the caller is — the session's admin membership, or the self-asserted TMOD
// it verified against the meeting's TMOD slot — and that is what gets credited.
const speakerSlotSchema = z.object({
	meetingId: z.string().uuid(),
	/** Self-asserted TMOD member id (public page). Null for authed admin. */
	selfMemberId: z.string().uuid().nullable().optional(),
});

/** Admin/VPE OR the meeting's self-asserted TMOD: add a speaker slot
 *  (+ paired evaluator). AUTHED or self-assert (ADR-0010). */
export const addSpeakerSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => speakerSlotSchema.parse(input))
	.handler(async ({ data }) => {
		const authz = await requireMeetingAgendaEditor({
			meetingId: data.meetingId,
			selfMemberId: data.selfMemberId ?? null,
		});
		return applyAddSpeakerSlot({
			meetingId: data.meetingId,
			actorMemberId: authz.actorMemberId,
		});
	});

/** Admin/VPE OR the meeting's self-asserted TMOD: remove an unclaimed speaker
 *  slot (+ unclaimed evaluator). AUTHED or self-assert (ADR-0010). */
export const removeSpeakerSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => speakerSlotSchema.parse(input))
	.handler(async ({ data }) => {
		const authz = await requireMeetingAgendaEditor({
			meetingId: data.meetingId,
			selfMemberId: data.selfMemberId ?? null,
		});
		return applyRemoveSpeakerSlot({
			meetingId: data.meetingId,
			actorMemberId: authz.actorMemberId,
		});
	});

const moveSpeakerSchema = z.object({
	slotId: z.string().uuid(),
	direction: z.enum(["up", "down"]),
	/** Self-asserted TMOD member id (public page). Null for authed admin. */
	selfMemberId: z.string().uuid().nullable().optional(),
});

/** Admin/VPE OR the meeting's self-asserted TMOD: reorder a speaker slot up/down
 *  (swaps slotIndex). AUTHED or self-assert (ADR-0010). */
export const moveSpeakerSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => moveSpeakerSchema.parse(input))
	.handler(async ({ data }) => {
		const [row] = await db
			.select({ meetingId: roleSlots.meetingId })
			.from(roleSlots)
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);
		if (!row) throw new Error("Speaker slot not found.");
		const authz = await requireMeetingAgendaEditor({
			meetingId: row.meetingId,
			selfMemberId: data.selfMemberId ?? null,
		});
		return applyMoveSpeakerSlot({
			slotId: data.slotId,
			direction: data.direction,
			actorMemberId: authz.actorMemberId,
		});
	});

const addRoleSlotSchema = z.object({
	meetingId: z.string().uuid(),
	roleDefinitionId: z.string().uuid(),
});

/** Admin/VPE: add one arbitrary non-paired role slot to a meeting. AUTHED. */
export const addRoleSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => addRoleSlotSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		const [row] = await db
			.select({ clubId: meetings.clubId })
			.from(meetings)
			.where(eq(meetings.id, data.meetingId))
			.limit(1);
		if (!row) throw new Error("Meeting not found.");
		const membership = await requireClubRole(currentUser.id, row.clubId, [
			"admin",
		]);
		return applyAddRoleSlot({
			meetingId: data.meetingId,
			roleDefinitionId: data.roleDefinitionId,
			actorMemberId: membership.id,
		});
	});

const removeRoleSlotSchema = z.object({
	slotId: z.string().uuid(),
});

/** Admin/VPE: remove one unclaimed non-paired role slot. AUTHED. */
export const removeRoleSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => removeRoleSlotSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		const [row] = await db
			.select({ clubId: meetings.clubId })
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);
		if (!row) throw new Error("Role not found.");
		const membership = await requireClubRole(currentUser.id, row.clubId, [
			"admin",
		]);
		return applyRemoveRoleSlot({
			slotId: data.slotId,
			actorMemberId: membership.id,
		});
	});
