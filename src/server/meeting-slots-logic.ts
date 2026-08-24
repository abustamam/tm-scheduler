// src/server/meeting-slots-logic.ts
//
// ONE loader for a meeting's role slots.
//
// Extracted verbatim from `loadMeetingDetail` (meetings.ts) when the agenda
// editor needed the same rows. The alternative was a second, narrower query
// scoped to what the editor reads — and that is exactly the divergence this
// repo keeps paying for elsewhere: the editor computes its running clock by
// calling `resolveAgendaRows` on these slots, the print route calls it on
// `loadMeetingDetail`'s, and if the two disagree about what a slot IS, the two
// surfaces disagree about what time the meeting ends. A parity test cannot see
// a defect present on both sides, so the fix is to have one side.
//
// The returned row is WIDER than `AgendaSlot` (it carries `roleDefinitionId`,
// `status`, `claimedAt`, the Pathways triple and the presentation URL, none of
// which the agenda derivation reads). That is deliberate: `AgendaSlot` is
// satisfied structurally, so this one loader serves both the meeting page's
// full needs and the editor's narrow ones without a mapping layer that could
// drop a field.
import { asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "#/db";
import {
	guests,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import { resolveEvaluatorLinks } from "#/lib/agenda";

/**
 * A meeting's slots, ordered by role then slot index, with the assignee
 * resolved from either a member or a guest and each evaluator linked to the
 * speaker it evaluates.
 */
export async function loadMeetingSlots(meetingId: string) {
	const assignee = alias(members, "assignee");
	const guestAssignee = alias(guests, "assignee_guest");
	const rows = await db
		.select({
			id: roleSlots.id,
			roleDefinitionId: roleSlots.roleDefinitionId,
			status: roleSlots.status,
			slotIndex: roleSlots.slotIndex,
			claimedAt: roleSlots.claimedAt,
			evaluatesSlotId: roleSlots.evaluatesSlotId,
			roleName: roleDefinitions.name,
			// Stable role identity (#368) for the agenda run-of-show (#367) to bind
			// beats to by key rather than free-text name — a rename via
			// `updateClubRole` never touches this. Null for a custom club role, or
			// a standard role predating the #368 backfill.
			roleKey: roleDefinitions.key,
			category: roleDefinitions.category,
			description: roleDefinitions.description,
			sortOrder: roleDefinitions.sortOrder,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
			// assigneeId is the MEMBER id (null for a guest or open slot) — used for
			// "is mine" / roster flags. A guest assignee is carried separately.
			assigneeId: assignee.id,
			assigneeGuestId: guestAssignee.id,
			// The rendered assignee name resolves either source (#151); the caller
			// pairs it with `assigneeIsGuest` to show the "· Guest" marker.
			assigneeName: sql<
				string | null
			>`coalesce(${assignee.name}, ${guestAssignee.name})`,
			speechTitle: speeches.title,
			pathwayPath: speeches.pathwayPath,
			projectName: speeches.projectName,
			projectLevel: speeches.projectLevel,
			// Carried so the edit sheet can PRE-SELECT the linked catalog project
			// (#418) rather than reopening on a blank picker. Display still comes
			// from the free-text triple above.
			projectId: speeches.projectId,
			minMinutes: speeches.minMinutes,
			maxMinutes: speeches.maxMinutes,
			presentationUrl: speeches.presentationUrl,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.leftJoin(assignee, eq(assignee.id, roleSlots.assignedMemberId))
		.leftJoin(guestAssignee, eq(guestAssignee.id, roleSlots.assignedGuestId))
		.leftJoin(speeches, eq(speeches.id, roleSlots.speechId))
		.where(eq(roleSlots.meetingId, meetingId))
		.orderBy(asc(roleDefinitions.sortOrder), asc(roleSlots.slotIndex));

	// Flag guest-held slots so every read path can render the "· Guest" marker.
	const rowsWithGuestFlag = rows.map((r) => ({
		...r,
		assigneeIsGuest: r.assigneeGuestId != null,
	}));

	// Resolve which speaker each evaluator slot evaluates.
	return resolveEvaluatorLinks(rowsWithGuestFlag);
}

export type MeetingSlot = Awaited<ReturnType<typeof loadMeetingSlots>>[number];
