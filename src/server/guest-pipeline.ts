import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireClubRole, requireUser } from "./guards";
import {
	applyConvertGuestToMember,
	applySetGuestStage,
	captureGuestVisit,
	loadGuestPipeline,
} from "./guest-pipeline-logic";

// The db-touching logic lives in `guest-pipeline-logic.ts` (never imported by
// client routes) so it can't drag `#/db` → `pg` into the browser bundle. This
// module exports ONLY createServerFns + types — see `server-modules.guard.test.ts`.
export type {
	CaptureGuestResult,
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
		await requireClubRole(currentUser.id, clubId, ["admin"]);
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
