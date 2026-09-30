import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings, roleSlots } from "#/db/schema";
import { requireClubAdminView, requireClubRole, requireUser } from "./guards";
import { updateGuestProfileSchema } from "./guest-pipeline-schemas";
import {
	applyAssignGuestToSlot,
	applyUpdateGuestProfile,
	listClubGuests,
	loadGuestProfile,
	loadGuestProfiles,
} from "./guests-logic";

export type {
	GuestProfile,
	GuestProfileRow,
	IntroducerOption,
} from "./guests-logic";

const uuid = z.string().uuid();

/** A club's guests for the admin assign picker. AUTHED — requires admin role. */
export const listGuests = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubAdminView(currentUser.id, clubId);
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
				// Validated as an EMAIL for the same reason as `minutes.ts`'s
				// `newGuestSchema`: this writes `guests.email`, which the VP-Membership
				// card renders into a `mailto:` href, and free text there means a
				// stored "a@b.com?bcc=x" becomes live mailto headers. Every writer of
				// the column now agrees with `guestBookSchema`.
				email: z.string().trim().email().max(200).optional(),
				phone: z.string().trim().optional(),
			})
			.optional(),
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
		// The actor is the admin membership this guard resolved from the session —
		// never a client-supplied id, which could name another club's member (#396).
		const membership = await requireClubRole(currentUser.id, slot.clubId, [
			"admin",
		]);

		await applyAssignGuestToSlot({
			slotId: data.slotId,
			guestId: data.guestId,
			newGuest: data.newGuest,
			actorMemberId: membership.id,
		});
		return { ok: true as const };
	});

/**
 * One guest's kind, home club and introducer, plus the roster for the
 * "Introduced by" picker (#1050). Read fresh each time the guest edit dialog
 * opens. AUTHED — the same read gate as `listGuests` / `getGuestPipeline`.
 */
export const getGuestProfile = createServerFn({ method: "GET" })
	.validator((input: unknown) =>
		z.object({ clubId: uuid, guestId: uuid }).strict().parse(input),
	)
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubAdminView(currentUser.id, data.clubId);
		return loadGuestProfile(data.clubId, data.guestId);
	});

/**
 * Every guest's kind / home club / introducer, and each member's "brought"
 * count, for VP Membership (#1050). AUTHED — the same read gate as
 * `getGuestPipeline`, which the same page loads beside it.
 */
export const getGuestProfiles = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubAdminView(currentUser.id, clubId);
		return loadGuestProfiles(clubId);
	});

/**
 * Set a guest's kind, home club and introducer (#1050). AUTHED — admin-only,
 * the same gate as `updateGuest` and every other guest write: a guest record is
 * officer data. The introducer is checked against THIS club inside
 * `applyUpdateGuestProfile`, not here.
 */
export const updateGuestProfile = createServerFn({ method: "POST" })
	.validator((input: unknown) => updateGuestProfileSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return applyUpdateGuestProfile(data);
	});
