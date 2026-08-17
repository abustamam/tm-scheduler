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
import type { AttendancePlanStatus as PlanStatus } from "./attendance-plan-logic";
import { listPlanForMeetings } from "./attendance-plan-logic";
import {
	isReadableClub,
	isReadableClubForMeeting,
} from "./club-readable-logic";
import { loadTmodMemberId } from "./meeting-authz-logic";
import {
	loadRosterWithContact,
	type RosterContact,
} from "./meeting-contacts-logic";
import { linkEvaluatorsToSpeakers } from "./meeting-create-logic";
import { freezeMeetingNumber } from "./meeting-number-logic";
import { closeAllVotesTx } from "./voting-logic";

export interface UpcomingMeetingRow {
	id: string;
	scheduledAt: Date;
	theme: string | null;
	location: string | null;
	status: (typeof meetings.$inferSelect)["status"];
	timezone: string;
	openSlots: number;
	totalSlots: number;
}

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
 *
 * The `Public` in the name is the convention every gated seam here follows
 * (`loadPublicClubRoles`, `loadPublicClubRoster`, `loadPublicSeasonGrid`,
 * `resolvePublicMeetingKey`). It is the only in-NAME signal that a seam is
 * archive-gated, and #544 happened because the gate was unfindable — so leaving
 * one of them unmarked would make a reader check the body instead of the name.
 */
export async function loadPublicUpcomingMeetings(
	clubId: string,
): Promise<UpcomingMeetingRow[]> {
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

/** Test seam for the meeting payload. `loadMeetingDetail` lives in the
 *  server-fn module and cannot be exported from there (server-modules guard),
 *  and a `createServerFn` handler is unreachable from vitest — so the payload's
 *  shape would otherwise have no gate at all. Uses the SAME two expressions as
 *  the real loader (`meetings.ts`) — deriving them differently here would only
 *  test this seam against itself. */
export async function loadMeetingDetailForTest(
	meetingId: string,
	opts: { canManage: boolean },
): Promise<{
	plan: { memberId: string; status: PlanStatus }[];
	answeredRungs: { memberId: string; status: "coming" | "not_coming" }[];
}> {
	const allRungs = (await listPlanForMeetings(db, [meetingId])).map(
		({ memberId, status }) => ({ memberId, status }),
	);
	const plan = opts.canManage ? allRungs : [];
	const answeredRungs = allRungs.filter(
		(r): r is { memberId: string; status: "coming" | "not_coming" } =>
			r.status !== "reached_out",
	);
	return { plan, answeredRungs };
}

/**
 * Everything this meeting's Toastmaster needs to run the planned-attendance
 * panel (#576): the whole plan ladder including the officer-only `reached_out`
 * rung, and the roster WITH contact so the WhatsApp/email drafts render.
 *
 * ONE fn returning both, rather than two, so the TMOD claim is verified in
 * exactly one place. Two gated readers would be two chances to gate one of them
 * differently, and the roster half is the more sensitive of the two.
 *
 * A separate reader rather than a widened `canManage` on the meeting payload,
 * and the distinction is the security-relevant part. `loadMeetingDetail` is a
 * public, session-less reader; its `plan` and `roster` gates are a SERVER-derived
 * boolean. Teaching it to also accept "…or the caller says they are the TMOD"
 * would put confidential data behind a client-supplied flag on the payload every
 * anonymous visitor already receives — one refactor away from shipping it to
 * everyone. Here the claim is checked against the slot before anything is
 * returned, and this fn returns NOTHING else, so there is no payload to leak into.
 *
 * PRIVACY NOTE, deliberate and worth knowing: this hands the TMOD every active
 * member's phone and email, which the product did not previously give them —
 * `loadMeetingDetail` blanks the roster for a non-officer precisely so contact
 * is never fetched for a public caller. Outreach is not possible without it, and
 * a TMOD already assigns roles and edits the meeting, but it IS a widening and
 * the honour-system identity below is what stands behind it.
 *
 * Returns empty arrays — never throws — for a non-TMOD, an unassigned slot, a
 * missing meeting, or an archived club, matching the gated-seam convention: a
 * caller who may not read this cannot tell those cases apart, and no call site
 * needs new error handling.
 */
export async function loadTmodPanelData(input: {
	meetingId: string;
	/** The caller's self-asserted member id. Honour-system on the anonymous path,
	 *  exactly as the agenda's TMOD editor is — see `resolveActor` in
	 *  `attendance-plan.ts` for the trust model this shares. */
	memberId: string;
}): Promise<{
	plan: { memberId: string; status: PlanStatus }[];
	roster: RosterContact[];
}> {
	const empty = { plan: [], roster: [] };
	// Archive gate FIRST: an archived club must not answer this any differently
	// than a club that never existed (#544).
	const meeting = await db.query.meetings.findFirst({
		columns: { clubId: true },
		where: eq(meetings.id, input.meetingId),
	});
	if (!meeting) return empty;
	if (!(await isReadableClubForMeeting(input.meetingId))) return empty;
	const tmodMemberId = await loadTmodMemberId(input.meetingId);
	// No slot assignee means no TMOD grant — never "anyone qualifies".
	if (!tmodMemberId || tmodMemberId !== input.memberId) return empty;
	const [rows, roster] = await Promise.all([
		listPlanForMeetings(db, [input.meetingId]),
		loadRosterWithContact(meeting.clubId),
	]);
	return {
		plan: rows.map(({ memberId, status }) => ({ memberId, status })),
		roster,
	};
}
