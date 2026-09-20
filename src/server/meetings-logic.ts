// Meeting-management DB logic, split out from the createServerFn wrappers in
// `meetings.ts` (which the server-modules guard test forbids from exporting
// db-touching functions). Directly integration-testable by mocking `#/db`.
import { and, asc, eq, gte, ne, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	clubs,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { generateSlotRows } from "#/lib/agenda";
import { zonedWallTimeToUtc } from "#/lib/datetime";
import { isMeetingLocked, meetingDateReached } from "#/lib/meeting-lifecycle";
import { normalizePresentationUrl } from "#/lib/presentation-url";
import { logActivity } from "./activity";
import type { AttendancePlanStatus as PlanStatus } from "./attendance-plan-logic";
import { listPlanForMeetings } from "./attendance-plan-logic";
import { isReadableClub } from "./club-readable-logic";
import { getMembership } from "./guards";
import { loadTmodMemberId } from "./meeting-authz-logic";
import {
	loadRosterWithContact,
	type RosterContact,
} from "./meeting-contacts-logic";
import { linkEvaluatorsToSpeakers } from "./meeting-create-logic";
import { freezeMeetingNumber } from "./meeting-number-logic";
import { loadPublicClubRoster } from "./members-logic";
import { closeAllVotesTx } from "./voting-logic";

/**
 * A connection: the pool, or a transaction handle (mirrors
 * `meeting-create-logic.ts`). Only `applyMeetingMetaPatch` takes one today —
 * see the note on its `conn` parameter.
 */
type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

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
	/** Raw video-call join link (#731) — normalized here, never trusted as typed. */
	joinUrl?: string | null;
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
				// Server-authoritative (#731): the client runs the same function for
				// a fast error message, but THIS is the value that is stored.
				joinUrl: normalizePresentationUrl(input.joinUrl),
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

/**
 * A meeting-meta PATCH (#772). Every FREE-TEXT field is a TRI-STATE, and the
 * distinction is the whole point of this interface:
 *
 *   omitted / `undefined`  leave the stored value alone
 *   `null` or blank        clear it
 *   a value                store it, trimmed
 *
 * The two NUMERIC fields are not tri-states and do not generalise from the
 * seven above. `meetingNumber` clears on null (back to derived, #358), but
 * `lengthMinutes` has nothing to clear TO — `meetings.length_minutes` is
 * `notNull().default(90)` — so for it omission is the only "leave it alone" and
 * there is no null state at all. `scheduledAt` is the same: a wall-time string
 * resolved against the club's timezone, with no "clear the date". Tidying
 * `lengthMinutes`'s `!= null` into `!== undefined` to match the loop would
 * write NULL into a NOT NULL column; the integration suite pins that.
 *
 * This replaced a full-REPLACE writer that wrote `theme: input.theme?.trim() ||
 * null` and the identical line for six more free-text columns, so omission
 * meant *null it*. A one-field editor therefore had to echo six values it was
 * not editing (via an echo helper, deleted with this change) or silently erase
 * the club's location, Word of the Day, announcements and notes while
 * reporting success. Worse, that echo was a page-load SNAPSHOT: a Toastmaster
 * saving a theme wrote back the Word of the Day as it had been when their page
 * loaded, reverting a Grammarian's save from ten minutes earlier — a LOST
 * UPDATE, one-directional, on two duties usually done the same evening.
 *
 * The patch closes both by never naming a column it was not given: the `set`
 * this builds is SPARSE, so an untouched column is absent from the SQL rather
 * than rewritten with a value the caller believed was current.
 */
export interface MeetingMetaPatchInput {
	meetingId: string;
	actorMemberId: string | null;
	/** HTML datetime-local value, interpreted in the club timezone. Omit to keep
	 *  the current time — a partial editor no longer has to resubmit it, which is
	 *  what the `canReschedule` comparison below used to force. */
	scheduledAt?: string;
	/** Meeting length in minutes. Omit to leave the current length unchanged.
	 *  NOT nullable, unlike the free-text fields: the column is `notNull()` with
	 *  a default, and the wire schema has no `.nullable()` either. */
	lengthMinutes?: number;
	theme?: string | null;
	location?: string | null;
	/** Raw video-call join link (#731). Normalized by
	 *  `normalizePresentationUrl`, so `"tbd"`, `"n/a"` and
	 *  `"javascript:alert(1)"` all clear it — but OMITTING it now preserves the
	 *  stored link, which for an online-only club is the room itself. */
	joinUrl?: string | null;
	wordOfTheDay?: string | null;
	wodDefinition?: string | null;
	wodExample?: string | null;
	notes?: string | null;
	reminders?: string | null;
	/** The club's meeting number (#358). Omit to leave the current one alone;
	 *  pass null to clear it back to provisional/derived. ADMIN-ONLY — gated by
	 *  `canReschedule` below, which is why it is the one patch field a self-serve
	 *  TMOD cannot send at all. */
	meetingNumber?: number | null;
	/**
	 * Whether the caller holds the ADMIN grant. Defaults to true (admin). A
	 * self-serve TMOD passes false, and three fields are then refused:
	 * `scheduledAt` and `lengthMinutes` (rescheduling is a club decision,
	 * ADR-0010) and `meetingNumber` (#792).
	 *
	 * The name says "reschedule" because that was the first field it gated; read
	 * it as "this caller is an admin". `updateMeeting` derives it from
	 * `authz.via === "admin"` and nothing else, so it is the admin arm of the
	 * meeting-agenda authz rather than a per-field capability.
	 *
	 * `meetingNumber` joined the list late and the omission was NOT cosmetic:
	 * `deriveMeetingNumber` treats a stored number as the ANCHOR later meetings
	 * count forward from, so ONE write renumbers every later un-numbered meeting
	 * in the club (and null un-anchors an admin's frozen number). The
	 * `tmod-self-assert` arm grants with no session at all, so before #792 an
	 * anonymous holder of a meeting's public link who could name the Toastmaster's
	 * member id could renumber the club's season.
	 */
	canReschedule?: boolean;
}

/** The free-text columns the patch owns, each with the same tri-state. Listed
 *  once so the loop below and the audit entry cannot disagree about the set. */
const META_TEXT_FIELDS = [
	"theme",
	"location",
	"wordOfTheDay",
	"wodDefinition",
	"wodExample",
	"notes",
	"reminders",
] as const;

/** Update a meeting's meta (incl. reschedule) and log a `meeting_edit`.
 *  Omitted fields are left alone — see `MeetingMetaPatchInput`.
 *
 *  `conn` defaults to `db` and every browser caller leaves it so. It exists for
 *  `upsert_agendas` (#808), whose apply already holds the club's advisory lock
 *  inside a transaction of its own: calling this on `db` from in there would
 *  write on a SECOND pooled connection while that lock is held, and — worse —
 *  those writes would not roll back with the batch, which is the whole
 *  all-or-nothing guarantee. Passing `tx` makes the UPDATE and its
 *  `meeting_edit` part of the caller's transaction; drizzle turns the inner
 *  `conn.transaction` below into a SAVEPOINT rather than a second one. */
export async function applyMeetingMetaPatch(
	input: MeetingMetaPatchInput,
	conn: DbOrTx = db,
) {
	// ONE round trip, not two. The club is needed for its timezone alone, and
	// only when the caller sent `scheduledAt` — which since #772 the focused
	// editors never do. `meetings.club_id` is `notNull().references(clubs.id)`,
	// so the relation always resolves.
	const meeting = await conn.query.meetings.findFirst({
		where: eq(meetings.id, input.meetingId),
		with: { club: true },
	});
	if (!meeting) throw new Error("Meeting not found.");
	const club = meeting.club;
	if (!club) throw new Error("Club not found.");

	// SPARSE by construction: a key is present only because the caller sent that
	// field. `Partial<>` rather than the full row type is the type-level half of
	// the same claim.
	const next: Partial<typeof meetings.$inferInsert> = {};
	for (const field of META_TEXT_FIELDS) {
		const value = input[field];
		// Blank and whitespace-only collapse to null alongside an explicit null:
		// the officer clearing an input and the caller passing null are the same
		// edit, and every reader of these columns already treats "" as absent.
		if (value !== undefined) next[field] = value?.trim() || null;
	}
	if (input.joinUrl !== undefined) {
		// Server-authoritative (#731). Reuses the `speeches.presentation_url`
		// validator rather than growing a second one.
		next.joinUrl = normalizePresentationUrl(input.joinUrl);
	}
	if (input.scheduledAt !== undefined) {
		next.scheduledAt = zonedWallTimeToUtc(input.scheduledAt, club.timezone);
	}
	if (input.lengthMinutes != null) next.lengthMinutes = input.lengthMinutes;
	if (input.meetingNumber !== undefined) {
		next.meetingNumber = input.meetingNumber;
	}

	// Reschedule (date/time or length change) is an admin-only decision. A
	// self-serve TMOD (canReschedule=false) may edit meta but must not move the
	// meeting; any actual move is rejected (ADR-0010). Omitting both fields is
	// the ordinary partial-editor case and reaches this check as "no move".
	const canReschedule = input.canReschedule ?? true;
	if (!canReschedule) {
		// The meeting number is admin-only too (#792), and unlike the two below it
		// is refused on PRESENCE rather than on an actual change. The leniency
		// below exists only because the dialog resubmits the stored time on every
		// save; NO non-admin surface sends a number at all — the input lives inside
		// the dialog's `canReschedule` branch and `meetingUpdateFromForm` maps an
		// unrendered input to `undefined` — so "sent it" and "changed it" are the
		// same event here, and the stricter form is the one that cannot be walked
		// past by guessing the stored value.
		//
		// Its own message, not the reschedule one: an officer told they may not
		// "reschedule" after touching a number would go looking for a date they
		// never typed.
		if (input.meetingNumber !== undefined) {
			throw new Error(
				"Only an admin or VP Education can set this meeting's number.",
			);
		}
		// datetime-local input is minute-precision, so compare to the minute:
		// re-submitting the current time (rounded) is a no-op, not a reschedule.
		// The dialog still sends it, so this arm has to stay.
		const toMinute = (d: Date) => Math.floor(d.getTime() / 60000);
		const timeChanged =
			next.scheduledAt !== undefined &&
			toMinute(next.scheduledAt) !== toMinute(meeting.scheduledAt);
		const lengthChanged =
			next.lengthMinutes !== undefined &&
			next.lengthMinutes !== meeting.lengthMinutes;
		if (timeChanged || lengthChanged) {
			throw new Error(
				"Only an admin or VP Education can reschedule this meeting.",
			);
		}
	}

	// Drop keys whose value is ALREADY what is stored. Deliberately after the
	// authorization check above, so that check sees exactly what the caller sent
	// rather than what survived a normalization step.
	//
	// This is what makes "the entry is the diff" true for the DIALOG too, not just
	// for a one-field editor. The dialog prefills every input from the row and
	// resubmits the lot, so without this every admin save named all eleven columns
	// in its `meeting_edit` entry — indistinguishable from the pre-#772 full-row
	// snapshot — and an officer reading the activity log to find who changed the
	// location could not tell which entry did it. It also stops the UPDATE naming
	// columns nothing changed.
	for (const key of Object.keys(next) as (keyof typeof next)[]) {
		const proposed = next[key];
		const stored = meeting[key as keyof typeof meeting];
		const unchanged =
			proposed instanceof Date && stored instanceof Date
				? proposed.getTime() === stored.getTime()
				: proposed === stored;
		if (unchanged) delete next[key];
	}

	// An empty patch is a save with nothing in it — a `set` with no keys is a
	// drizzle error, and an audit entry naming no change is noise. Reachable from
	// the dialog now that an unchanged resubmit drops out above.
	const changed = Object.keys(next) as (keyof typeof next)[];
	if (changed.length === 0) return { clubId: meeting.clubId };

	await conn.transaction(async (tx) => {
		await tx.update(meetings).set(next).where(eq(meetings.id, input.meetingId));
		// `before` mirrors `after` key for key, and both name only what actually
		// MOVED (unchanged keys were dropped above) — so the entry reads as the
		// diff it is rather than eleven columns of which two changed.
		const before: Record<string, unknown> = {};
		for (const key of changed)
			before[key] = meeting[key as keyof typeof meeting];
		await logActivity(tx, {
			clubId: meeting.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: { before, after: next },
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
 * Switch digital voting off (or back on) for ONE meeting (#770). Caller enforces
 * admin authz — see `setMeetingDigitalVoting`, which deliberately does NOT take
 * the self-asserted-Toastmaster path `updateMeeting` does: an unauthenticated
 * caller must not be able to shut a room's vote.
 *
 * Switching off closes every open vote in the SAME transaction, like completing
 * a meeting does: the switch always takes effect, and a ballot racing it is
 * refused by `castVote`'s atomic insert rather than slipping in after. Votes
 * already cast are kept — switching back on and reopening a category reuses
 * its session. Switching back on reopens nothing.
 *
 * Only the MEETING's half of the rule. A club with digital voting off stays off
 * here whatever this writes (`isDigitalVotingOn`).
 */
export async function applyMeetingDigitalVoting(input: {
	meetingId: string;
	disabled: boolean;
	actorMemberId: string | null;
}): Promise<void> {
	await db.transaction(async (tx) => {
		const [meeting] = await tx
			.update(meetings)
			.set({ digitalVotingDisabled: input.disabled })
			.where(eq(meetings.id, input.meetingId))
			.returning({ clubId: meetings.clubId });
		if (!meeting) throw new Error("Meeting not found.");
		if (input.disabled) await closeAllVotesTx(tx, input.meetingId);
		await logActivity(tx, {
			clubId: meeting.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: {
				change: input.disabled
					? "digital_voting_disabled"
					: "digital_voting_enabled",
			},
		});
	});
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
 * panel (#576): the plan ladder including the officer-private `reached_out`
 * rung, and — for a SIGNED-IN Toastmaster only — the roster with contact so the
 * WhatsApp/email drafts render.
 *
 * THE TWO HALVES HAVE DIFFERENT TRUST LEVELS, and that asymmetry is the whole
 * design. `memberId` is an honour-system claim: the caller asserts it and this
 * function checks it against the meeting's Toastmaster slot, but nothing proves
 * they are that person — and the id is not even secret, since `loadMeetingDetail`
 * publishes it as `assigneeId` on the public payload and the roster picker hands
 * any visitor any member's id. So:
 *
 *  · The LADDER rides the honour-system claim. Same basis as
 *    `resolveMeetingAgendaAuthz`'s self-asserted TMOD editor, and the same shape
 *    of exposure: who has been asked to a meeting, for one meeting.
 *  · The CONTACT ROSTER requires a real session whose own membership IS the
 *    Toastmaster. It never rides the claim. `getPublicMeetingByKey` states the
 *    rule this obeys: "The soft honor-system gate on `/club/:clubId` must never
 *    carry PII (#37 / PR #284)." An earlier cut of this function returned the
 *    roster on the bare claim, which made one click from the public roster picker
 *    a bulk dump of every active member's phone and email.
 *
 * Three further bounds, each closing a way the grant outlived its purpose:
 * the claimed member must still be ACTIVE (deactivation frees only UPCOMING
 * slots — `members-logic.ts` preserves past ones as history — so without this an
 * ex-member keeps a permanent key), the meeting must not be locked, and the club
 * must not be archived.
 *
 * Returns empty arrays — never throws — for every denial, matching the
 * gated-seam convention: a caller who may not read this cannot tell the cases
 * apart, and no call site needs new error handling.
 */
export async function loadTmodPanelData(input: {
	meetingId: string;
	/** The caller's self-asserted member id. Gates the LADDER only. */
	memberId: string;
	/** The signed-in user id, or null. Resolved by the CALLER so this module
	 *  stays callable from vitest with no request context. Gates the ROSTER. */
	sessionUserId: string | null;
}): Promise<{
	plan: { memberId: string; status: PlanStatus }[];
	roster: RosterContact[];
}> {
	const empty = { plan: [], roster: [] };
	// ONE round trip for club, archive state and meeting status. The previous cut
	// fetched the meeting and then called `isReadableClubForMeeting`, which
	// re-joined meetings→clubs to re-derive the same clubId.
	const [row] = await db
		.select({
			clubId: meetings.clubId,
			status: meetings.status,
			archivedAt: clubs.archivedAt,
		})
		.from(meetings)
		.innerJoin(clubs, eq(clubs.id, meetings.clubId))
		.where(eq(meetings.id, input.meetingId))
		.limit(1);
	if (!row) return empty;
	// Archive gate: an archived club answers exactly like one that never existed.
	if (row.archivedAt !== null) return empty;
	// A locked meeting has no planning left to do, and the panel is
	// `upcoming`-only anyway — but that bound is CLIENT-side, and this fn is
	// addressable directly, so without this every meeting the club ever held
	// stays a live grant.
	if (isMeetingLocked(row.status)) return empty;

	const tmodMemberId = await loadTmodMemberId(input.meetingId);
	// No slot assignee means no grant — never "anyone qualifies".
	if (!tmodMemberId || tmodMemberId !== input.memberId) return empty;
	// Still on the roster? The write path gets this from `requireMemberInClub`;
	// comparing ids alone would let a departed ex-Toastmaster keep reading.
	const [claimed] = await db
		.select({ status: members.status })
		.from(members)
		.where(and(eq(members.id, tmodMemberId), eq(members.clubId, row.clubId)))
		.limit(1);
	if (!claimed || claimed.status !== "active") return empty;

	// The ladder: granted on the honour-system claim above.
	const plan = (await listPlanForMeetings(db, [input.meetingId])).map(
		({ memberId, status }) => ({ memberId, status }),
	);

	// CONTACT is granted only to a real session that IS this Toastmaster. A
	// signed-in club member who is not the TMOD gets names and no contact, so this
	// gate and the write gate answer the same way for the same person — the "two
	// gates disagree" shape #560 records.
	const membership = input.sessionUserId
		? await getMembership(input.sessionUserId, row.clubId)
		: null;
	const contactAllowed =
		membership?.status === "active" && membership.id === tmodMemberId;
	if (contactAllowed) {
		return { plan, roster: await loadRosterWithContact(row.clubId) };
	}

	// NAMES without contact for everyone else who cleared the checks above.
	// Returning `[]` here looked safe and was wrong: `buildPlanPanel` builds its
	// rows FROM the roster, so an empty roster renders a panel with no rows at all
	// — withholding the ladder the caller is entitled to, not just the PII. Names
	// are already public (`loadPublicClubRoster` serves them to anyone), so the
	// honest shape is every row present with `phone`/`email` null, which renders
	// "No contact on file" and keeps the rungs usable.
	const names = await loadPublicClubRoster(row.clubId);
	return {
		plan,
		roster: names.map((m) => ({
			id: m.id,
			name: m.name,
			phone: null,
			email: null,
			preferredName: null,
		})),
	};
}
