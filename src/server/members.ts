import { createServerFn } from "@tanstack/react-start";
import { and, asc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import {
	activityLog,
	meetings,
	memberAvailability,
	members,
	roleSlots,
	speakerDetails,
} from "#/db/schema";
import { logActivity } from "./activity";
import { requireClubRole, requireUser } from "./guards";

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
// VPE roster management (authed). Each createServerFn wraps a plain `applyX`
// fn so the DB logic is directly testable (the wrappers need the Start runtime).
// ---------------------------------------------------------------------------

const editSchema = z.object({
	clubId: z.string().uuid(),
	memberId: z.string().uuid(),
	actorMemberId: z.string().uuid().nullable().optional(),
	name: z.string().trim().min(1),
	email: z.string().trim().email().nullable().optional(),
	phone: z.string().trim().nullable().optional(),
	office: z.string().trim().nullable().optional(),
});
type EditInput = z.infer<typeof editSchema>;

/** Update a roster member's name/contact/office; logs member_edit. */
export async function applyMemberEdit(input: EditInput) {
	const [current] = await db
		.select()
		.from(members)
		.where(
			and(eq(members.id, input.memberId), eq(members.clubId, input.clubId)),
		);
	if (!current) throw new Error("Member not found.");
	const next = {
		name: input.name,
		email: input.email ?? null,
		phone: input.phone ?? null,
		office: input.office ?? null,
	};
	await db.transaction(async (tx) => {
		await tx.update(members).set(next).where(eq(members.id, input.memberId));
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: input.actorMemberId ?? null,
			action: "member_edit",
			targetType: "member",
			targetId: input.memberId,
			detail: {
				before: {
					name: current.name,
					email: current.email,
					phone: current.phone,
					office: current.office,
				},
				after: next,
			},
		});
	});
	return { ok: true as const };
}

export const editMember = createServerFn({ method: "POST" })
	.validator((i: unknown) => editSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin", "vpe"]);
		return applyMemberEdit(data);
	});

const mergeSchema = z.object({
	clubId: z.string().uuid(),
	keeperId: z.string().uuid(),
	absorbedId: z.string().uuid(),
	actorMemberId: z.string().uuid().nullable().optional(),
});
type MergeInput = z.infer<typeof mergeSchema>;

/** Merge an absorbed member into a keeper: re-point assignments, availability
 *  (dedupe meeting conflicts), and activity history; delete the absorbed; log
 *  member_merge. A user-linked member may not be absorbed. */
export async function applyMemberMerge(input: MergeInput) {
	const { clubId, keeperId, absorbedId } = input;
	if (keeperId === absorbedId) {
		throw new Error("Pick two different members to merge.");
	}
	const rows = await db
		.select()
		.from(members)
		.where(
			and(
				inArray(members.id, [keeperId, absorbedId]),
				eq(members.clubId, clubId),
			),
		);
	const keeper = rows.find((m) => m.id === keeperId);
	const absorbed = rows.find((m) => m.id === absorbedId);
	if (!keeper || !absorbed) throw new Error("Member not found in this club.");
	if (absorbed.userId) {
		throw new Error(
			"That member is a signed-in account — merge the other direction (keep it).",
		);
	}

	await db.transaction(async (tx) => {
		// 1. Role assignments → keeper (multiple slots per member allowed).
		await tx
			.update(roleSlots)
			.set({ assignedMemberId: keeperId })
			.where(eq(roleSlots.assignedMemberId, absorbedId));
		// 2. Availability → keeper, dropping meetings the keeper already covers.
		await tx.execute(
			sql`DELETE FROM member_availability WHERE member_id = ${absorbedId}
				AND meeting_id IN (SELECT meeting_id FROM member_availability WHERE member_id = ${keeperId})`,
		);
		await tx
			.update(memberAvailability)
			.set({ memberId: keeperId })
			.where(eq(memberAvailability.memberId, absorbedId));
		// 3. Activity history → keeper (actor column + jsonb subject refs); drop
		//    the absorbed member's own member_add row.
		await tx
			.update(activityLog)
			.set({ actorMemberId: keeperId })
			.where(eq(activityLog.actorMemberId, absorbedId));
		await tx.execute(
			sql`UPDATE activity_log SET detail = jsonb_set(detail, '{memberId}', ${`"${keeperId}"`}::jsonb)
				WHERE club_id = ${clubId} AND detail->>'memberId' = ${absorbedId}`,
		);
		await tx.execute(
			sql`UPDATE activity_log SET detail = jsonb_set(detail, '{fromMemberId}', ${`"${keeperId}"`}::jsonb)
				WHERE club_id = ${clubId} AND detail->>'fromMemberId' = ${absorbedId}`,
		);
		await tx
			.delete(activityLog)
			.where(
				and(
					eq(activityLog.targetType, "member"),
					eq(activityLog.targetId, absorbedId),
				),
			);
		// 4. Delete the absorbed member.
		await tx.delete(members).where(eq(members.id, absorbedId));
		// 5. Log the merge.
		await logActivity(tx, {
			clubId,
			actorMemberId: input.actorMemberId ?? null,
			action: "member_merge",
			targetType: "member",
			targetId: keeperId,
			detail: {
				absorbedId,
				absorbedName: absorbed.name,
				keeperName: keeper.name,
			},
		});
	});
	return { ok: true as const };
}

export const mergeMembers = createServerFn({ method: "POST" })
	.validator((i: unknown) => mergeSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin", "vpe"]);
		return applyMemberMerge(data);
	});

const removeSchema = z.object({
	clubId: z.string().uuid(),
	memberId: z.string().uuid(),
	actorMemberId: z.string().uuid().nullable().optional(),
});
type RemoveInput = z.infer<typeof removeSchema>;

/** Remove a member: release their upcoming, non-cancelled slots (logged) then
 *  delete them (availability cascades). A user-linked member can't be removed. */
export async function applyMemberRemove(input: RemoveInput) {
	const [member] = await db
		.select()
		.from(members)
		.where(
			and(eq(members.id, input.memberId), eq(members.clubId, input.clubId)),
		);
	if (!member) throw new Error("Member not found.");
	if (member.userId) {
		throw new Error("That member is a signed-in account and can't be removed.");
	}

	await db.transaction(async (tx) => {
		const upcoming = await tx
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(
				and(
					eq(roleSlots.assignedMemberId, input.memberId),
					gte(meetings.scheduledAt, new Date()),
					ne(meetings.status, "cancelled"),
				),
			);
		for (const s of upcoming) {
			await tx.delete(speakerDetails).where(eq(speakerDetails.slotId, s.id));
			await tx
				.update(roleSlots)
				.set({ assignedMemberId: null, status: "open", claimedAt: null })
				.where(eq(roleSlots.id, s.id));
			await logActivity(tx, {
				clubId: input.clubId,
				actorMemberId: input.actorMemberId ?? null,
				action: "release",
				targetType: "slot",
				targetId: s.id,
				detail: { fromMemberId: input.memberId },
			});
		}
		await tx.delete(members).where(eq(members.id, input.memberId));
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: input.actorMemberId ?? null,
			action: "member_remove",
			targetType: "member",
			targetId: input.memberId,
			detail: { name: member.name },
		});
	});
	return { ok: true as const };
}

export const removeMember = createServerFn({ method: "POST" })
	.validator((i: unknown) => removeSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin", "vpe"]);
		return applyMemberRemove(data);
	});
