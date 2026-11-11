import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireClubRole, requireUser } from "./guards";
import {
	applyMergeGuests,
	listMergeGuestCandidates as listMergeGuestCandidatesLogic,
	previewMergeGuests as previewMergeGuestsLogic,
} from "./guest-merge-logic";

// The db-touching logic lives in `guest-merge-logic.ts` (never imported by
// client code) so it cannot drag `#/db` into the browser bundle. This module
// exports ONLY createServerFns + types (`server-modules.guard.test.ts`).
export type {
	MergeGuestCandidate,
	MergeGuestsPreview,
} from "./guest-merge-logic";

const uuid = z.string().uuid();

const mergeSchema = z.object({
	clubId: uuid,
	keepGuestId: uuid,
	absorbGuestId: uuid,
});

/**
 * Fold one guest record of this club into another (#1609). AUTHED, admin-only,
 * archive-gated (`requireClubRole`, asked again under the locks). IRREVERSIBLE.
 * Not the superadmin's Person merge: see `guest-merge-logic.ts`.
 *
 * `method: "POST"` like `deleteGuest`; changing it would break open tabs.
 */
export const mergeGuests = createServerFn({ method: "POST" })
	.validator((input: unknown) => mergeSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return applyMergeGuests({ ...data, actorUserId: currentUser.id });
	});

/**
 * What the merge would move and drop, and the refusal if it would not run. The
 * same code as the apply, in a transaction that rolls back. AUTHED, admin-only.
 */
export const previewMergeGuests = createServerFn({ method: "POST" })
	.validator((input: unknown) => mergeSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return previewMergeGuestsLogic({ ...data, actorUserId: currentUser.id });
	});

/** The picker behind "Merge with another guest…": the club's other guests,
 *  name, kind and stage only. AUTHED, admin-only. */
export const listMergeGuestCandidates = createServerFn({ method: "GET" })
	.validator((input: unknown) =>
		z.object({ clubId: uuid, guestId: uuid }).parse(input),
	)
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return listMergeGuestCandidatesLogic(data);
	});
