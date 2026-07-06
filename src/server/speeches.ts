// Server-fn surface for the unscheduled-speech / reschedule UI (ADR-0009 /
// #102). This module exports ONLY createServerFns + types — all db logic lives
// in the sibling `speeches-logic.ts` so the guard test (server-modules.guard)
// passes and `#/db` never leaks into the client bundle.
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings, roleSlots } from "#/db/schema";
import { requireMembership, requireUser } from "./guards";
import {
	attachSpeechToOpenSlot,
	listUnscheduledSpeeches,
	setSpeechArchived,
	type UnscheduledSpeech,
} from "./speeches-logic";

export type { UnscheduledSpeech };

const uuid = z.string().uuid();

const listSchema = z.object({
	clubId: uuid,
	personId: uuid.optional(),
	includeArchived: z.boolean().optional(),
});

/** List a club's (and optionally a single Person's) unscheduled speeches —
 *  derived from slot linkage, archived hidden by default. AUTHED (any member). */
export const getUnscheduledSpeeches = createServerFn({ method: "GET" })
	.validator((input: unknown) => listSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireMembership(currentUser.id, data.clubId);
		return listUnscheduledSpeeches(db, {
			clubId: data.clubId,
			personId: data.personId,
			includeArchived: data.includeArchived,
		});
	});

const archiveSchema = z.object({
	speechId: uuid,
	clubId: uuid,
	archived: z.boolean(),
});

/** Archive or unarchive a speech (hide/restore it in the unscheduled list).
 *  AUTHED (any member of the club). */
export const archiveSpeech = createServerFn({ method: "POST" })
	.validator((input: unknown) => archiveSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireMembership(currentUser.id, data.clubId);
		await setSpeechArchived(db, {
			speechId: data.speechId,
			clubId: data.clubId,
			archived: data.archived,
		});
		return { ok: true as const };
	});

const rescheduleSchema = z.object({
	speechId: uuid,
	slotId: uuid,
});

/** The reschedule flow: attach an unscheduled speech to an open speaker slot,
 *  assigning the slot to the speech owner's membership. AUTHED (any member of
 *  the slot's club). */
export const rescheduleSpeech = createServerFn({ method: "POST" })
	.validator((input: unknown) => rescheduleSchema.parse(input))
	.handler(async ({ data }) => {
		// Resolve the slot's club to gate on membership and record the actor.
		const [slot] = await db
			.select({ clubId: meetings.clubId })
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);
		if (!slot) throw new Error("Speaker slot not found.");

		const currentUser = await requireUser();
		const membership = await requireMembership(currentUser.id, slot.clubId);

		return db.transaction((tx) =>
			attachSpeechToOpenSlot(tx, {
				speechId: data.speechId,
				slotId: data.slotId,
				actorMemberId: membership.id,
			}),
		);
	});
