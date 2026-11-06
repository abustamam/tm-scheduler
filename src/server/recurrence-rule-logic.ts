// #190 recurrence-rule CRUD + edit reconciliation. DB logic (no createServerFn)
// so it's integration-testable and stays out of the client bundle.
//
// Saving a rule upserts it and tops the schedule up. Editing the PATTERN (the
// fields that determine dates) reconciles: pristine-empty future meetings on
// the OLD pattern are deleted and regenerated under the new rule. Meetings that
// someone has touched (claimed slot, set content, said they're not coming) and
// meetings off the old pattern (manual/one-off) are never deleted.
import { and, asc, eq, gt, inArray, isNotNull, or } from "drizzle-orm";
import { db } from "#/db";
import {
	clubMeetingRecurrence,
	clubs,
	guestInvites,
	meetingGuestRsvps,
	meetings,
	roleSlots,
} from "#/db/schema";
import { utcToZonedWallTime } from "#/lib/datetime";
import { generateOccurrences } from "#/lib/meeting-recurrence";
import { buildTopUpRecurrenceInput } from "#/lib/recurrence-rule";
import {
	listNotComingForMeetings,
	lockPlanRowsForMeetings,
} from "./attendance-plan-logic";
import {
	type DbOrTx,
	ensureScheduleToppedUp,
	newMeetingDefaults,
} from "./schedule-topup-logic";

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
	conn: DbOrTx = db,
): Promise<RecurrenceRuleRow | null> {
	const row = await conn.query.clubMeetingRecurrence.findFirst({
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
 * Why a meeting is NOT safe to reconcile.
 * - `touched`: someone changed or answered something on this meeting.
 * - `defaults_differ`: nothing but its length, location or video-call link differs from the
 *   club's CURRENT defaults. Meetings copy those values when they are created,
 *   so this is also what a meeting looks like after the club changed its default
 *   length, venue or video-call link; there is no record of which of the two happened.
 */
export type KeptReason = "touched" | "defaults_differ";

export interface PristineOptions {
	/**
	 * Lock the candidates before reading anything: the meeting rows, their role
	 * slots and their attendance-plan rows, each `FOR UPDATE` in id order. For a
	 * caller inside the transaction that deletes by this answer, so a claim, RSVP
	 * or decline that is in flight waits, then finds the meeting gone (or is
	 * waited on, and the meeting is kept). Needs a transaction; the preview
	 * stays lock-free.
	 */
	lock?: boolean;
}

/** Take the row locks `PristineOptions.lock` describes, in one fixed order. */
async function lockCandidates(
	conn: DbOrTx,
	meetingIds: string[],
): Promise<void> {
	await conn
		.select({ id: meetings.id })
		.from(meetings)
		.where(inArray(meetings.id, meetingIds))
		.orderBy(asc(meetings.id))
		.for("update");
	await conn
		.select({ id: roleSlots.id })
		.from(roleSlots)
		.where(inArray(roleSlots.meetingId, meetingIds))
		.orderBy(asc(roleSlots.id))
		.for("update");
	await lockPlanRowsForMeetings(conn, meetingIds);
}

/**
 * Of the given meeting ids, which are pristine-empty — i.e. safe to reconcile:
 * `scheduled`, every content field blank, no claimed role slot, nobody planned
 * NOT to come, no guest RSVP or invite, and nothing the top-up would not have
 * given it itself (a venue, length, join link or typed number an officer set
 * on this one meeting). (Attendance/awards/table-topics are post-meeting
 * artifacts a future meeting never carries.)
 *
 * Maps each id to `null` when pristine, else the reason it is kept. The ONE
 * predicate; `findPristineEmptyMeetingIds` is its boolean view.
 */
export async function classifyMeetings(
	meetingIds: string[],
	conn: DbOrTx = db,
	options: PristineOptions = {},
): Promise<Map<string, KeptReason | null>> {
	const result = new Map<string, KeptReason | null>();
	if (meetingIds.length === 0) return result;
	if (options.lock) await lockCandidates(conn, meetingIds);

	const rows = await conn
		.select({
			id: meetings.id,
			clubId: meetings.clubId,
			lengthMinutes: meetings.lengthMinutes,
			location: meetings.location,
			joinUrl: meetings.joinUrl,
			meetingNumber: meetings.meetingNumber,
			status: meetings.status,
			theme: meetings.theme,
			wordOfTheDay: meetings.wordOfTheDay,
			wodDefinition: meetings.wodDefinition,
			wodExample: meetings.wodExample,
			notes: meetings.notes,
			reminders: meetings.reminders,
			tableTopicsNotes: meetings.tableTopicsNotes,
			templateId: meetings.templateId,
		})
		.from(meetings)
		.where(inArray(meetings.id, meetingIds));

	const claimed = await conn
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

	// `not_coming` ONLY. Declining is a fact about this date that a regenerate
	// would throw away; answering "I'll be there" or merely having been asked is
	// not — nobody has edited an agenda by answering a question, and treating a
	// `coming` row as a touch would let one keen member pin the whole schedule
	// against a pattern edit.
	const declined = await listNotComingForMeetings(conn, meetingIds);
	const declinedSet = new Set(declined.map((a) => a.meetingId));

	// A guest who RSVPed on the public page, or whom a member drafted an invite
	// for, is a fact about THIS meeting row; both cascade from `meetings`, so a
	// regenerate would silently erase them. `guest_invites` has no status column
	// (a row exists exactly while the invite is drafted/sent), so EVERY row
	// counts, not a subset.
	const guestRsvps = await conn
		.select({ meetingId: meetingGuestRsvps.meetingId })
		.from(meetingGuestRsvps)
		.where(inArray(meetingGuestRsvps.meetingId, meetingIds));
	const guestInviteRows = await conn
		.select({ meetingId: guestInvites.meetingId })
		.from(guestInvites)
		.where(inArray(guestInvites.meetingId, meetingIds));
	const guestTouched = new Set([
		...guestRsvps.map((g) => g.meetingId),
		...guestInviteRows.map((g) => g.meetingId),
	]);

	// Per-meeting overrides: compare against exactly what the top-up gives a
	// meeting it creates (`newMeetingDefaults`), per club.
	const clubIds = [...new Set(rows.map((r) => r.clubId))];
	const clubRows = await conn
		.select({
			id: clubs.id,
			defaultMeetingMinutes: clubs.defaultMeetingMinutes,
			defaultLocation: clubs.defaultLocation,
			defaultJoinUrl: clubs.defaultJoinUrl,
		})
		.from(clubs)
		.where(inArray(clubs.id, clubIds));
	const ruleRows = await conn
		.select({
			clubId: clubMeetingRecurrence.clubId,
			location: clubMeetingRecurrence.location,
		})
		.from(clubMeetingRecurrence)
		.where(inArray(clubMeetingRecurrence.clubId, clubIds));
	const clubById = new Map(clubRows.map((c) => [c.id, c]));
	const ruleByClub = new Map(ruleRows.map((r) => [r.clubId, r]));
	const defaultsDiffer = (m: (typeof rows)[number]): boolean => {
		const club = clubById.get(m.clubId);
		if (!club) return true; // unknown club: do not delete
		const d = newMeetingDefaults(
			{ location: ruleByClub.get(m.clubId)?.location ?? null },
			club,
		);
		return (
			m.lengthMinutes !== d.lengthMinutes ||
			m.location !== d.location ||
			// The link is a per-meeting override only when it is set to something
			// other than the club default (#1534). A null link predates the default
			// (or the admin cleared it) and is untouched, like the default itself.
			(m.joinUrl !== null && m.joinUrl !== d.joinUrl)
		);
	};

	for (const m of rows) {
		const touched =
			m.status !== "scheduled" ||
			!!m.theme ||
			!!m.wordOfTheDay ||
			!!m.wodDefinition ||
			!!m.wodExample ||
			!!m.notes ||
			!!m.reminders ||
			!!m.tableTopicsNotes ||
			claimedSet.has(m.id) ||
			declinedSet.has(m.id) ||
			guestTouched.has(m.id) ||
			m.meetingNumber !== null ||
			// A templated meeting is not an empty shell, whatever its content
			// fields say. Until #622 that meant "somebody deliberately reshaped
			// it into a contest"; it now ALSO means "somebody edited its
			// agenda", because the first edit of an ordinary meeting
			// materializes a private copy. Both are content, and this predicate
			// already declines to prune a meeting with content of any kind — a
			// theme, a Word of the Day, a claimed slot. The set this clause
			// excludes is therefore much larger than it was, by design.
			// It also can't be safely deleted even if it looked pristine:
			// `meeting_templates.meeting_id` cascades from `meetings`, but the
			// materialized `role_definitions` pointing at that private template
			// are ON DELETE RESTRICT, so deleting this row would throw a
			// foreign-key violation.
			m.templateId !== null;
		result.set(
			m.id,
			touched ? "touched" : defaultsDiffer(m) ? "defaults_differ" : null,
		);
	}
	return result;
}

/** The ids `classifyMeetings` finds pristine. */
export async function findPristineEmptyMeetingIds(
	meetingIds: string[],
	conn: DbOrTx = db,
	options: PristineOptions = {},
): Promise<string[]> {
	const verdicts = await classifyMeetings(meetingIds, conn, options);
	return [...verdicts].filter(([, why]) => why === null).map(([id]) => id);
}

/**
 * Future `scheduled` meetings on the OLD rule's dates, split into the pristine
 * empty ones a pattern change deletes and the touched ones it keeps. The one
 * selection `reconcileEmptyShells` deletes by and `update_meeting_schedule`
 * previews and hashes by, so the plan cannot drift from the delete.
 */
export async function selectOldPatternMeetings(
	oldRule: RecurrenceRuleRow,
	clubId: string,
	timezone: string,
	now: Date,
	conn: DbOrTx = db,
	options: PristineOptions = {},
): Promise<{
	deleted: { id: string; scheduledAt: Date }[];
	kept: { id: string; scheduledAt: Date; reason: KeptReason }[];
}> {
	const notBefore = utcToZonedWallTime(now, timezone).slice(0, 10);
	const oldDates = new Set(
		generateOccurrences(
			buildTopUpRecurrenceInput(oldRule, notBefore),
		).occurrences.map((o) => o.date),
	);

	const future = await conn
		.select({
			id: meetings.id,
			scheduledAt: meetings.scheduledAt,
			slotDate: meetings.slotDate,
		})
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, clubId),
				eq(meetings.status, "scheduled"),
				gt(meetings.scheduledAt, now),
			),
		)
		.orderBy(asc(meetings.scheduledAt), asc(meetings.id));

	const onOldPattern = future.filter((m) =>
		oldDates.has(utcToZonedWallTime(m.scheduledAt, timezone).slice(0, 10)),
	);

	// A meeting whose slot date differs from its current local date was moved by
	// an officer (#1521). Landing on another rule date does not make it an
	// untouched old-pattern meeting: deleting it would undo the move.
	const isMoved = (m: { scheduledAt: Date; slotDate: string | null }) =>
		m.slotDate !== null &&
		m.slotDate !== utcToZonedWallTime(m.scheduledAt, timezone).slice(0, 10);
	const movedIds = new Set(onOldPattern.filter(isMoved).map((m) => m.id));
	const candidates = onOldPattern.filter((m) => !movedIds.has(m.id));

	const verdicts = await classifyMeetings(
		candidates.map((m) => m.id),
		conn,
		options,
	);
	const kept: { id: string; scheduledAt: Date; reason: KeptReason }[] = [];
	for (const m of onOldPattern) {
		if (movedIds.has(m.id)) {
			kept.push({ id: m.id, scheduledAt: m.scheduledAt, reason: "touched" });
			continue;
		}
		const why = verdicts.get(m.id);
		// A meeting deleted while we waited for its lock has no verdict: gone.
		if (why) kept.push({ id: m.id, scheduledAt: m.scheduledAt, reason: why });
	}
	return {
		deleted: candidates
			.filter((m) => verdicts.get(m.id) === null)
			.map((m) => ({ id: m.id, scheduledAt: m.scheduledAt })),
		kept,
	};
}

/** Delete the pristine-empty future meetings a pattern change replaces. */
async function reconcileEmptyShells(
	conn: DbOrTx,
	meetingIds: string[],
): Promise<void> {
	if (meetingIds.length === 0) return;
	await conn.delete(meetings).where(inArray(meetings.id, meetingIds));
}

export interface SaveRuleResult {
	rule: RecurrenceRuleRow;
	created: number;
	/** Ids of the meetings the pattern change deleted (empty when none). */
	deletedMeetingIds: string[];
}

/**
 * Lock the club's rule row for the rest of the transaction, so a concurrent
 * save (web or `update_meeting_schedule`) waits and re-reads afterwards. No row
 * yet (first save) locks nothing; the upsert's unique key covers that case.
 */
export async function lockRecurrenceRule(
	conn: DbOrTx,
	clubId: string,
): Promise<void> {
	await conn
		.select({ id: clubMeetingRecurrence.id })
		.from(clubMeetingRecurrence)
		.where(eq(clubMeetingRecurrence.clubId, clubId))
		.for("update");
}

/**
 * `saveRecurrenceRule` on a connection the caller already holds a transaction
 * on: lock the rule, select the meetings to delete, upsert, delete exactly that
 * selection, top up. Used by the MCP tool so its re-plan, hash check and every
 * write share one transaction.
 */
export async function saveRecurrenceRuleIn(
	conn: DbOrTx,
	clubId: string,
	input: RecurrenceRuleInput,
	now: Date = new Date(),
	/**
	 * Runs after the delete and before the top-up, inside the same transaction.
	 * For a caller that must change a club column the top-up reads (the default
	 * length) WITHOUT it affecting which meetings count as untouched: that
	 * selection has already been made against the old values.
	 */
	beforeTopUp?: () => Promise<void>,
): Promise<SaveRuleResult> {
	await lockRecurrenceRule(conn, clubId);
	const existing = await getRecurrenceRule(clubId, conn);
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

	// Selected BEFORE the upsert, against the rule being replaced: the override
	// check compares a meeting with what THAT rule's top-up gave it.
	let toDelete: { id: string; scheduledAt: Date }[] = [];
	if (existing && patternChanged(existing, n)) {
		const club = await conn.query.clubs.findFirst({
			where: eq(clubs.id, clubId),
		});
		if (club) {
			toDelete = (
				await selectOldPatternMeetings(
					existing,
					clubId,
					club.timezone,
					now,
					conn,
					{ lock: true },
				)
			).deleted;
		}
	}

	await conn
		.insert(clubMeetingRecurrence)
		.values({ clubId, ...values })
		.onConflictDoUpdate({
			target: clubMeetingRecurrence.clubId,
			set: { ...values, updatedAt: new Date() },
		});

	await reconcileEmptyShells(
		conn,
		toDelete.map((m) => m.id),
	);

	await beforeTopUp?.();
	const { created } = await ensureScheduleToppedUp(clubId, now, conn);
	const rule = await getRecurrenceRule(clubId, conn);
	if (!rule) throw new Error("Rule vanished after save.");
	return { rule, created, deletedMeetingIds: toDelete.map((m) => m.id) };
}

/**
 * Upsert a club's standing rule, reconcile empty shells if the pattern changed,
 * and top the schedule up under the new rule, all in one transaction. `now` is
 * injectable for tests.
 */
export async function saveRecurrenceRule(
	clubId: string,
	input: RecurrenceRuleInput,
	now: Date = new Date(),
): Promise<SaveRuleResult> {
	return db.transaction((tx) => saveRecurrenceRuleIn(tx, clubId, input, now));
}

/** The nine rule fields a save takes, read off a stored row. */
export function ruleToInput(rule: RecurrenceRuleRow): RecurrenceRuleInput {
	return {
		mode: rule.mode,
		weekday: rule.weekday,
		intervalWeeks: rule.intervalWeeks,
		anchorDate: rule.anchorDate,
		ordinals: rule.ordinals,
		timeOfDay: rule.timeOfDay,
		location: rule.location,
		keepAhead: rule.keepAhead,
		enabled: rule.enabled,
	};
}

/** Delete a club's standing rule entirely. Existing meetings are left in place. */
export async function deleteRecurrenceRule(clubId: string): Promise<void> {
	await db
		.delete(clubMeetingRecurrence)
		.where(eq(clubMeetingRecurrence.clubId, clubId));
}
