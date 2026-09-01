import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireClubAdminView, requireClubRole, requireUser } from "./guards";
import {
	applyConvertGuestToMember,
	applyDeleteGuest,
	applyLinkGuestToMember,
	applySetGuestStage,
	applyUndoGuestConversion,
	applyUnlinkGuestFromMember,
	applyUpdateGuest,
	captureGuestVisit,
	loadGuestPipeline,
	loadLinkCandidates,
} from "./guest-pipeline-logic";
import { guestBookSchema } from "./guest-pipeline-schemas";

// The db-touching logic lives in `guest-pipeline-logic.ts` (never imported by
// client routes) so it can't drag `#/db` → `pg` into the browser bundle. This
// module exports ONLY createServerFns + types — see `server-modules.guard.test.ts`.
export type {
	CaptureGuestResult,
	DeleteGuestResult,
	GuestStage,
	LinkCandidate,
	ManualGuestStage,
	PipelineGuestRow,
} from "./guest-pipeline-logic";

const uuid = z.string().uuid();

/**
 * Guest-book capture (the public #239 front door). PUBLIC — no session required,
 * mirroring `addMember`/`getPublicSeasonGrid`: anyone at the meeting with the
 * club link may self-register. Create-or-find by email→name-qualified phone
 * (#488) + record a visit
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
	// What they're called, when it isn't the first token of `name` (#486).
	// Omitting it clears it, same as `email`/`phone`. Capped to match the member
	// path, which carries this value onto the shared `people` row on conversion.
	preferredName: z.string().trim().max(80).nullable().optional(),
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
		// Actor = the admin membership resolved from the session (#396).
		const membership = await requireClubRole(currentUser.id, data.clubId, [
			"admin",
		]);
		return applyDeleteGuest({
			clubId: data.clubId,
			guestId: data.guestId,
			actorMemberId: membership.id,
		});
	});

const convertSchema = z.object({
	clubId: uuid,
	guestId: uuid,
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
		// Actor = the admin membership resolved from the session (#396).
		const membership = await requireClubRole(currentUser.id, data.clubId, [
			"admin",
		]);
		return applyConvertGuestToMember({
			clubId: data.clubId,
			guestId: data.guestId,
			actorMemberId: membership.id,
		});
	});

const linkSchema = z.object({
	clubId: uuid,
	guestId: uuid,
	memberId: uuid,
});

/**
 * Link an existing guest to an existing roster member (#635) — the retroactive
 * convert for someone who became a member without going through
 * `convertGuestToMember`. Re-points the guest's slots, freezes the guest at
 * stage=joined pointing at that membership, and records the moved slot ids so
 * the link can be undone. AUTHED — admin-only, same gate as convert.
 */
export const linkGuestToMember = createServerFn({ method: "POST" })
	.validator((input: unknown) => linkSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		const membership = await requireClubRole(currentUser.id, data.clubId, [
			"admin",
		]);
		return applyLinkGuestToMember({
			clubId: data.clubId,
			guestId: data.guestId,
			memberId: data.memberId,
			actorMemberId: membership.id,
		});
	});

const unlinkSchema = z.object({
	clubId: uuid,
	guestId: uuid,
});

/** Reverse a link (#635), restoring exactly the slots it moved. AUTHED — admin. */
export const unlinkGuestFromMember = createServerFn({ method: "POST" })
	.validator((input: unknown) => unlinkSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		const membership = await requireClubRole(currentUser.id, data.clubId, [
			"admin",
		]);
		return applyUnlinkGuestFromMember({
			clubId: data.clubId,
			guestId: data.guestId,
			actorMemberId: membership.id,
		});
	});

/**
 * Undo a convert-to-member (#618). AUTHED — admin-only, like convert itself:
 * it can delete a roster row.
 *
 * Reuses `unlinkSchema` because the input is the same pair (club, guest) — a
 * third identical schema would be a place for the two to drift.
 */
export const undoGuestConversion = createServerFn({ method: "POST" })
	.validator((input: unknown) => unlinkSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		const membership = await requireClubRole(currentUser.id, data.clubId, [
			"admin",
		]);
		return applyUndoGuestConversion({
			clubId: data.clubId,
			guestId: data.guestId,
			actorMemberId: membership.id,
		});
	});

/**
 * The club roster annotated for the link dialog (#635): which members' names
 * agree with this guest's, and which already hold a role at a meeting where the
 * guest does. AUTHED — admin-only: it enumerates roster names against a guest
 * record, which is officer data on both sides.
 */
export const getLinkCandidates = createServerFn({ method: "GET" })
	.validator((input: unknown) => unlinkSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return loadLinkCandidates({
			clubId: data.clubId,
			guestId: data.guestId,
		});
	});
