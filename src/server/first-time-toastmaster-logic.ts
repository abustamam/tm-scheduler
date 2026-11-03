// "Is this meeting's Toastmaster a first-timer here?" (#1481). A pure query over
// `role_slots`, which is the history ("who has done what" is a query over slots
// of past meetings). In a `*-logic.ts` so integration tests call the real code
// and the client never imports it (server-bundle rule).
import { and, asc, eq, isNotNull, lt, ne } from "drizzle-orm";
import { db } from "#/db";
import { meetings, members, roleDefinitions, roleSlots } from "#/db/schema";
import { TMOD_ROLE_KEY } from "#/lib/meeting-roles";
import { greetingName } from "#/lib/person-name";
import { contactKey, loadHolderContacts } from "./meeting-contacts-logic";

export interface FirstTimeToastmaster {
	memberId: string;
	name: string;
	/** What to greet them by; never blank. */
	preferredName: string;
	/** E.164-ish, or null. Contact: officers only, see `firstTimeToastmasterFor`. */
	phone: string | null;
}

/**
 * The member holding this meeting's Toastmaster slot, when it is their first
 * at this club; null otherwise.
 *
 * "First" means NO other `role_slots` row with the same role key and member at
 * a meeting of the SAME club (a `members` row belongs to one club, so matching
 * the member id IS the same-club condition), scheduled EARLIER than this one and not
 * cancelled. Claimed and confirmed both count as held. A cancelled meeting, a
 * later meeting and another club's meetings do not count. A guest-held slot
 * never qualifies (a visiting Toastmaster is stored as `assigned_guest_id`).
 */
export async function firstTimeToastmaster(
	meetingId: string,
): Promise<FirstTimeToastmaster | null> {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, meetingId),
		columns: { clubId: true, scheduledAt: true, status: true },
	});
	if (!meeting || meeting.status === "cancelled") return null;

	const [slot] = await db
		.select({ memberId: roleSlots.assignedMemberId })
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.where(
			and(
				eq(roleSlots.meetingId, meetingId),
				eq(roleDefinitions.key, TMOD_ROLE_KEY),
				isNotNull(roleSlots.assignedMemberId),
			),
		)
		.orderBy(asc(roleSlots.slotIndex))
		.limit(1);
	const memberId = slot?.memberId;
	if (!memberId) return null;

	const [earlier] = await db
		.select({ id: roleSlots.id })
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.where(
			and(
				eq(roleSlots.assignedMemberId, memberId),
				eq(roleDefinitions.key, TMOD_ROLE_KEY),
				lt(meetings.scheduledAt, meeting.scheduledAt),
				ne(meetings.status, "cancelled"),
			),
		)
		.limit(1);
	if (earlier) return null;

	// `members.name`, the same column the roster and `loadHolderContacts` read,
	// so one page cannot show this person under two names.
	const [person] = await db
		.select({ name: members.name })
		.from(members)
		.where(and(eq(members.id, memberId), eq(members.clubId, meeting.clubId)));
	if (!person) return null;

	const contact = (
		await loadHolderContacts(meeting.clubId, [memberId], [])
	).get(contactKey("member", memberId));
	return {
		memberId,
		name: person.name,
		preferredName: greetingName({
			name: person.name,
			preferredName: contact?.preferredName,
		}),
		phone: contact?.phone ?? null,
	};
}

/**
 * The payload's field: the answer for a viewer who manages the club, null for
 * everyone else. The phone and the fact that someone is new are the officer's
 * (same gate as the roster's contact fields), so the query does not run at all
 * for anyone else.
 */
export async function firstTimeToastmasterFor(
	meetingId: string,
	canManage: boolean,
): Promise<FirstTimeToastmaster | null> {
	return canManage ? firstTimeToastmaster(meetingId) : null;
}
