import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "#/db";
import { isDemoClub } from "./demo-club-flag";
import { requireClubAdminView, requireClubRole, requireUser } from "./guards";
import type { GuestLinkExpected } from "./guest-pipeline-logic";
import {
	applyAddGuestToClub,
	applyConvertGuestToMember,
	applyDeleteGuest,
	applyLinkGuestAcrossClubs,
	applyLinkGuestToMember,
	applyRecordGuestInvite,
	applySeparateGuest,
	applySetGuestStage,
	applyUndoGuestConversion,
	applyUnlinkGuestFromMember,
	applyUpdateGuest,
	captureGuestVisit,
	listGuestLinkCandidates as listGuestLinkCandidatesLogic,
	loadGuestPipeline,
	loadLinkCandidates,
	loadOtherAdminClubs,
	previewGuestLink as previewGuestLinkLogic,
} from "./guest-pipeline-logic";
import {
	guestBookSchema,
	recordGuestInviteSchema,
	updateGuestSchema,
} from "./guest-pipeline-schemas";
import { loadNextMeetingSummary } from "./meetings-logic";

// The db-touching logic lives in `guest-pipeline-logic.ts` (never imported by
// client routes) so it can't drag `#/db` → `pg` into the browser bundle. This
// module exports ONLY createServerFns + types — see `server-modules.guard.test.ts`.
export type {
	CaptureGuestResult,
	DeleteGuestResult,
	GuestLinkCandidate,
	GuestLinkExpected,
	GuestLinkPreview,
	GuestStage,
	LinkCandidate,
	ManualGuestStage,
	PipelineGuestRow,
} from "./guest-pipeline-logic";
export type { NextMeetingSummary } from "./meetings-logic";

const uuid = z.string().uuid();

/**
 * Guest-book capture (the public #239 front door). PUBLIC — no session required,
 * mirroring `getPublicSeasonGrid`: anyone at the meeting with the club link may
 * self-register. (It used to name `addMember` alongside it; that public roster
 * self-add was admin-gated at #616 and deleted at #630 — a visitor's door is the
 * guest book, not the roster.) Create-or-find by email→name-qualified phone
 * (#488) + record a visit
 * against the club's current/nearest meeting.
 */
export const submitGuestBook = createServerFn({ method: "POST" })
	.validator((input: unknown) => guestBookSchema.parse(input))
	.handler(async ({ data }) => {
		// The demo club keeps no guest data (#1199): answer as a success and write
		// nothing, so a presenter can fill the form on stage and nobody's name or
		// number is stored. Officer-entered guests go through other writers.
		if (await isDemoClub(db, data.clubId)) {
			return { ok: true as const, created: true };
		}
		const res = await captureGuestVisit({
			clubId: data.clubId,
			name: data.name,
			email: data.email || null,
			phone: data.phone || null,
		});
		return { ok: true as const, created: res.created };
	});

/**
 * The club's guest pipeline (all stages, derived visits). AUTHED — admin-only.
 * Each row also says whether another club holds the guest's Person, and which of
 * the VIEWER's other admin clubs it could be added to (#1127).
 */
export const getGuestPipeline = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubAdminView(currentUser.id, clubId);
		const others = await loadOtherAdminClubs(currentUser.id, clubId);
		return loadGuestPipeline(
			clubId,
			others.map((c) => c.clubId),
		);
	});

/**
 * The clubs other than this one where the viewer is an admin or an elected
 * officer (#1127): the "Add to <club>" menu items and the picker's club choice.
 * AUTHED — the same read gate as `getGuestPipeline`; it names only the viewer's
 * own clubs.
 */
export const getOtherAdminClubs = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubAdminView(currentUser.id, clubId);
		return loadOtherAdminClubs(currentUser.id, clubId);
	});

/**
 * What the VPM page needs to draft an invite (#899): the club's timezone and its
 * next non-cancelled meeting, slim — never `join_url` (see
 * `loadNextMeetingSummary`). AUTHED — the same gate as `getGuestPipeline`.
 */
export const getGuestInviteContext = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubAdminView(currentUser.id, clubId);
		return loadNextMeetingSummary(clubId, new Date());
	});

/**
 * Record that this officer opened an invite draft for a guest to the next
 * meeting (#899). Nothing is sent — the human sends. AUTHED — admin, like every
 * other guest write; the actor is the resolved membership, never input.
 */
export const recordGuestInvite = createServerFn({ method: "POST" })
	.validator((input: unknown) => recordGuestInviteSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		const membership = await requireClubRole(currentUser.id, data.clubId, [
			"admin",
		]);
		return applyRecordGuestInvite({
			clubId: data.clubId,
			guestId: data.guestId,
			meetingId: data.meetingId,
			actorMemberId: membership.id,
		});
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
	// The address the officer confirmed for a guest whose only address was typed on
	// the public guest book (#1157). Absent or null leaves it off, so a tab opened
	// before this field existed fails closed.
	confirmedEmail: z.string().trim().email().max(200).nullable().optional(),
});

/**
 * Convert a guest to a club member: dedup/link the Person, create the
 * Membership, re-point the guest's role slots, freeze the guest at stage=joined
 * with its membership pointer, and log the change. AUTHED — admin-only.
 *
 * Returns `applyConvertGuestToMember`'s result whole, `reactivated` included
 * (#501) — the flag saying convert reused a LAPSED membership and woke it. The
 * VP-Membership board is the only call site and turns it into a one-line notice
 * on the existing success toast; a handler that picked fields off the result
 * would be where that flag silently stopped reaching the admin.
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
			confirmedEmail: data.confirmedEmail,
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

const addToClubSchema = z.object({
	fromClubId: uuid,
	guestId: uuid,
	toClubId: uuid,
});

/**
 * Add this club's guest to another club the officer also runs (#1127): a
 * `prospect` row there on the same Person. AUTHED — admin of BOTH clubs; the
 * logic asks `requireClubRole` of each, so a single-club admin naming a second
 * club is refused. The session's user is the actor, never the payload.
 */
export const addGuestToClub = createServerFn({ method: "POST" })
	.validator((input: unknown) => addToClubSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		return applyAddGuestToClub({ userId: currentUser.id, ...data });
	});

/**
 * Give this guest a Person of their own again when another club holds the one
 * they share (#1127). AUTHED — admin of THIS club only, by the maintainer's
 * decision.
 */
export const separateGuest = createServerFn({ method: "POST" })
	.validator((input: unknown) => deleteGuestSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		return applySeparateGuest({ userId: currentUser.id, ...data });
	});

const guestLinkSchema = z.object({
	clubId: uuid,
	guestId: uuid,
	otherClubId: uuid,
	otherGuestId: uuid,
});

/** Declared once, so the link's `expected` is parsed in the shape the preview
 *  returns it in (`GuestLinkExpected`, which the `satisfies` ties to this). */
const guestLinkExpectedSchema = z.object({
	absorbed: z.enum(["this", "other"]),
	keeperPersonId: uuid,
	absorbedPersonId: uuid,
	basis: z.object({
		thisEmail: z.string().nullable(),
		thisPhone: z.string(),
		otherEmail: z.string().nullable(),
		otherPhone: z.string(),
	}),
}) satisfies z.ZodType<GuestLinkExpected>;

/**
 * The picker behind "Same person as…" (#1175): up to 20 of the other club's
 * guests by name, email and phone only. AUTHED — admin of BOTH clubs
 * (`requireAdminOfBothClubs` in the logic). The session's user is the actor.
 */
export const listGuestLinkCandidates = createServerFn({ method: "GET" })
	.validator((input: unknown) =>
		guestLinkSchema
			.omit({ otherGuestId: true })
			.extend({ q: z.string().max(200) })
			.parse(input),
	)
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		return listGuestLinkCandidatesLogic({ userId: currentUser.id, ...data });
	});

/**
 * What linking two guests would leave, or why it cannot (#1175). AUTHED — admin
 * of BOTH clubs. A read: nothing is written.
 */
export const previewGuestLink = createServerFn({ method: "GET" })
	.validator((input: unknown) => guestLinkSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		return previewGuestLinkLogic({ userId: currentUser.id, ...data });
	});

/**
 * Link this club's guest to one of the other club's: one Person, kept by the
 * side that can absorb the other (#1175). AUTHED — admin of BOTH clubs, asked
 * again under the locks. `expected` is what the preview returned; a record that
 * changed since is refused.
 */
export const linkGuestAcrossClubs = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		guestLinkSchema.extend({ expected: guestLinkExpectedSchema }).parse(input),
	)
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		return applyLinkGuestAcrossClubs({ userId: currentUser.id, ...data });
	});
