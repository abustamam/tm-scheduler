import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireClubAdminView, requireClubRole, requireUser } from "./guards";
import {
	applyConvertGuestToMember,
	applyDeleteGuest,
	applySetGuestStage,
	applyUpdateGuest,
	captureGuestVisit,
	loadGuestPipeline,
} from "./guest-pipeline-logic";

// The db-touching logic lives in `guest-pipeline-logic.ts` (never imported by
// client routes) so it can't drag `#/db` → `pg` into the browser bundle. This
// module exports ONLY createServerFns + types — see `server-modules.guard.test.ts`.
export type {
	CaptureGuestResult,
	DeleteGuestResult,
	GuestStage,
	ManualGuestStage,
	PipelineGuestRow,
} from "./guest-pipeline-logic";

const uuid = z.string().uuid();

const guestBookSchema = z.object({
	clubId: uuid,
	name: z.string().trim().min(1, "Please enter your name."),
	email: z.string().trim().email().optional().or(z.literal("")),
	phone: z.string().trim().optional().or(z.literal("")),
});

/**
 * Guest-book capture (the public #239 front door). PUBLIC — no session required,
 * mirroring `addMember`/`getPublicSeasonGrid`: anyone at the meeting with the
 * club link may self-register. Create-or-find by phone→email + record a visit
 * against the club's current/nearest meeting.
 */
export const submitGuestBook = createServerFn({ method: "POST" })
	.validator((input: unknown) => guestBookSchema.parse(input))
	.handler(async ({ data }) => {
		const res = await captureGuestVisit({
			clubId: data.clubId,
			name: data.name,
			email: data.email || null,
			phone: data.phone || null,
		});
		return { ok: true as const, created: res.created };
	});

/** The club's guest pipeline (all stages, derived visits). AUTHED — admin-only. */
export const getGuestPipeline = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubAdminView(currentUser.id, clubId);
		return loadGuestPipeline(clubId);
	});

const setStageSchema = z.object({
	clubId: uuid,
	guestId: uuid,
	stage: z.enum(["prospect", "following_up", "lost"]),
});

/** Manually move a guest between prospect/following_up/lost. AUTHED — admin. */
export const setGuestStage = createServerFn({ method: "POST" })
	.validator((input: unknown) => setStageSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return applySetGuestStage(data);
	});

const updateGuestSchema = z.object({
	clubId: uuid,
	guestId: uuid,
	name: z.string().trim().min(1, "A guest name is required."),
	email: z.string().trim().email().nullable().optional(),
	phone: z.string().trim().nullable().optional(),
});

/**
 * Fix a guest's name / email / phone (#364). AUTHED — admin-only, the same gate
 * as `setGuestStage` / `convertGuestToMember` (a guest record is officer data;
 * nothing here is offered on the public guest-book/self-serve views).
 */
export const updateGuest = createServerFn({ method: "POST" })
	.validator((input: unknown) => updateGuestSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return applyUpdateGuest(data);
	});

const deleteGuestSchema = z.object({
	clubId: uuid,
	guestId: uuid,
	actorMemberId: uuid.nullable().optional(),
});

/**
 * Delete a guest added by mistake (#364): any slots they hold are reset to Open
 * (logged), then the row goes. A guest already converted to a member is
 * rejected. AUTHED — admin-only.
 */
export const deleteGuest = createServerFn({ method: "POST" })
	.validator((input: unknown) => deleteGuestSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return applyDeleteGuest({
			clubId: data.clubId,
			guestId: data.guestId,
			actorMemberId: data.actorMemberId ?? null,
		});
	});

const convertSchema = z.object({
	clubId: uuid,
	guestId: uuid,
	actorMemberId: uuid.nullable().optional(),
});

/**
 * Convert a guest to a club member: dedup/link the Person, create the
 * Membership, re-point the guest's role slots, freeze the guest at stage=joined
 * with its membership pointer, and log the change. AUTHED — admin-only.
 */
export const convertGuestToMember = createServerFn({ method: "POST" })
	.validator((input: unknown) => convertSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return applyConvertGuestToMember({
			clubId: data.clubId,
			guestId: data.guestId,
			actorMemberId: data.actorMemberId ?? null,
		});
	});
