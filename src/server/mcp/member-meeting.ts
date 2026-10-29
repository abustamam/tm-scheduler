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
import { db } from "#/db";
import {
	clubs,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { buildRoleCounts, slotLabel } from "#/lib/agenda";
import { planHash as hashPlan } from "#/lib/mcp-plan";
import { MEETING_CANCELLED_MESSAGE } from "#/lib/meeting-cancellation-notice";
import { MEETING_LOCKED_MESSAGE } from "#/lib/meeting-lifecycle";
import {
	getPlanStatus,
	isMemberUnavailable,
} from "#/server/attendance-plan-logic";
import { HeldSlotsChangedError } from "#/server/availability-logic";
import { lockClubForWrite } from "#/server/club-write-lock";
import { McpError } from "./errors";
import { isoInTimezone } from "./tools/get-my-schedule";

type Database = typeof db;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
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

/** The one sentence every previewed write answers a drifted plan with. */
export const PLAN_STALE_MESSAGE =
	"That meeting changed since you previewed it. Review the fresh plan and ask the user again.";

/** The meeting header every attendance preview carries. */
export function meetingPlanHeader(facts: MeetingFacts) {
	return {
		meetingId: facts.meetingId,
		clubName: facts.clubName,
		startsAt: isoInTimezone(facts.scheduledAt, facts.timezone),
		status: facts.status,
	};
}

/** What an attendance write depends on for ONE member in ONE meeting. */
export interface MemberAttendanceState {
	held: LabelledSlot[];
	heldSlotIds: string[];
	planStatus: Awaited<ReturnType<typeof getPlanStatus>>;
	unavailable: boolean;
}

/**
 * The slots `memberId` holds (matched on the id the CALLER has already made
 * canonical: it is a `members.id` read from the database, never request text),
 * their plan answer and their unavailability mark.
 */
export async function loadMemberAttendanceState(
	conn: DbOrTx,
	args: { meetingId: string; memberId: string },
): Promise<MemberAttendanceState> {
	const slots = await loadLabelledSlots(conn, args.meetingId);
	const held = slots.filter((s) => s.holderMemberId === args.memberId);
	const planStatus = await getPlanStatus(conn, args);
	const unavailable = await isMemberUnavailable(conn, args);
	return {
		held,
		heldSlotIds: held.map((s) => s.slotId).sort(),
		planStatus,
		unavailable,
	};
}

/** True when the member is already in the state the write would put them in. */
export function isAlreadyStatus(
	status: "coming" | "not_coming",
	state: MemberAttendanceState,
): boolean {
	return status === "coming"
		? state.planStatus === "coming" && !state.unavailable
		: state.unavailable && state.held.length === 0;
}

/** The `planHash` of an attendance plan plus the state its apply depends on. */
export function attendancePlanHash(args: {
	tool: string;
	clubId: string;
	userId: string;
	plan: object;
	state: MemberAttendanceState;
}): string {
	return hashPlan({
		tool: args.tool,
		clubId: args.clubId,
		userId: args.userId,
		plan: {
			...args.plan,
			state: {
				heldSlotIds: args.state.heldSlotIds,
				planStatus: args.state.planStatus,
				unavailable: args.state.unavailable,
			},
		},
	});
}

export interface ComputedAttendance {
	plan: object;
	planHash: string;
	blocking: MemberBlockingItem[];
}

/**
 * The preview / apply skeleton `set_my_attendance` and `set_attendance` share.
 * Preview: `compute` on the pool. Apply: a transaction, the club write lock,
 * `underLock` (a re-read of anything the apply's authority rested on, BEFORE
 * the meeting is read), the lock check, `compute` again, then `PLAN_STALE` on a
 * drifted hash and `BLOCKED` on a blocking item, and only then `apply`. A
 * `HeldSlotsChangedError` out of `apply` (the seam's re-check under the
 * attendance lock) is `PLAN_STALE` with the fresh plan, and nothing is freed.
 */
export async function runAttendanceTool<C extends ComputedAttendance, R>(args: {
	planHash: string | undefined;
	meetingId: string;
	clubId: string;
	compute: (conn: DbOrTx) => Promise<C>;
	underLock?: (tx: Tx) => Promise<void>;
	apply: (tx: Tx, c: C, facts: MeetingFacts) => Promise<R>;
}): Promise<
	{ plan: object; planHash: string; blocking: MemberBlockingItem[] } | R
> {
	const stale = (c: ComputedAttendance) =>
		new McpError("PLAN_STALE", PLAN_STALE_MESSAGE, {
			plan: c.plan,
			planHash: c.planHash,
			blocking: c.blocking,
		});
	if (!args.planHash) {
		const c = await args.compute(db);
		return { plan: c.plan, planHash: c.planHash, blocking: c.blocking };
	}
	const hash = args.planHash;
	return db.transaction(async (tx) => {
		await lockClubForWrite(tx, args.clubId);
		await args.underLock?.(tx);
		const facts = await loadMeetingFacts(tx, args.meetingId);
		throwIfLocked(facts);
		const c = await args.compute(tx);
		if (c.planHash !== hash) throw stale(c);
		const first = c.blocking[0];
		if (first)
			throw new McpError("BLOCKED", first.message, { blocking: c.blocking });
		try {
			return await args.apply(tx, c, facts);
		} catch (e) {
			if (!(e instanceof HeldSlotsChangedError)) throw e;
			throw stale(await args.compute(tx));
		}
	});
}
