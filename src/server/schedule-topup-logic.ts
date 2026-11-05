// #190 read-triggered schedule top-up. Materializes upcoming meetings from a
// club's standing recurrence rule so the calendar always holds `keep_ahead`
// future `scheduled` meetings — lazily, on authenticated schedule reads and on
// rule save (NO background poller; see docs/adr). Idempotent: re-running when
// already full is a no-op, and concurrent runs are safe via the unique
// (club_id, scheduled_at) index + ON CONFLICT DO NOTHING.
//
// DB logic lives here (not in a createServerFn module) so it's integration-
// testable and never pulled into the client bundle.

import { asc, eq } from "drizzle-orm";
import { db } from "#/db";
import {
	clubMeetingRecurrence,
	clubs,
	meetings,
	roleDefinitions,
} from "#/db/schema";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";
import { effectiveLocation } from "#/lib/effective-location";
import { generateOccurrences } from "#/lib/meeting-recurrence";
import { buildTopUpRecurrenceInput } from "#/lib/recurrence-rule";
import { insertMeetingWithSlots } from "./meeting-create-logic";

export interface TopUpResult {
	created: number;
}

/** The pool or an open transaction (#1514: the rule save runs in one). */
export type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * What the top-up gives a meeting it creates, beyond its date. THE definition
 * of "untouched": `findPristineEmptyMeetingIds` compares a meeting against
 * exactly these values, so an officer's per-meeting override (a venue, a
 * length, a join link, a typed meeting number) is never mistaken for a default.
 * `joinUrl` and `meetingNumber` are never written at insert (the number is
 * derived for display until a human types one, or the meeting completes).
 */
export function newMeetingDefaults(
	rule: { location: string | null },
	club: { defaultMeetingMinutes: number; defaultLocation: string | null },
): {
	lengthMinutes: number;
	location: string | null;
	joinUrl: null;
	meetingNumber: null;
} {
	return {
		lengthMinutes: club.defaultMeetingMinutes,
		location: effectiveLocation(rule.location, club.defaultLocation),
		joinUrl: null,
		meetingNumber: null,
	};
}

/**
 * The instants the top-up would create: the slot logic, pure. `existing` is
 * every meeting of the club (any status keeps its local date taken; future
 * `scheduled` ones count toward `keepAhead`). `ensureScheduleToppedUp` creates
 * exactly this list, and `update_meeting_schedule` plans its replacements from
 * it, so the plan cannot promise a meeting the apply will not create.
 */
export function planTopUpInstants(input: {
	rule: Parameters<typeof buildTopUpRecurrenceInput>[0] & {
		keepAhead: number;
		enabled: boolean;
	};
	timezone: string;
	existing: {
		scheduledAt: Date;
		status: string;
		/** `meetings.slot_date` (#1521): reserved even after a move. Null: ignored. */
		slotDate?: string | null;
	}[];
	now: Date;
}): Date[] {
	const { rule, timezone, existing, now } = input;
	if (!rule.enabled) return [];
	// Existing meetings: count FUTURE `scheduled` toward keep_ahead; every meeting
	// of ANY status occupies its local calendar date (a cancelled meeting keeps
	// its date reserved — cancellation is the skip mechanism).
	// #1521: a meeting also keeps the date it was created on reserved, so one an
	// officer moved off a rule date does not get recreated there.
	const takenDates = new Set<string>();
	for (const m of existing) {
		takenDates.add(utcToZonedWallTime(m.scheduledAt, timezone).slice(0, 10));
		if (m.slotDate) takenDates.add(m.slotDate);
	}
	const futureScheduled = existing.filter(
		(m) => m.status === "scheduled" && m.scheduledAt.getTime() > now.getTime(),
	).length;

	const needed = rule.keepAhead - futureScheduled;
	if (needed <= 0) return [];

	// Generate a window of upcoming occurrences from the rule, starting on/after
	// today's local date, then take the first `needed` that are strictly in the
	// future and not already taken.
	const notBefore = utcToZonedWallTime(now, timezone).slice(0, 10);
	const { occurrences } = generateOccurrences(
		buildTopUpRecurrenceInput(rule, notBefore),
	);

	const toCreate: Date[] = [];
	const claimed = new Set(takenDates);
	for (const occ of occurrences) {
		if (toCreate.length >= needed) break;
		if (claimed.has(occ.date)) continue; // date already occupied — skip
		const instant = zonedWallTimeToUtc(occ.wallTime, timezone);
		if (instant.getTime() <= now.getTime()) continue; // must be future
		claimed.add(occ.date);
		toCreate.push(instant);
	}
	return toCreate;
}

/**
 * Ensure the club's calendar holds `keep_ahead` future `scheduled` meetings,
 * generating the missing ones from the standing rule. No-op when the club has
 * no rule, the rule is disabled, or the target is already met.
 *
 * `now` is injectable for deterministic tests; defaults to the wall clock.
 */
export async function ensureScheduleToppedUp(
	clubId: string,
	now: Date = new Date(),
	conn: DbOrTx = db,
): Promise<TopUpResult> {
	const rule = await conn.query.clubMeetingRecurrence.findFirst({
		where: eq(clubMeetingRecurrence.clubId, clubId),
	});
	if (!rule || !rule.enabled) return { created: 0 };

	const club = await conn.query.clubs.findFirst({
		where: eq(clubs.id, clubId),
	});
	if (!club) return { created: 0 };

	const existing = await conn
		.select({
			scheduledAt: meetings.scheduledAt,
			status: meetings.status,
			slotDate: meetings.slotDate,
		})
		.from(meetings)
		.where(eq(meetings.clubId, clubId));

	const toCreate = planTopUpInstants({
		rule,
		timezone: club.timezone,
		existing,
		now,
	});
	if (toCreate.length === 0) return { created: 0 };

	const defs = await conn
		.select()
		.from(roleDefinitions)
		// The club's whole BANK, and `standing` is what keeps a contest role off an
		// ordinary meeting (#801). `generateSlotRows` filters `standing && enabled`
		// and this bare `select()` carries the real column, so the gate is closed
		// by DATA rather than by anything written here;
		// `template-role-leak.integration.test.ts` measures that end to end.
		//
		// An `isNull(roleDefinitions.templateId)` used to sit beside the club id,
		// under a comment calling the template scope the only thing stopping this
		// club's Chief Judge and Contestants from landing on every meeting. 0083
		// pinned `template_id` NULL with a CHECK, so that predicate matched every
		// row and the sentence describing it was false. Removed rather than left
		// as decoration a reader would trust.
		.where(eq(roleDefinitions.clubId, clubId))
		.orderBy(asc(roleDefinitions.sortOrder));

	const defaults = newMeetingDefaults(rule, club);
	let created = 0;
	await conn.transaction(async (tx) => {
		for (const scheduledAt of toCreate) {
			const id = await insertMeetingWithSlots(
				tx,
				{
					clubId,
					scheduledAt,
					lengthMinutes: defaults.lengthMinutes,
					location: defaults.location,
					timezone: club.timezone,
				},
				defs,
			);
			if (id) created += 1;
		}
	});

	return { created };
}
