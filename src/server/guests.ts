import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings, roleSlots } from "#/db/schema";
import { requireClubRole, requireUser } from "./guards";
import { applyAssignGuestToSlot, listClubGuests } from "./guests-logic";

const uuid = z.string().uuid();

/** A club's guests for the admin assign picker. AUTHED — requires admin role. */
export const listGuests = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, clubId, ["admin"]);
		return listClubGuests(clubId);
	});

const assignGuestSchema = z
	.object({
		slotId: uuid,
		// Assign an existing club guest…
		guestId: uuid.optional(),
		// …or create a new one (name required, contact optional).
		newGuest: z
			.object({
				name: z.string().trim().min(1),
				email: z.string().trim().optional(),
				phone: z.string().trim().optional(),
			})
			.optional(),
		actorMemberId: uuid.nullable().optional(),
	})
	.refine((d) => Boolean(d.guestId) || Boolean(d.newGuest), {
		message: "Provide an existing guest or a new guest.",
	});

/**
 * Assign a non-member guest to a role slot (#151) — create a new club guest or
 * pick an existing one. ADMIN-ONLY: this is not offered on the public
 * self-serve/TMOD view, so it gates on the club admin role (not the softer
 * meeting-agenda-editor path). Mutually exclusive with a member assignee.
 */
export const assignGuestSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => assignGuestSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		const [slot] = await db
			.select({ clubId: meetings.clubId })
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);
		if (!slot) throw new Error("Role not found.");
		await requireClubRole(currentUser.id, slot.clubId, ["admin"]);

		await applyAssignGuestToSlot({
			slotId: data.slotId,
			guestId: data.guestId,
			newGuest: data.newGuest,
			actorMemberId: data.actorMemberId ?? null,
		});
		return { ok: true as const };
	});
