import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireClubRole, requireUser } from "./guards";
import {
	applyBulkImport,
	applyMemberEdit,
	applyMemberMerge,
	applyMemberRemove,
	applySetMemberRole,
	applySetMemberStatus,
	bulkImportSchema,
	editSchema,
	loadPublicClubRoster,
	mergeSchema,
	removeSchema,
	setRoleSchema,
	setStatusSchema,
} from "./members-logic";

/** List all ACTIVE roster members for a club (member-facing picker). Inactive
 *  members are hidden here; the VPE roster manager loads them separately. Each
 *  row carries its current office(s) derived from open officer terms (#100).
 *  PUBLIC — no session required, but NOT ungated: an archived club yields `[]`.
 *  The query and its archive gate live in `loadPublicClubRoster` because a
 *  `createServerFn` body is unreachable from a test (#544). */
export const listMembers = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => z.string().uuid().parse(clubId))
	.handler(async ({ data: clubId }) => loadPublicClubRoster(clubId));

// There is deliberately NO `addMember` here (#616, deleted #630). It was PUBLIC
// for a long time — no session, and nothing but a per-club rate limit between
// anyone holding the club link and a real row in the club's membership record.
// That was deliberate once (#32: "member picks their name from the roster …
// self-add if absent") and stopped being defensible when it produced a live
// incident: a guest tracked in the VP-Membership pipeline turned up in a club's
// roster, leaving two records for one human with nothing linking them.
// `members-logic.ts` never references `guests`, so the path was structurally
// blind to the pipeline. #326 capped the RATE of that write and left the
// capability, which was the part that mattered; #616 admin-gated it, which left
// a gated fn with zero call sites, and #630 removed it with its throttle.
//
// Every non-member has a door that is not this one: the guest book (#239),
// assign-guest-to-slot (#151), and the pipeline itself (#208). A genuine new
// member is added by an officer through Roster → "+ Add member", which is
// `bulkImportMembers` below. `member-write-authz.guard.test.ts` asserts the
// CLASS — no `createServerFn` may write `members` without a club-role gate — so
// the next writer cannot be anonymous by omission.

// ---------------------------------------------------------------------------
// VPE roster management (authed). The DB logic lives in `members-logic.ts` so
// it stays out of the client bundle (this module is imported by the app shell;
// the compiler strips these handlers but not stray db-touching exports).
// ---------------------------------------------------------------------------

export const editMember = createServerFn({ method: "POST" })
	.validator((i: unknown) => editSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		const membership = await requireClubRole(user.id, data.clubId, ["admin"]);
		return applyMemberEdit({ ...data, actorMemberId: membership.id });
	});

export const mergeMembers = createServerFn({ method: "POST" })
	.validator((i: unknown) => mergeSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		const membership = await requireClubRole(user.id, data.clubId, ["admin"]);
		return applyMemberMerge({ ...data, actorMemberId: membership.id });
	});

export const removeMember = createServerFn({ method: "POST" })
	.validator((i: unknown) => removeSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		const membership = await requireClubRole(user.id, data.clubId, ["admin"]);
		return applyMemberRemove({ ...data, actorMemberId: membership.id });
	});

/** Toggle a roster member active/inactive (NOT deletion — see removeMember). */
export const setMemberStatus = createServerFn({ method: "POST" })
	.validator((i: unknown) => setStatusSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		const membership = await requireClubRole(user.id, data.clubId, ["admin"]);
		return applySetMemberStatus({ ...data, actorMemberId: membership.id });
	});

/** Promote/demote a member's club role (admin ⇄ member). Admin-only; the logic
 *  keeps the club's ≥1-active-admin invariant and logs the change (#187). */
export const setMemberRole = createServerFn({ method: "POST" })
	.validator((i: unknown) => setRoleSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		const membership = await requireClubRole(user.id, data.clubId, ["admin"]);
		return applySetMemberRole({ ...data, actorMemberId: membership.id });
	});

export const bulkImportMembers = createServerFn({ method: "POST" })
	.validator((i: unknown) => bulkImportSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		const membership = await requireClubRole(user.id, data.clubId, ["admin"]);
		return applyBulkImport({ ...data, actorMemberId: membership.id });
	});
