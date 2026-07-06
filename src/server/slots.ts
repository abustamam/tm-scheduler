import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import {
	meetings,
	roleDefinitions,
	roleSlots,
	speakerDetails,
} from "#/db/schema";
import { logActivity } from "./activity";
import {
	requireClubRole,
	requireMeetingAgendaEditor,
	requireMemberInClub,
	requireUser,
} from "./guards";
import {
	applyAddSpeakerSlot,
	applyMoveSpeakerSlot,
	applyRemoveSpeakerSlot,
	normalizeSpeakerDetails,
} from "./slots-logic";

const speakerDetailsSchema = z.object({
	speechTitle: z.string().trim().optional(),
	pathwayPath: z.string().trim().optional(),
	projectName: z.string().trim().optional(),
	projectLevel: z.string().trim().optional(),
	minMinutes: z.number().int().positive().optional(),
	maxMinutes: z.number().int().positive().optional(),
});

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
				isSpeakerRole: roleDefinitions.isSpeakerRole,
				clubId: meetings.clubId,
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
		// Trust guard: memberId must be a roster member of this club.
		await requireMemberInClub(data.memberId, slot.clubId);

		return db.transaction(async (tx) => {
			// Conditional UPDATE is the race guard: only one claim can flip 'open'.
			const updated = await tx
				.update(roleSlots)
				.set({
					assignedMemberId: data.memberId,
					status: "claimed",
					claimedAt: new Date(),
				})
				.where(and(eq(roleSlots.id, data.slotId), eq(roleSlots.status, "open")))
				.returning({ id: roleSlots.id });

			if (updated.length === 0) {
				throw new Error("Sorry — this role was just claimed by someone else.");
			}

			if (slot.isSpeakerRole) {
				const details = normalizeSpeakerDetails(data.speakerDetails);
				await tx
					.insert(speakerDetails)
					.values({ slotId: data.slotId, ...details })
					.onConflictDoUpdate({
						target: speakerDetails.slotId,
						set: details,
					});
			}

			await logActivity(tx, {
				clubId: slot.clubId,
				actorMemberId: data.actorMemberId,
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
			})
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);

		if (!slot) {
			throw new Error("Role not found.");
		}

		// Trust guard: actorMemberId must be a roster member of this club.
		// Sheet-parity model — any club member may release/clear any slot; the
		// activity log records who did it (mirrors reassignSlot).
		await requireMemberInClub(data.actorMemberId, slot.clubId);

		return db.transaction(async (tx) => {
			await tx.delete(speakerDetails).where(eq(speakerDetails.slotId, slot.id));
			await tx
				.update(roleSlots)
				.set({ assignedMemberId: null, status: "open", claimedAt: null })
				.where(eq(roleSlots.id, slot.id));

			await logActivity(tx, {
				clubId: slot.clubId,
				actorMemberId: data.actorMemberId,
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
	actorMemberId: z.string().uuid(),
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
			})
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);

		if (!slot) {
			throw new Error("Role not found.");
		}

		await requireClubRole(currentUser.id, slot.clubId, ["admin", "vpe"]);

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
				actorMemberId: data.actorMemberId,
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
	actorMemberId: z.string().uuid(),
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
			})
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);

		if (!slot) {
			throw new Error("Role not found.");
		}

		await requireClubRole(currentUser.id, slot.clubId, ["admin", "vpe"]);

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
				actorMemberId: data.actorMemberId,
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
		const [slot] = await db
			.select({
				id: roleSlots.id,
				status: roleSlots.status,
				assignedMemberId: roleSlots.assignedMemberId,
				isSpeakerRole: roleDefinitions.isSpeakerRole,
				clubId: meetings.clubId,
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

		// Trust guards: both the actor and the target must be club roster members.
		await requireMemberInClub(data.actorMemberId, slot.clubId);
		await requireMemberInClub(data.memberId, slot.clubId);

		return db.transaction(async (tx) => {
			// New holder hasn't been confirmed → back to "claimed".
			await tx
				.update(roleSlots)
				.set({ assignedMemberId: data.memberId, status: "claimed" })
				.where(eq(roleSlots.id, data.slotId));

			// The previous speaker's speech no longer applies — reset to TBA.
			if (slot.isSpeakerRole) {
				const details = normalizeSpeakerDetails(undefined);
				await tx
					.insert(speakerDetails)
					.values({ slotId: data.slotId, ...details })
					.onConflictDoUpdate({
						target: speakerDetails.slotId,
						set: details,
					});
			}

			await logActivity(tx, {
				clubId: slot.clubId,
				actorMemberId: data.actorMemberId,
				action: "reassign",
				targetType: "slot",
				targetId: data.slotId,
				detail: {
					fromMemberId: slot.assignedMemberId,
					memberId: data.memberId,
				},
			});

			return { ok: true as const };
		});
	});

const updateSpeakerDetailsSchema = z.object({
	slotId: z.string().uuid(),
	actorMemberId: z.string().uuid(),
	speakerDetails: speakerDetailsSchema,
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
		if (!slot.isSpeakerRole) {
			throw new Error("Only speaker roles have speech details.");
		}
		await requireMemberInClub(data.actorMemberId, slot.clubId);

		const details = normalizeSpeakerDetails(data.speakerDetails);
		await db
			.insert(speakerDetails)
			.values({ slotId: data.slotId, ...details })
			.onConflictDoUpdate({ target: speakerDetails.slotId, set: details });

		return { ok: true as const };
	});

const speakerSlotSchema = z.object({
	meetingId: z.string().uuid(),
	actorMemberId: z.string().uuid().nullable().optional(),
	/** Self-asserted TMOD member id (public page). Null for authed admin/vpe. */
	selfMemberId: z.string().uuid().nullable().optional(),
});

/** Admin/VPE OR the meeting's self-asserted TMOD: add a speaker slot
 *  (+ paired evaluator). AUTHED or self-assert (ADR-0010). */
export const addSpeakerSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => speakerSlotSchema.parse(input))
	.handler(async ({ data }) => {
		await requireMeetingAgendaEditor({
			meetingId: data.meetingId,
			selfMemberId: data.selfMemberId ?? null,
		});
		return applyAddSpeakerSlot({
			meetingId: data.meetingId,
			actorMemberId: data.actorMemberId ?? null,
		});
	});

/** Admin/VPE OR the meeting's self-asserted TMOD: remove an unclaimed speaker
 *  slot (+ unclaimed evaluator). AUTHED or self-assert (ADR-0010). */
export const removeSpeakerSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => speakerSlotSchema.parse(input))
	.handler(async ({ data }) => {
		await requireMeetingAgendaEditor({
			meetingId: data.meetingId,
			selfMemberId: data.selfMemberId ?? null,
		});
		return applyRemoveSpeakerSlot({
			meetingId: data.meetingId,
			actorMemberId: data.actorMemberId ?? null,
		});
	});

const moveSpeakerSchema = z.object({
	slotId: z.string().uuid(),
	direction: z.enum(["up", "down"]),
	actorMemberId: z.string().uuid().nullable().optional(),
	/** Self-asserted TMOD member id (public page). Null for authed admin/vpe. */
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
		await requireMeetingAgendaEditor({
			meetingId: row.meetingId,
			selfMemberId: data.selfMemberId ?? null,
		});
		return applyMoveSpeakerSlot({
			slotId: data.slotId,
			direction: data.direction,
			actorMemberId: data.actorMemberId ?? null,
		});
	});
