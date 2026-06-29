import { createServerFn } from "@tanstack/react-start";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { members } from "#/db/schema";
import { logActivity } from "./activity";

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
