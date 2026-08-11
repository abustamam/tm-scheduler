// Meeting-management DB logic, split out from the createServerFn wrappers in
// `meetings.ts` (which the server-modules guard test forbids from exporting
// db-touching functions). Directly integration-testable by mocking `#/db`.
import { and, asc, eq, gte, ne, sql } from "drizzle-orm";
import { db } from "#/db";
import { clubs, meetings, roleDefinitions, roleSlots } from "#/db/schema";
import { generateSlotRows } from "#/lib/agenda";
import { zonedWallTimeToUtc } from "#/lib/datetime";
import { meetingDateReached } from "#/lib/meeting-lifecycle";
import { logActivity } from "./activity";
import { isReadableClub } from "./club-readable-logic";
import { linkEvaluatorsToSpeakers } from "./meeting-create-logic";
import { freezeMeetingNumber } from "./meeting-number-logic";
import { closeAllVotesTx } from "./voting-logic";

/**
 * Upcoming, non-cancelled meetings for a club, each with an open-slot count —
 * the seam behind the PUBLIC, session-less `listUpcomingMeetings`. The exact
 * complement of `loadPastMeetings` on the instant axis (`gte(scheduledAt, now)`
 * vs `lt(scheduledAt, before)`); see that module's header for why neither uses
 * `isMeetingOver`.
 *
 * Returns `[]` for an archived (or unknown) club (#544). Lifted out of the
 * `createServerFn` handler for the reason this module exists at all: a handler
 * body is unreachable from a test, so the gate would have been unassertable
 * where the query used to sit.
 */
export async function loadUpcomingMeetings(clubId: string) {
	if (!(await isReadableClub(clubId))) return [];
	return db
		.select({
			id: meetings.id,
			scheduledAt: meetings.scheduledAt,
			theme: meetings.theme,
			location: meetings.location,
			status: meetings.status,
			timezone: clubs.timezone,
			openSlots: sql<number>`count(*) filter (where ${roleSlots.status} = 'open')::int`,
			totalSlots: sql<number>`count(${roleSlots.id})::int`,
		})
		.from(meetings)
		.innerJoin(clubs, eq(clubs.id, meetings.clubId))
		.leftJoin(roleSlots, eq(roleSlots.meetingId, meetings.id))
		.where(
			and(
				eq(meetings.clubId, clubId),
				gte(meetings.scheduledAt, new Date()),
				ne(meetings.status, "cancelled"),
			),
		)
		.groupBy(meetings.id, clubs.timezone)
		.orderBy(asc(meetings.scheduledAt));
}

export interface MeetingCreateInput {
	clubId: string;
	/** HTML datetime-local value, interpreted in the club timezone. */
	scheduledAt: string;
	theme?: string | null;
	location?: string | null;
	wordOfTheDay?: string | null;
	notes?: string | null;
}

/**
 * Create a meeting and auto-generate its slots from the club's role template.
 * The meeting's length is copied from the club's `defaultMeetingMinutes` at
 * insert (copy-at-insert) so a later club-default change never moves this
 * meeting's end time.
 */
export async function applyCreateMeeting(input: MeetingCreateInput) {
	const club = await db.query.clubs.findFirst({
		where: eq(clubs.id, input.clubId),
	});
	if (!club) throw new Error("Club not found.");
	const scheduledAt = zonedWallTimeToUtc(input.scheduledAt, club.timezone);

	const defs = await db
		.select()
		.from(roleDefinitions)
		.where(eq(roleDefinitions.clubId, input.clubId))
		.orderBy(asc(roleDefinitions.sortOrder));

	return db.transaction(async (tx) => {
		const [meeting] = await tx
			.insert(meetings)
			.values({
				clubId: input.clubId,
				scheduledAt,
				lengthMinutes: club.defaultMeetingMinutes,
				location: input.location?.trim() || null,
				theme: input.theme?.trim() || null,
				wordOfTheDay: input.wordOfTheDay?.trim() || null,
				notes: input.notes?.trim() || null,
			})
			.returning({ id: meetings.id });

		const slotRows = generateSlotRows(defs, meeting.id);
		if (slotRows.length > 0) {
			const inserted = await tx.insert(roleSlots).values(slotRows).returning({
				id: roleSlots.id,
				roleDefinitionId: roleSlots.roleDefinitionId,
				slotIndex: roleSlots.slotIndex,
			});
			// Same linking as the batch/top-up path (#512) — shared rather than
			// reimplemented, so the two creation routes cannot drift.
			await linkEvaluatorsToSpeakers(tx, inserted, defs);
		}
		return { meetingId: meeting.id };
	});
}

export interface MeetingUpdateInput {
	meetingId: string;
	actorMemberId: string | null;
	/** HTML datetime-local value, interpreted in the club timezone. */
	scheduledAt: string;
	/** Meeting length in minutes. Omit to leave the current length unchanged. */
	lengthMinutes?: number | null;
	theme?: string | null;
	location?: string | null;
	wordOfTheDay?: string | null;
	wodDefinition?: string | null;
	wodExample?: string | null;
	notes?: string | null;
	reminders?: string | null;
	/** The club's meeting number (#358). Omit to leave the current one alone;
	 *  pass null to clear it back to provisional/derived. */
	meetingNumber?: number | null;
	/**
	 * Whether the caller may reschedule (change `scheduledAt`/`lengthMinutes`).
	 * Defaults to true (admin). A self-serve TMOD passes false: an attempt to
	 * move the date/time or length is rejected — reschedule stays admin-only
	 * (ADR-0010).
	 */
	canReschedule?: boolean;
}

/** Update a meeting's meta (incl. reschedule) and log a `meeting_edit`. */
export async function applyMeetingUpdate(input: MeetingUpdateInput) {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, input.meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");
	const club = await db.query.clubs.findFirst({
		where: eq(clubs.id, meeting.clubId),
	});
	if (!club) throw new Error("Club not found.");

	const next = {
		scheduledAt: zonedWallTimeToUtc(input.scheduledAt, club.timezone),
		// Keep the current length when the caller omits it (null/undefined).
		lengthMinutes:
			input.lengthMinutes != null ? input.lengthMinutes : meeting.lengthMinutes,
		theme: input.theme?.trim() || null,
		location: input.location?.trim() || null,
		wordOfTheDay: input.wordOfTheDay?.trim() || null,
		wodDefinition: input.wodDefinition?.trim() || null,
		wodExample: input.wodExample?.trim() || null,
		notes: input.notes?.trim() || null,
		reminders: input.reminders?.trim() || null,
		// Omitted (undefined) leaves the stored number untouched — the dialog only
		// sends this field when the admin actually typed one (#358).
		meetingNumber:
			input.meetingNumber === undefined
				? meeting.meetingNumber
				: input.meetingNumber,
	};

	// Reschedule (date/time or length change) is an admin-only decision. A
	// self-serve TMOD (canReschedule=false) may edit meta but must re-submit the
	// meeting's current time unchanged; any actual move is rejected (ADR-0010).
	const canReschedule = input.canReschedule ?? true;
	if (!canReschedule) {
		// datetime-local input is minute-precision, so compare to the minute:
		// re-submitting the current time (rounded) is a no-op, not a reschedule.
		const toMinute = (d: Date) => Math.floor(d.getTime() / 60000);
		const timeChanged =
			toMinute(next.scheduledAt) !== toMinute(meeting.scheduledAt);
		const lengthChanged = next.lengthMinutes !== meeting.lengthMinutes;
		if (timeChanged || lengthChanged) {
			throw new Error(
				"Only an admin or VP Education can reschedule this meeting.",
			);
		}
	}

	await db.transaction(async (tx) => {
		await tx.update(meetings).set(next).where(eq(meetings.id, input.meetingId));
		await logActivity(tx, {
			clubId: meeting.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: {
				before: {
					theme: meeting.theme,
					wordOfTheDay: meeting.wordOfTheDay,
					wodDefinition: meeting.wodDefinition,
					wodExample: meeting.wodExample,
					location: meeting.location,
					notes: meeting.notes,
					reminders: meeting.reminders,
					scheduledAt: meeting.scheduledAt,
					lengthMinutes: meeting.lengthMinutes,
				},
				after: next,
			},
		});
	});

	return { clubId: meeting.clubId };
}

export interface WordOfTheDayUpdateInput {
	meetingId: string;
	actorMemberId: string | null;
	wordOfTheDay?: string | null;
	wodDefinition?: string | null;
	wodExample?: string | null;
}

/**
 * Update ONLY a meeting's Word of the Day (word + definition + example) and log
 * a `meeting_edit` (#296). Least-privilege by construction: the narrow WOD-edit
 * capability (grammarian / TMOD / admin) funnels through here, and this function
 * physically cannot touch theme/location/times/notes — so granting it never
 * risks the rest of the meeting meta. Empty values trim to null.
 */
export async function applyWordOfTheDayUpdate(input: WordOfTheDayUpdateInput) {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, input.meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");

	const next = {
		wordOfTheDay: input.wordOfTheDay?.trim() || null,
		wodDefinition: input.wodDefinition?.trim() || null,
		wodExample: input.wodExample?.trim() || null,
	};

	await db.transaction(async (tx) => {
		await tx.update(meetings).set(next).where(eq(meetings.id, input.meetingId));
		await logActivity(tx, {
			clubId: meeting.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: {
				before: {
					wordOfTheDay: meeting.wordOfTheDay,
					wodDefinition: meeting.wodDefinition,
					wodExample: meeting.wodExample,
				},
				after: next,
			},
		});
	});

	return { clubId: meeting.clubId };
}

/**
 * Close out a meeting: set `status = completed`, which locks its agenda from
 * further edits (#150). Guarded to the meeting's scheduled date being today or
 * past (in the club timezone) so an upcoming meeting can't be locked by
 * accident. Idempotent-ish: re-completing an already-completed meeting is a
 * no-op update. Speech-delivered derivation is unchanged (date-based, ADR-0009).
 */
export async function applyCompleteMeeting(input: {
	meetingId: string;
	actorMemberId: string | null;
}) {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, input.meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");
	const club = await db.query.clubs.findFirst({
		where: eq(clubs.id, meeting.clubId),
	});
	if (!club) throw new Error("Club not found.");
	if (!meetingDateReached(meeting.scheduledAt, club.timezone)) {
		throw new Error(
			"You can only complete a meeting on or after its scheduled date.",
		);
	}

	await db.transaction(async (tx) => {
		await tx
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, input.meetingId));
		// Digital voting (#510): a meeting that has been closed out cannot still be
		// voted on from the parking lot. In the SAME transaction as the status
		// change, or a ballot slips through the gap. Deliberately not routed through
		// `closeVote`, which asserts the lock this very statement is applying.
		await closeAllVotesTx(tx, input.meetingId);
		await logActivity(tx, {
			clubId: meeting.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: { change: "completed" },
		});
	});

	// The meeting is history now, so its number stops being provisional and is
	// frozen onto the row (#358) — becoming the anchor the next meetings count
	// from. Deliberately AFTER the commit and non-fatal: if it fails, the number
	// simply stays derived, which still displays correctly.
	await freezeMeetingNumber(input.meetingId);

	return { clubId: meeting.clubId };
}

/**
 * Reopen a completed meeting back to `scheduled` so an admin can amend it, then
 * complete it again (#150). No date guard — reopen is available any time,
 * admin-only.
 */
export async function applyReopenMeeting(input: {
	meetingId: string;
	actorMemberId: string | null;
}) {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, input.meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");

	await db.transaction(async (tx) => {
		await tx
			.update(meetings)
			.set({ status: "scheduled" })
			.where(eq(meetings.id, input.meetingId));
		await logActivity(tx, {
			clubId: meeting.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: { change: "reopened" },
		});
	});

	return { clubId: meeting.clubId };
}
