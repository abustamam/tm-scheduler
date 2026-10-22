/**
 * What `set_my_attendance` and `claim_open_role` both read about one meeting
 * and one member (#1283). Plain reads that take a `DbOrTx`, so a preview runs
 * them on the pool and an apply re-runs them INSIDE its transaction, under the
 * club write lock, to recompute the plan it is about to act on.
 *
 * Nothing here authorizes anything: the callers have already resolved the
 * token's own membership through `authorizeTokenForMeeting`.
 */
import { asc, eq } from "drizzle-orm";
import type { db } from "#/db";
import {
	clubs,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { buildRoleCounts, slotLabel } from "#/lib/agenda";
import { MEETING_CANCELLED_MESSAGE } from "#/lib/meeting-cancellation-notice";
import { MEETING_LOCKED_MESSAGE } from "#/lib/meeting-lifecycle";
import { McpError } from "./errors";

type Database = typeof db;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DbOrTx = Database | Tx;

/** A blocking item a member-write preview returns. Codes are local to these two
 *  tools: they carry no PII and no entry index, so they do not go through the
 *  officer tools' `McpBlockingCode` union. */
export interface MemberBlockingItem {
	code: string;
	message: string;
}

export interface MeetingFacts {
	meetingId: string;
	clubId: string;
	clubName: string;
	timezone: string;
	status: string;
	scheduledAt: Date;
}

export async function loadMeetingFacts(
	conn: DbOrTx,
	meetingId: string,
): Promise<MeetingFacts> {
	const [row] = await conn
		.select({
			meetingId: meetings.id,
			clubId: meetings.clubId,
			clubName: clubs.name,
			timezone: clubs.timezone,
			status: meetings.status,
			scheduledAt: meetings.scheduledAt,
		})
		.from(meetings)
		.innerJoin(clubs, eq(clubs.id, meetings.clubId))
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!row) throw new McpError("NOT_FOUND", "Meeting not found.");
	return row;
}

/** "Tue, Oct 28", in the club's timezone, as the meeting page writes it. */
export function meetingDayLabel(instant: Date, timezone: string): string {
	return new Intl.DateTimeFormat("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		timeZone: timezone,
	}).format(instant);
}

/** The meeting-state blocking items both tools share, in the issue's codes. */
export function meetingStateBlocking(
	facts: MeetingFacts,
	now: Date = new Date(),
): MemberBlockingItem[] {
	const out: MemberBlockingItem[] = [];
	if (facts.status === "cancelled") {
		out.push({ code: "MEETING_CANCELLED", message: MEETING_CANCELLED_MESSAGE });
	} else if (facts.status === "completed") {
		out.push({ code: "MEETING_COMPLETED", message: MEETING_LOCKED_MESSAGE });
	} else if (facts.scheduledAt.getTime() <= now.getTime()) {
		out.push({
			code: "MEETING_PAST",
			message: "That meeting has already started, so it can't be changed here.",
		});
	}
	return out;
}

/** A cancelled or completed meeting at apply time is `LOCKED`, as for the officer tools. */
export function throwIfLocked(facts: MeetingFacts): void {
	if (facts.status === "cancelled") {
		throw new McpError("LOCKED", MEETING_CANCELLED_MESSAGE);
	}
	if (facts.status === "completed") {
		throw new McpError("LOCKED", MEETING_LOCKED_MESSAGE);
	}
}

export interface LabelledSlot {
	slotId: string;
	label: string;
	roleName: string;
	status: string;
	holderMemberId: string | null;
}

/** Every slot in the meeting in agenda order, numbered the way the agenda is. */
export async function loadLabelledSlots(
	conn: DbOrTx,
	meetingId: string,
): Promise<LabelledSlot[]> {
	const rows = await conn
		.select({
			slotId: roleSlots.id,
			slotIndex: roleSlots.slotIndex,
			status: roleSlots.status,
			holderMemberId: roleSlots.assignedMemberId,
			roleName: roleDefinitions.name,
			slotsUnordered: roleDefinitions.slotsUnordered,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.where(eq(roleSlots.meetingId, meetingId))
		.orderBy(
			asc(roleDefinitions.sortOrder),
			asc(roleSlots.slotIndex),
			asc(roleSlots.id),
		);
	const counts = buildRoleCounts(rows);
	return rows.map((r) => ({
		slotId: r.slotId,
		label: slotLabel(r, counts),
		roleName: r.roleName,
		status: r.status,
		holderMemberId: r.holderMemberId,
	}));
}

/** A member's first name, for the draft message; null when there is none. */
export async function memberFirstName(
	conn: DbOrTx,
	memberId: string,
): Promise<string | null> {
	const [row] = await conn
		.select({ name: members.name })
		.from(members)
		.where(eq(members.id, memberId))
		.limit(1);
	const first = row?.name.trim().split(/\s+/)[0];
	return first ? first : null;
}
