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
import {
	getMembership,
	requireClubRole,
	requireMembership,
	requireUser,
} from "./guards";

const speakerDetailsSchema = z.object({
	speechTitle: z.string().trim().min(1, "A speech title is required."),
	pathwayPath: z.string().trim().optional(),
	projectName: z.string().trim().optional(),
	projectLevel: z.string().trim().optional(),
	minMinutes: z.number().int().positive().optional(),
	maxMinutes: z.number().int().positive().optional(),
});

const claimSchema = z.object({
	slotId: z.string().uuid(),
	speakerDetails: speakerDetailsSchema.optional(),
});

/** Claim an open slot for the current user. Speaker roles require speaker details. */
export const claimSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => claimSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();

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
		await requireMembership(currentUser.id, slot.clubId);

		if (slot.isSpeakerRole && !data.speakerDetails) {
			throw new Error("Speaker roles require speech details before claiming.");
		}

		return db.transaction(async (tx) => {
			// Conditional UPDATE is the race guard: only one claim can flip 'open'.
			const updated = await tx
				.update(roleSlots)
				.set({
					assignedUserId: currentUser.id,
					status: "claimed",
					claimedAt: new Date(),
				})
				.where(and(eq(roleSlots.id, data.slotId), eq(roleSlots.status, "open")))
				.returning({ id: roleSlots.id });

			if (updated.length === 0) {
				throw new Error("Sorry — this role was just claimed by someone else.");
			}

			if (slot.isSpeakerRole && data.speakerDetails) {
				await tx
					.insert(speakerDetails)
					.values({ slotId: data.slotId, ...data.speakerDetails })
					.onConflictDoUpdate({
						target: speakerDetails.slotId,
						set: data.speakerDetails,
					});
			}

			return { ok: true as const };
		});
	});

/** Release a slot back to open. Only the assignee or a club admin/VPE may do this. */
export const releaseSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		z.object({ slotId: z.string().uuid() }).parse(input),
	)
	.handler(async ({ data }) => {
		const currentUser = await requireUser();

		const [slot] = await db
			.select({
				id: roleSlots.id,
				assignedUserId: roleSlots.assignedUserId,
				clubId: meetings.clubId,
			})
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);

		if (!slot) {
			throw new Error("Role not found.");
		}

		const membership = await getMembership(currentUser.id, slot.clubId);
		const isAdmin =
			membership?.clubRole === "admin" || membership?.clubRole === "vpe";
		const isAssignee = slot.assignedUserId === currentUser.id;
		if (!isAssignee && !isAdmin) {
			throw new Error("You can only release a role you've claimed.");
		}

		return db.transaction(async (tx) => {
			await tx.delete(speakerDetails).where(eq(speakerDetails.slotId, slot.id));
			await tx
				.update(roleSlots)
				.set({ assignedUserId: null, status: "open", claimedAt: null })
				.where(eq(roleSlots.id, slot.id));
			return { ok: true as const };
		});
	});

/** Confirm a claimed slot. Only club admins/VPEs may do this. */
export const confirmSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		z.object({ slotId: z.string().uuid() }).parse(input),
	)
	.handler(async ({ data }) => {
		const currentUser = await requireUser();

		const [slot] = await db
			.select({
				id: roleSlots.id,
				status: roleSlots.status,
				assignedUserId: roleSlots.assignedUserId,
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

		// Conditional UPDATE: only flips 'claimed' → 'confirmed'; a concurrent
		// release that races us back to 'open' will produce zero rows.
		const updated = await db
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

		return { ok: true as const };
	});

/** Un-confirm a slot back to claimed. Only club admins/VPEs may do this. */
export const unconfirmSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		z.object({ slotId: z.string().uuid() }).parse(input),
	)
	.handler(async ({ data }) => {
		const currentUser = await requireUser();

		const [slot] = await db
			.select({
				id: roleSlots.id,
				status: roleSlots.status,
				assignedUserId: roleSlots.assignedUserId,
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

		// Conditional UPDATE: only flips 'confirmed' → 'claimed'.
		const updated = await db
			.update(roleSlots)
			.set({ status: "claimed" })
			.where(
				and(eq(roleSlots.id, data.slotId), eq(roleSlots.status, "confirmed")),
			)
			.returning({ id: roleSlots.id });

		if (updated.length === 0) {
			throw new Error("Slot was not confirmed.");
		}

		return { ok: true as const };
	});
