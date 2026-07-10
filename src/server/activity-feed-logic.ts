// Activity-feed DB logic, split out from the createServerFn wrapper in
// `activity-feed.ts` for the same reason as `members-logic.ts`: `activity-feed.ts`
// is imported by the client activity route (for `listActivity`), so a plain
// db-touching export sitting beside the server fn would drag `#/db` → `pg` →
// `Buffer` into the browser bundle. Keeping `loadActivity` here (never imported
// by client code) keeps `pg` server-side. See `members-logic.ts`.
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import {
	activityLog,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";

export const listActivitySchema = z.object({
	clubId: z.string().uuid(),
	meetingId: z.string().uuid().optional(),
	actorMemberId: z.string().uuid().optional(),
	limit: z.number().int().positive().max(500).optional(),
});
export type ListActivityInput = z.infer<typeof listActivitySchema>;

export interface ActivityEntry {
	id: string;
	action: string;
	createdAt: Date;
	actorName: string | null;
	targetType: "slot" | "meeting" | "member";
	roleName: string | null;
	meetingId: string | null;
	meetingScheduledAt: Date | null;
	/** claim/reassign → new assignee; member_add → added name */
	subjectName: string | null;
	/** reassign/release → displaced assignee (see slots.ts detail.fromMemberId) */
	fromName: string | null;
	/** meeting_edit → agenda-structure change (speaker_added | speaker_removed | speaker_reordered | role_added | role_removed | template_sync) */
	change: string | null;
}

type LogDetail = {
	memberId?: string;
	fromMemberId?: string;
	name?: string;
	change?: string;
};

/**
 * Read + enrich the activity log for a club (newest first), optionally filtered
 * by meeting and/or actor member. Plain function (no auth, no request context)
 * so it is directly testable; `listActivity` wraps it with the VPE-only guard.
 */
export async function loadActivity(
	input: ListActivityInput,
): Promise<ActivityEntry[]> {
	const where = [eq(activityLog.clubId, input.clubId)];
	if (input.actorMemberId) {
		where.push(eq(activityLog.actorMemberId, input.actorMemberId));
	}
	if (input.meetingId) {
		// A meeting's activity = the meeting itself (availability actions) plus
		// its slots (slot actions). member_add etc. (no meeting) are excluded.
		const slotIds = (
			await db
				.select({ id: roleSlots.id })
				.from(roleSlots)
				.where(eq(roleSlots.meetingId, input.meetingId))
		).map((s) => s.id);
		where.push(inArray(activityLog.targetId, [input.meetingId, ...slotIds]));
	}

	const rows = await db
		.select()
		.from(activityLog)
		.where(and(...where))
		.orderBy(desc(activityLog.createdAt))
		.limit(input.limit ?? 200);

	// Batch-resolve every id the rows reference.
	const memberIds = new Set<string>();
	const slotIds = new Set<string>();
	const meetingIds = new Set<string>();
	for (const r of rows) {
		if (r.actorMemberId) memberIds.add(r.actorMemberId);
		const d = (r.detail ?? {}) as LogDetail;
		if (d.memberId) memberIds.add(d.memberId);
		if (d.fromMemberId) memberIds.add(d.fromMemberId);
		if (r.targetType === "slot" && r.targetId) slotIds.add(r.targetId);
		if (r.targetType === "member" && r.targetId) memberIds.add(r.targetId);
		if (r.targetType === "meeting" && r.targetId) meetingIds.add(r.targetId);
	}

	const slotRows = slotIds.size
		? await db
				.select({
					id: roleSlots.id,
					meetingId: roleSlots.meetingId,
					roleName: roleDefinitions.name,
				})
				.from(roleSlots)
				.innerJoin(
					roleDefinitions,
					eq(roleDefinitions.id, roleSlots.roleDefinitionId),
				)
				.where(inArray(roleSlots.id, [...slotIds]))
		: [];
	for (const s of slotRows) meetingIds.add(s.meetingId);

	const memberRows = memberIds.size
		? await db
				.select({ id: members.id, name: members.name })
				.from(members)
				.where(inArray(members.id, [...memberIds]))
		: [];
	const meetingRows = meetingIds.size
		? await db
				.select({ id: meetings.id, scheduledAt: meetings.scheduledAt })
				.from(meetings)
				.where(inArray(meetings.id, [...meetingIds]))
		: [];

	const memberName = new Map(memberRows.map((m) => [m.id, m.name]));
	const slotInfo = new Map(slotRows.map((s) => [s.id, s]));
	const meetingAt = new Map(meetingRows.map((m) => [m.id, m.scheduledAt]));

	return rows.map((r): ActivityEntry => {
		const d = (r.detail ?? {}) as LogDetail;
		const slot =
			r.targetType === "slot" && r.targetId
				? slotInfo.get(r.targetId)
				: undefined;
		const meetingId =
			slot?.meetingId ?? (r.targetType === "meeting" ? r.targetId : null);
		return {
			id: r.id,
			action: r.action,
			createdAt: r.createdAt,
			actorName: r.actorMemberId
				? (memberName.get(r.actorMemberId) ?? null)
				: null,
			targetType: r.targetType as ActivityEntry["targetType"],
			roleName: slot?.roleName ?? null,
			meetingId: meetingId ?? null,
			meetingScheduledAt: meetingId ? (meetingAt.get(meetingId) ?? null) : null,
			subjectName: d.memberId
				? (memberName.get(d.memberId) ?? null)
				: (d.name ?? null),
			fromName: d.fromMemberId
				? (memberName.get(d.fromMemberId) ?? null)
				: null,
			change: d.change ?? null,
		};
	});
}
