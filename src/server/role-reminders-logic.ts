// Role-assignment reminder PRODUCER (#272). The last link in the reminders chain:
// #271 sends due `notifications` rows, #274 controls who gets them, and this
// module ENQUEUES them — one self-regarding "you're <role> at <club> on <date>"
// reminder per member holding a slot ahead of an upcoming meeting.
//
// Consumes #274's control-layer helpers (`getClubReminderSettings`,
// `filterRemindableMembers`) so a producer run honors both the club's on/off +
// lead-time and each member's opt-out. Populates the `notifications` columns the
// #271 poller reads (`notifications-logic.ts` renders the email from the joined
// slot context and injects the unsubscribe link — this producer adds neither).
//
// Idempotency + staleness (the two safety properties this PR must get right):
//   - Idempotent enqueue: at most one reminder per (slot, member), enforced by
//     the `notifications_slot_member_unique` partial index + ON CONFLICT DO
//     NOTHING. Re-running every poller tick therefore never double-enqueues.
//   - Stale-assignment safety (approach (b), the robust one): the row records
//     `assigned_member_id`; at SEND time the poller re-validates it against the
//     slot's current assignee/status and the meeting status, suppressing a
//     reminder whose slot was reassigned/released or whose meeting is no longer
//     scheduled (see `processDueNotifications` in `notifications-logic.ts`).
//
// Lives in a `*-logic.ts` (not a createServerFn module): it is invoked ONLY by
// the in-process poller (`reminder-poller.ts`), never a client route, so `#/db`/
// `pg` never reach the browser bundle (CLAUDE.md "Data layer").
import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	meetings,
	members,
	notifications,
	people,
	roleSlots,
} from "#/db/schema";
import {
	filterRemindableMembers,
	getClubReminderSettings,
} from "./notification-prefs-logic";

/** The `notifications.type` this producer writes. Distinguishes role-assignment
 *  reminders in the queue (informational — the poller routes by `channel`). */
export const ROLE_REMINDER_TYPE = "role_reminder";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * When to send a slot holder's reminder: `leadTimeDays` before the meeting. A
 * lead time longer than the runway (a soon meeting) yields a past instant, so
 * the reminder is immediately due — a late reminder still beats none.
 */
export function computeReminderSendAt(
	scheduledAt: Date,
	leadTimeDays: number,
): Date {
	return new Date(scheduledAt.getTime() - leadTimeDays * MS_PER_DAY);
}

/** Side-effecting deps, injected so the producer is testable with a fixed clock
 *  (mirrors `NotificationDeps`). Production wires the real clock. */
export interface ReminderProducerDeps {
	/** The run's "now" — the horizon for "upcoming" meetings. */
	now(): Date;
}

export const defaultReminderProducerDeps: ReminderProducerDeps = {
	now: () => new Date(),
};

export interface ProduceReminderResult {
	/** Held member-slots on upcoming scheduled meetings (before any filtering). */
	candidates: number;
	/** New reminder rows inserted this run. */
	enqueued: number;
	/** Candidates skipped because a reminder already existed (idempotent re-run). */
	duplicates: number;
	/** Candidates skipped because the member's Person opted out (#274). */
	optedOut: number;
	/** Candidates skipped because their club has reminders disabled (#274). */
	disabled: number;
	/** Clubs whose enqueue batch failed this pass (isolated + logged; the next
	 *  idempotent tick retries). Usually a concurrent delete of a scanned row. */
	errors: number;
}

/** A slot currently held by a linked member on an upcoming scheduled meeting. */
interface RemindableSlotHolder {
	clubId: string;
	slotId: string;
	/** The membership holding the slot — `notifications.assigned_member_id`. */
	memberId: string;
	/** The holder's Person — the opt-out key (#274). */
	personId: string;
	/** The holder's linked sign-in account — `notifications.user_id`. */
	userId: string;
	meetingScheduledAt: Date;
}

/**
 * Scan for reminder-eligible slot holders: role slots that are `claimed` or
 * `confirmed`, on a still-`scheduled` FUTURE meeting, held by a MEMBER (guests
 * are excluded by the inner join on `assigned_member_id`) whose Person has a
 * linked sign-in account (unlinked members can't be emailed — a NULL `user_id`
 * is filtered out). Past/completed/cancelled meetings never match.
 */
async function selectRemindableSlotHolders(
	now: Date,
): Promise<RemindableSlotHolder[]> {
	const rows = await db
		.select({
			clubId: meetings.clubId,
			slotId: roleSlots.id,
			memberId: roleSlots.assignedMemberId,
			personId: members.personId,
			userId: people.userId,
			meetingScheduledAt: meetings.scheduledAt,
		})
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.innerJoin(members, eq(members.id, roleSlots.assignedMemberId))
		.innerJoin(people, eq(people.id, members.personId))
		.where(
			and(
				inArray(roleSlots.status, ["claimed", "confirmed"]),
				eq(meetings.status, "scheduled"),
				gt(meetings.scheduledAt, now),
				isNotNull(people.userId),
			),
		);

	// The WHERE guarantees these are non-null; narrow the types for the caller.
	return rows.map((r) => ({
		clubId: r.clubId,
		slotId: r.slotId,
		memberId: r.memberId as string,
		personId: r.personId,
		userId: r.userId as string,
		meetingScheduledAt: r.meetingScheduledAt,
	}));
}

/**
 * Enqueue role-assignment reminders for every eligible slot holder. Groups the
 * candidates by club so each club's `enabled` + `leadTimeDays` (via
 * `getClubReminderSettings`) and its members' opt-outs (via
 * `filterRemindableMembers`) are applied once, then inserts the survivors with
 * ON CONFLICT DO NOTHING so a re-run enqueues nothing new. Safe to call every
 * tick; returns per-outcome counts for observability.
 */
export async function produceRoleReminders(
	deps: ReminderProducerDeps = defaultReminderProducerDeps,
): Promise<ProduceReminderResult> {
	const now = deps.now();
	const candidates = await selectRemindableSlotHolders(now);

	let enqueued = 0;
	let duplicates = 0;
	let optedOut = 0;
	let disabled = 0;
	let errors = 0;

	// Group by club — settings + opt-out are club/Person facts, resolved per club.
	const byClub = new Map<string, RemindableSlotHolder[]>();
	for (const row of candidates) {
		const bucket = byClub.get(row.clubId);
		if (bucket) bucket.push(row);
		else byClub.set(row.clubId, [row]);
	}

	for (const [clubId, holders] of byClub) {
		try {
			const settings = await getClubReminderSettings(clubId);
			if (!settings.enabled) {
				disabled += holders.length;
				continue;
			}

			// Drop members whose Person opted out (#274); count the difference.
			const remindable = await filterRemindableMembers(holders);
			optedOut += holders.length - remindable.length;
			if (remindable.length === 0) continue;

			const values = remindable.map((h) => ({
				userId: h.userId,
				slotId: h.slotId,
				assignedMemberId: h.memberId,
				type: ROLE_REMINDER_TYPE,
				channel: "email",
				sendAt: computeReminderSendAt(
					h.meetingScheduledAt,
					settings.leadTimeDays,
				),
			}));

			// Idempotent enqueue: the partial unique index (slot_id,
			// assigned_member_id) is the arbiter, so a duplicate (slot, member) is a
			// no-op. `returning` yields only the rows actually inserted — the rest
			// were already enqueued on a previous pass.
			const inserted = await db
				.insert(notifications)
				.values(values)
				.onConflictDoNothing({
					target: [notifications.slotId, notifications.assignedMemberId],
					where: sql`${notifications.assignedMemberId} is not null`,
				})
				.returning({ id: notifications.id });

			enqueued += inserted.length;
			duplicates += values.length - inserted.length;
		} catch (err) {
			// Isolate one club's failure so the rest of the pass still enqueues. The
			// expected cause is a concurrent mutation — a slot/member/user deleted
			// between the scan above and this insert (FK violation) — which the next
			// idempotent tick recovers from, since the deleted row is gone from the
			// scan by then.
			errors++;
			console.error(
				`[reminders] producer: enqueue failed for club ${clubId}:`,
				err,
			);
		}
	}

	return {
		candidates: candidates.length,
		enqueued,
		duplicates,
		optedOut,
		disabled,
		errors,
	};
}
