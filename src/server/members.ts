import { createServerFn } from "@tanstack/react-start";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { members } from "#/db/schema";
import { logActivity } from "./activity";
import { requireClubRole, requireUser } from "./guards";
import {
	applyMemberEdit,
	applyMemberMerge,
	applyMemberRemove,
	editSchema,
	mergeSchema,
	removeSchema,
} from "./members-logic";

/** List all roster members for a club. PUBLIC — no session required. */
export const listMembers = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => z.string().uuid().parse(clubId))
	.handler(async ({ data: clubId }) =>
		db
			.select({ id: members.id, name: members.name, office: members.office })
			.from(members)
			.where(eq(members.clubId, clubId))
			.orderBy(asc(members.name)),
	);

const addMemberSchema = z.object({
	clubId: z.string().uuid(),
	name: z.string().trim().min(1),
});

/** Add a new roster member to a club. PUBLIC — no session required (self-add). */
export const addMember = createServerFn({ method: "POST" })
	.validator((i: unknown) => addMemberSchema.parse(i))
	.handler(async ({ data }) => {
		const [m] = await db
			.insert(members)
			.values({ clubId: data.clubId, name: data.name })
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
		await requireClubRole(user.id, data.clubId, ["admin", "vpe"]);
		return applyMemberEdit(data);
	});

export const mergeMembers = createServerFn({ method: "POST" })
	.validator((i: unknown) => mergeSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin", "vpe"]);
		return applyMemberMerge(data);
	});

export const removeMember = createServerFn({ method: "POST" })
	.validator((i: unknown) => removeSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin", "vpe"]);
		return applyMemberRemove(data);
	});
