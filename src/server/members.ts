import { createServerFn } from "@tanstack/react-start";
import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { members, people } from "#/db/schema";
import { logActivity } from "./activity";
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
	mergeSchema,
	removeSchema,
	setRoleSchema,
	setStatusSchema,
} from "./members-logic";
import { currentOfficersByMember } from "./officer-terms-logic";

/** List all ACTIVE roster members for a club (member-facing picker). Inactive
 *  members are hidden here; the VPE roster manager loads them separately. Each
 *  row carries its current office(s) derived from open officer terms (#100).
 *  PUBLIC — no session required. */
export const listMembers = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => z.string().uuid().parse(clubId))
	.handler(async ({ data: clubId }) => {
		const roster = await db
			.select({ id: members.id, name: members.name })
			.from(members)
			.where(and(eq(members.clubId, clubId), ne(members.status, "inactive")))
			.orderBy(asc(members.name));
		const officers = await currentOfficersByMember(roster.map((m) => m.id));
		return roster.map((m) => ({
			id: m.id,
			name: m.name,
			officerPositions: officers.get(m.id) ?? [],
		}));
	});

const addMemberSchema = z.object({
	clubId: z.string().uuid(),
	name: z.string().trim().min(1),
});

/** Add a new roster member to a club. PUBLIC — no session required (self-add). */
export const addMember = createServerFn({ method: "POST" })
	.validator((i: unknown) => addMemberSchema.parse(i))
	.handler(async ({ data }) => {
		// Every membership belongs to a person (ADR-0008). A self-add is a new
		// person; dedupe/merge is a later, deliberate action.
		const [person] = await db
			.insert(people)
			.values({ name: data.name })
			.returning({ id: people.id });
		if (!person) throw new Error("Failed to insert person.");
		const [m] = await db
			.insert(members)
			.values({ clubId: data.clubId, personId: person.id, name: data.name })
			.returning({ id: members.id });
		if (!m) throw new Error("Failed to insert member.");
		await logActivity(db, {
			clubId: data.clubId,
			actorMemberId: m.id,
			action: "member_add",
			targetType: "member",
			targetId: m.id,
			detail: { name: data.name },
		});
		return { id: m.id };
	});

// ---------------------------------------------------------------------------
// VPE roster management (authed). The DB logic lives in `members-logic.ts` so
// it stays out of the client bundle (this module is imported by the app shell;
// the compiler strips these handlers but not stray db-touching exports).
// ---------------------------------------------------------------------------

export const editMember = createServerFn({ method: "POST" })
	.validator((i: unknown) => editSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return applyMemberEdit(data);
	});

export const mergeMembers = createServerFn({ method: "POST" })
	.validator((i: unknown) => mergeSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return applyMemberMerge(data);
	});

export const removeMember = createServerFn({ method: "POST" })
	.validator((i: unknown) => removeSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return applyMemberRemove(data);
	});

/** Toggle a roster member active/inactive (NOT deletion — see removeMember). */
export const setMemberStatus = createServerFn({ method: "POST" })
	.validator((i: unknown) => setStatusSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return applySetMemberStatus(data);
	});

/** Promote/demote a member's club role (admin ⇄ member). Admin-only; the logic
 *  keeps the club's ≥1-active-admin invariant and logs the change (#187). */
export const setMemberRole = createServerFn({ method: "POST" })
	.validator((i: unknown) => setRoleSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return applySetMemberRole(data);
	});

export const bulkImportMembers = createServerFn({ method: "POST" })
	.validator((i: unknown) => bulkImportSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return applyBulkImport(data);
	});
