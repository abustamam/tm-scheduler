// #190 recurrence-rule CRUD + edit reconciliation. DB logic (no createServerFn)
// so it's integration-testable and stays out of the client bundle.
//
// Saving a rule upserts it and tops the schedule up. Editing the PATTERN (the
// fields that determine dates) reconciles: pristine-empty future meetings on
// the OLD pattern are deleted and regenerated under the new rule. Meetings that
// someone has touched (claimed slot, set content, marked availability) and
// meetings off the old pattern (manual/one-off) are never deleted.
import { and, eq, gt, inArray, isNotNull, or } from "drizzle-orm";
import { db } from "#/db";
import {
	clubMeetingRecurrence,
	clubs,
	meetings,
	memberAvailability,
	roleSlots,
} from "#/db/schema";
import { utcToZonedWallTime } from "#/lib/datetime";
import { generateOccurrences } from "#/lib/meeting-recurrence";
import { buildTopUpRecurrenceInput } from "#/lib/recurrence-rule";
import { ensureScheduleToppedUp } from "./schedule-topup-logic";

/** The rule shape the CRUD accepts (pre-normalization). */
export interface RecurrenceRuleInput {
	mode: "interval" | "monthly";
	weekday: number;
	intervalWeeks: number | null;
	anchorDate: string | null;
	ordinals: string[] | null;
	timeOfDay: string;
	location: string | null;
	keepAhead: number;
	enabled: boolean;
}

export type RecurrenceRuleRow = typeof clubMeetingRecurrence.$inferSelect;

/** Null the fields that don't belong to the chosen mode (satisfies the XOR check). */
function normalize(input: RecurrenceRuleInput): RecurrenceRuleInput {
	return input.mode === "monthly"
		? { ...input, intervalWeeks: null, anchorDate: null }
		: { ...input, ordinals: null };
}

/** Load a club's standing rule, or null. */
export async function getRecurrenceRule(
	clubId: string,
): Promise<RecurrenceRuleRow | null> {
	const row = await db.query.clubMeetingRecurrence.findFirst({
		where: eq(clubMeetingRecurrence.clubId, clubId),
	});
	return row ?? null;
}

/** Do the two rules produce different occurrence DATES/TIMES? */
function patternChanged(
	old: RecurrenceRuleRow,
	next: RecurrenceRuleInput,
): boolean {
	const ordKey = (o: string[] | null) => (o ? [...o].sort().join(",") : "");
	return (
		old.mode !== next.mode ||
		old.weekday !== next.weekday ||
		old.intervalWeeks !== next.intervalWeeks ||
		old.anchorDate !== next.anchorDate ||
		old.timeOfDay !== next.timeOfDay ||
		ordKey(old.ordinals) !== ordKey(next.ordinals)
	);
}

/**
 * Of the given meeting ids, which are pristine-empty — i.e. safe to reconcile:
 * `scheduled`, every content field blank, no claimed role slot, and no member
 * availability mark. (Attendance/awards/table-topics are post-meeting artifacts
 * a future meeting never carries.)
 */
export async function findPristineEmptyMeetingIds(
	meetingIds: string[],
): Promise<string[]> {
	if (meetingIds.length === 0) return [];

	const rows = await db
		.select({
			id: meetings.id,
			status: meetings.status,
			theme: meetings.theme,
			wordOfTheDay: meetings.wordOfTheDay,
			wodDefinition: meetings.wodDefinition,
			wodExample: meetings.wodExample,
			notes: meetings.notes,
			reminders: meetings.reminders,
		})
		.from(meetings)
		.where(inArray(meetings.id, meetingIds));

	const claimed = await db
		.select({ meetingId: roleSlots.meetingId })
		.from(roleSlots)
		.where(
			and(
				inArray(roleSlots.meetingId, meetingIds),
				or(
					isNotNull(roleSlots.assignedMemberId),
					isNotNull(roleSlots.assignedGuestId),
				),
			),
		);
	const claimedSet = new Set(claimed.map((c) => c.meetingId));

	const avail = await db
		.select({ meetingId: memberAvailability.meetingId })
		.from(memberAvailability)
		.where(inArray(memberAvailability.meetingId, meetingIds));
	const availSet = new Set(avail.map((a) => a.meetingId));

	return rows
		.filter(
			(m) =>
				m.status === "scheduled" &&
				!m.theme &&
				!m.wordOfTheDay &&
				!m.wodDefinition &&
				!m.wodExample &&
				!m.notes &&
				!m.reminders &&
				!claimedSet.has(m.id) &&
				!availSet.has(m.id),
		)
		.map((m) => m.id);
}

/** Delete pristine-empty future meetings that sit on the OLD rule's dates. */
async function reconcileEmptyShells(
	oldRule: RecurrenceRuleRow,
	clubId: string,
	timezone: string,
	now: Date,
): Promise<void> {
	const notBefore = utcToZonedWallTime(now, timezone).slice(0, 10);
	const oldDates = new Set(
		generateOccurrences(
			buildTopUpRecurrenceInput(oldRule, notBefore),
		).occurrences.map((o) => o.date),
	);

	const future = await db
		.select({ id: meetings.id, scheduledAt: meetings.scheduledAt })
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, clubId),
				eq(meetings.status, "scheduled"),
				gt(meetings.scheduledAt, now),
			),
		);

	const onOldPattern = future
		.filter((m) =>
			oldDates.has(utcToZonedWallTime(m.scheduledAt, timezone).slice(0, 10)),
		)
		.map((m) => m.id);

	const pristine = await findPristineEmptyMeetingIds(onOldPattern);
	if (pristine.length > 0) {
		await db.delete(meetings).where(inArray(meetings.id, pristine));
	}
}

export interface SaveRuleResult {
	rule: RecurrenceRuleRow;
	created: number;
}

/**
 * Upsert a club's standing rule, reconcile empty shells if the pattern changed,
 * and top the schedule up under the new rule. `now` is injectable for tests.
 */
export async function saveRecurrenceRule(
	clubId: string,
	input: RecurrenceRuleInput,
	now: Date = new Date(),
): Promise<SaveRuleResult> {
	const existing = await getRecurrenceRule(clubId);
	const n = normalize(input);
	const values = {
		mode: n.mode,
		weekday: n.weekday,
		intervalWeeks: n.intervalWeeks,
		anchorDate: n.anchorDate,
		ordinals: n.ordinals,
		timeOfDay: n.timeOfDay,
		location: n.location,
		keepAhead: n.keepAhead,
		enabled: n.enabled,
	};

	await db
		.insert(clubMeetingRecurrence)
		.values({ clubId, ...values })
		.onConflictDoUpdate({
			target: clubMeetingRecurrence.clubId,
			set: { ...values, updatedAt: new Date() },
		});

	if (existing && patternChanged(existing, n)) {
		const club = await db.query.clubs.findFirst({
			where: eq(clubs.id, clubId),
		});
		if (club) {
			await reconcileEmptyShells(existing, clubId, club.timezone, now);
		}
	}

	const { created } = await ensureScheduleToppedUp(clubId, now);
	const rule = await getRecurrenceRule(clubId);
	if (!rule) throw new Error("Rule vanished after save.");
	return { rule, created };
}

/** Delete a club's standing rule entirely. Existing meetings are left in place. */
export async function deleteRecurrenceRule(clubId: string): Promise<void> {
	await db
		.delete(clubMeetingRecurrence)
		.where(eq(clubMeetingRecurrence.clubId, clubId));
}
