import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetingOutreach, meetings } from "#/db/schema";
import { logActivity } from "./activity";
import { requireClubRole, requireMemberInClub, requireUser } from "./guards";
import { assertMeetingNotLocked } from "./meeting-authz-logic";

/** Load a meeting's status (for the ADR-0012 lock) or throw if missing. */
async function meetingStatus(meetingId: string): Promise<string> {
	const [row] = await db
		.select({ status: meetings.status })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!row) throw new Error("Meeting not found.");
	return row.status;
}

const contactedSchema = z.object({
	memberId: z.string().uuid(),
	meetingId: z.string().uuid(),
	clubId: z.string().uuid(),
	/** How the ask happened. Recorded in activity_log.detail only. */
	via: z.enum(["nudge", "manual"]).default("manual"),
});

/**
 * Mark a member "contacted" for a meeting (#340). Admin/VPE-only officer record
 * (unlike the self-serve setAvailability). Presence of the row = contacted;
 * idempotent via onConflictDoNothing. The actor is the resolved officer
 * membership — never trusted from the client. `membership.id` is null under a
 * read_write impersonation session; `logActivity` attributes that case to the
 * impersonating superadmin automatically (via the request-scoped marker set by
 * `requireClubRole`), so passing it straight through as `actorMemberId` is safe.
 */
export const setContacted = createServerFn({ method: "POST" })
	.validator((i: unknown) => contactedSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		const membership = await requireClubRole(user.id, data.clubId, ["admin"]);
		assertMeetingNotLocked(await meetingStatus(data.meetingId));
		await requireMemberInClub(data.memberId, data.clubId);

		await db
			.insert(meetingOutreach)
			.values({ memberId: data.memberId, meetingId: data.meetingId })
			.onConflictDoNothing();

		await logActivity(db, {
			clubId: data.clubId,
			actorMemberId: membership.id,
			action: "outreach_set",
			targetType: "meeting",
			targetId: data.meetingId,
			detail: { memberId: data.memberId, via: data.via },
		});

		return { ok: true as const };
	});

/** Clear a member's "contacted" mark for a meeting (#340). Admin/VPE-only. */
export const clearContacted = createServerFn({ method: "POST" })
	.validator((i: unknown) => contactedSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		const membership = await requireClubRole(user.id, data.clubId, ["admin"]);
		assertMeetingNotLocked(await meetingStatus(data.meetingId));
		await requireMemberInClub(data.memberId, data.clubId);

		await db
			.delete(meetingOutreach)
			.where(
				and(
					eq(meetingOutreach.memberId, data.memberId),
					eq(meetingOutreach.meetingId, data.meetingId),
				),
			);

		await logActivity(db, {
			clubId: data.clubId,
			actorMemberId: membership.id,
			action: "outreach_clear",
			targetType: "meeting",
			targetId: data.meetingId,
			detail: { memberId: data.memberId },
		});

		return { ok: true as const };
	});
