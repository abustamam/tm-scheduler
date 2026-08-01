// VP-Membership guest-pipeline DB logic (#208 / ADR-0018), split out from the
// createServerFn wrappers in `guest-pipeline.ts` (a client-imported module the
// guard test forbids from exporting db-touching functions). Integration-testable
// by mocking `#/db`. See the header of `members-logic.ts` for the why.
import {
	and,
	asc,
	count,
	eq,
	isNotNull,
	isNull,
	min,
	ne,
	sql,
} from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";
import { db } from "#/db";
import {
	clubs,
	guests,
	meetingAttendance,
	meetings,
	members,
	people,
	roleSlots,
	tableTopicsSpeakers,
} from "#/db/schema";
import { namesAgree } from "#/lib/person-name";
import { toStoredPhone } from "#/lib/phone";
import { logActivity } from "./activity";
import { loadClubDefaultCountryCode } from "./clubs-logic";

/** The pipeline stages a guest may occupy (#208 / ADR-0018). */
export type GuestStage = "prospect" | "following_up" | "joined" | "lost";

/**
 * Stages an admin may set manually. `joined` is deliberately excluded — it is
 * reached only through convert-to-member (which also stamps the membership
 * pointer), never a bare stage change.
 */
export type ManualGuestStage = "prospect" | "following_up" | "lost";

/**
 * Digits-only form of a phone number, so formatting variants dedupe/match.
 *
 * ALWAYS apply this to the E.164 value (`toStoredPhone(raw, cc)`), never to raw
 * input: the digits of `+1 (555) 123-4567` and of `(555) 123-4567` differ, and
 * that mismatch is the whole of #397. Since `loadClubDefaultCountryCode` now
 * always yields a country code, the E.164 promotion always applies and the two
 * converge on `15551234567`.
 *
 * The key is the digits of the FULL international number, deliberately — not the
 * last 10 digits. A suffix compare would merge `+1 20 7946 0958` with
 * `+44 20 7946 0958`, two different people's phones.
 */
export function normalizePhone(phone: string | null | undefined): string {
	return (phone ?? "").replace(/\D/g, "");
}

/**
 * How many same-phone rows a dedup scan will consider.
 *
 * Qualifying a phone match by name (#488) means reading every row that shares
 * the number instead of one — and on the Person side that table is global, not
 * club-scoped. A number shared by more than a handful of humans is a shared
 * line or bad data, not a dedup signal, so the tail is worthless anyway. Rows
 * are ordered oldest-first, and overrunning the cap only ever means "no match"
 * — which creates a fresh Person, the recoverable direction (ADR-0008).
 */
const PHONE_CANDIDATE_LIMIT = 50;

/** Either the main db client or a drizzle transaction (see `activity.ts`). */
type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/** The guest row `findGuestByContact` resolves: identity + the dedup keys. */
type GuestContactRow = {
	id: string;
	name: string;
	email: string | null;
	phone: string | null;
};

/**
 * The club guest matching an email, or a phone whose name also agrees — the ONE
 * dedup key for guests, used both by guest-book capture (to reuse the row) and
 * by the edit path (to refuse creating a second row that would match). Email
 * leads over phone, mirroring `applyConvertGuestToMember`'s Person dedup.
 *
 * The name check on the phone branch is the same guard as the Person dedup, for
 * the same reason (#488): a spouse or coworker signing the guest book with the
 * shared number they already gave is TWO prospects, and collapsing them into one
 * row silently merges their attendance and understates the VP-Membership funnel.
 * `opts.name` is the name the caller is presenting; a phone hit whose stored
 * name disagrees is passed over, not returned.
 *
 * `opts.digits` is the caller's number in E.164 digits; the SQL compares it
 * against the STORED phone's digits. Both sides therefore have to be E.164 for
 * the compare to mean anything — writes are (every path funnels through
 * `toStoredPhone` with a never-null country code), and rows written before that
 * are brought over by `scripts/backfill-phone-e164.ts` (#397).
 *
 * Ordered oldest-first and tie-broken on id: without an ORDER BY, a `limit(1)`
 * over two matching rows is a Postgres coin flip, so a returning visitor's
 * history would split nondeterministically across them.
 */
async function findGuestByContact(
	conn: DbOrTx,
	clubId: string,
	opts: {
		digits: string;
		email: string | null;
		name: string;
		excludeGuestId?: string;
	},
): Promise<GuestContactRow | undefined> {
	const cols = {
		id: guests.id,
		name: guests.name,
		email: guests.email,
		phone: guests.phone,
	};
	const scope = opts.excludeGuestId
		? and(eq(guests.clubId, clubId), ne(guests.id, opts.excludeGuestId))
		: eq(guests.clubId, clubId);
	const order = [asc(guests.createdAt), asc(guests.id)] as const;

	if (opts.email) {
		const [byEmail] = await conn
			.select(cols)
			.from(guests)
			.where(
				and(scope, sql`lower(${guests.email}) = ${opts.email.toLowerCase()}`),
			)
			.orderBy(...order)
			.limit(1);
		if (byEmail) return byEmail;
	}
	if (opts.digits) {
		// Candidates, not a result: take the oldest whose name agrees.
		const byPhone = await conn
			.select(cols)
			.from(guests)
			.where(
				and(
					scope,
					sql`regexp_replace(coalesce(${guests.phone}, ''), '[^0-9]', '', 'g') = ${opts.digits}`,
				),
			)
			.orderBy(...order)
			.limit(PHONE_CANDIDATE_LIMIT);
		const match = byPhone.find((g) => namesAgree(g.name, opts.name));
		if (match) return match;
	}
	return undefined;
}

/** `YYYY-MM-DD` for an instant in a timezone (locale `en-CA` yields ISO order). */
function localDateKey(instant: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(instant);
}

/** A club's IANA timezone (the schema default when the club is missing). Every
 *  "has this meeting happened?" question is answered in the CLUB's local day —
 *  see `guestVisits` — so the zone is read once and threaded through. */
async function loadClubTimeZone(clubId: string): Promise<string> {
	const [club] = await db
		.select({ timezone: clubs.timezone })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	return club?.timezone ?? "America/Chicago";
}

/**
 * The club's current/nearest meeting for guest-book capture: a non-cancelled
 * meeting scheduled for TODAY in the club's timezone (even earlier today — the
 * guest is at it now), else the next upcoming scheduled meeting. Returns null
 * when neither exists (capture then records the guest with no attendance row).
 */
export async function resolveCurrentMeetingId(
	clubId: string,
): Promise<string | null> {
	const timeZone = await loadClubTimeZone(clubId);

	const rows = await db
		.select({ id: meetings.id, scheduledAt: meetings.scheduledAt })
		.from(meetings)
		.where(and(eq(meetings.clubId, clubId), ne(meetings.status, "cancelled")))
		.orderBy(asc(meetings.scheduledAt));
	if (rows.length === 0) return null;

	const now = new Date();
	const todayKey = localDateKey(now, timeZone);
	const todays = rows.find(
		(r) => localDateKey(r.scheduledAt, timeZone) === todayKey,
	);
	if (todays) return todays.id;

	const upcoming = rows.find((r) => r.scheduledAt.getTime() >= now.getTime());
	return upcoming?.id ?? null;
}

export interface CaptureGuestInput {
	clubId: string;
	name: string;
	email?: string | null;
	phone?: string | null;
}

export interface CaptureGuestResult {
	guestId: string;
	/** True when a brand-new guest row was created (vs. reusing a dedup match). */
	created: boolean;
	/** True when a new attendance row was written for the resolved meeting. */
	attendanceRecorded: boolean;
	meetingId: string | null;
}

/**
 * Guest-book capture (the public #239 front door). Create-or-find a club guest,
 * then record a visit against the club's current/nearest meeting.
 *
 * Dedup key is EMAIL first, then a PHONE whose name also agrees (#488) — a
 * match reuses the existing club guest (filling in any newly-supplied missing
 * contact); no match creates a fresh guest at `stage: prospect`. Returning
 * visitors thus get a NEW attendance row (a later meeting) rather than a
 * duplicate guest; a repeat scan at the SAME meeting is idempotent (the
 * meeting×guest unique index). No auth — the caller (the public server fn)
 * trusts the club link, mirroring `addMember`.
 */
export async function captureGuestVisit(
	input: CaptureGuestInput,
): Promise<CaptureGuestResult> {
	const name = input.name.trim();
	if (!name) throw new Error("Please enter your name.");
	const email = input.email?.trim() || null;
	// Standardize to E.164 on write (#295); the digits form below (for dedup) is
	// derived from the normalized value so matching stays consistent. The country
	// code is never null (#397), so the guest who types `(555) 123-4567` on their
	// first visit and `+1 (555) 123-4567` on their second is ONE guest with two
	// visits — not two "1 visit" prospects.
	const cc = await loadClubDefaultCountryCode(input.clubId);
	const phone = toStoredPhone(input.phone, cc);
	const digits = normalizePhone(phone);

	const meetingId = await resolveCurrentMeetingId(input.clubId);

	return db.transaction(async (tx) => {
		// 1. Dedup, club-scoped: email → phone-with-name-agreement → none.
		const existing = await findGuestByContact(tx, input.clubId, {
			digits,
			email,
			name,
		});

		let guestId: string;
		let created: boolean;
		if (existing) {
			guestId = existing.id;
			created = false;
			// Fill in contact the returning guest supplied but we didn't have; keep
			// their name and stage untouched.
			await tx
				.update(guests)
				.set({
					email: existing.email ?? email,
					phone: existing.phone ?? phone,
					updatedAt: new Date(),
				})
				.where(eq(guests.id, guestId));
		} else {
			const [row] = await tx
				.insert(guests)
				.values({ clubId: input.clubId, name, email, phone, stage: "prospect" })
				.returning({ id: guests.id });
			if (!row) throw new Error("Failed to create guest.");
			guestId = row.id;
			created = true;
		}

		// 2. Record the visit. Idempotent per (meeting, guest); a distinct meeting
		//    for a returning guest yields a new row.
		let attendanceRecorded = false;
		if (meetingId) {
			const inserted = await tx
				.insert(meetingAttendance)
				.values({ meetingId, guestId, status: "present" })
				.onConflictDoNothing({
					target: [meetingAttendance.meetingId, meetingAttendance.guestId],
				})
				.returning({ id: meetingAttendance.id });
			attendanceRecorded = inserted.length > 0;
		}

		return { guestId, created, attendanceRecorded, meetingId };
	});
}

export interface PipelineGuestRow {
	id: string;
	name: string;
	/** What they're called, when it isn't the first token of `name` (#486). */
	preferredName: string | null;
	email: string | null;
	phone: string | null;
	stage: GuestStage;
	convertedMembershipId: string | null;
	/** Earliest visited meeting date (derived — see `loadGuestPipeline`); null if none. */
	firstVisitAt: Date | null;
	/** Meetings visited (derived, never a stored counter). */
	visitCount: number;
	/**
	 * Role slots this guest currently holds, across all of the club's meetings
	 * (derived). Only used to warn before a delete — deleting resets each of them
	 * back to Open (#364).
	 */
	heldSlotCount: number;
	createdAt: Date;
}

/**
 * The (guest, meeting) pairs that count as a VISIT for one club (#374).
 *
 * A guest visited a meeting when the meeting is NOT cancelled, its DATE has
 * arrived in the CLUB's timezone, and any of these is true: an attendance row
 * exists (the guest book, or an officer adding them in the minutes), they HELD
 * A ROLE SLOT, or they SPOKE AT TABLE TOPICS. Taking part in the meeting IS
 * attending it.
 *
 * The date guard is club-local-DATE, not a clock compare, and it applies to all
 * three sources — the two things a wall-clock `scheduled_at <= now()` gets
 * wrong are equal and opposite:
 *   - Too strict for today. The VPM opens VP Membership at 18:45 to set up the
 *     minutes for a 19:00 meeting; the guest already down for Timer would read
 *     "No recorded visits" until the meeting's own start time passed. Today's
 *     meeting is today's meeting from midnight.
 *   - Too loose for later. `resolveCurrentMeetingId` falls back to the NEXT
 *     upcoming meeting when none is scheduled today, so a guest-book submission
 *     on 25 Jul writes attendance against 1 Aug. Ungated, that renders as
 *     "1 visit · first Aug 1" — a visit dated a week in the future. It starts
 *     counting on 1 Aug, like every other source.
 * Same reasoning as `resolveCurrentMeetingId`'s own `localDateKey` compare: a
 * club's day is the day it is in the club's town.
 *
 * `union` (not `union all`) de-dupes the pairs, so a guest with an attendance
 * row AND a role slot AND a Table Topics turn at one meeting counts once.
 *
 * This is a READ-SIDE derivation only: participation never writes an attendance
 * row, so the "holding a slot never sets attendance" rule (#218,
 * `minutes-logic.ts`) is untouched.
 */
function guestVisits(clubId: string, timeZone: string) {
	const happened = and(
		eq(meetings.clubId, clubId),
		ne(meetings.status, "cancelled"),
		sql`(${meetings.scheduledAt} at time zone ${timeZone}::text)::date <= (now() at time zone ${timeZone}::text)::date`,
	);
	const attended = db
		.select({
			guestId: meetingAttendance.guestId,
			meetingId: meetings.id,
			scheduledAt: meetings.scheduledAt,
		})
		.from(meetingAttendance)
		.innerJoin(meetings, eq(meetings.id, meetingAttendance.meetingId))
		.where(and(happened, isNotNull(meetingAttendance.guestId)));
	const heldRole = db
		.select({
			guestId: roleSlots.assignedGuestId,
			meetingId: meetings.id,
			scheduledAt: meetings.scheduledAt,
		})
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(and(happened, isNotNull(roleSlots.assignedGuestId)));
	const spoke = db
		.select({
			guestId: tableTopicsSpeakers.guestId,
			meetingId: meetings.id,
			scheduledAt: meetings.scheduledAt,
		})
		.from(tableTopicsSpeakers)
		.innerJoin(meetings, eq(meetings.id, tableTopicsSpeakers.meetingId))
		.where(and(happened, isNotNull(tableTopicsSpeakers.guestId)));
	return union(attended, heldRole, spoke);
}

/**
 * Every guest in a club with a DERIVED first-visit date, visit count, and
 * held-slot count — never stored counters (the derived style of
 * `role-recency-logic.ts`). See `guestVisits` for what counts as a visit.
 * Served for the pipeline view; the caller buckets by `stage`.
 */
export async function loadGuestPipeline(
	clubId: string,
): Promise<PipelineGuestRow[]> {
	const visits = guestVisits(clubId, await loadClubTimeZone(clubId)).as(
		"guest_visits",
	);
	const [rows, visitRows, slotRows] = await Promise.all([
		db
			.select({
				id: guests.id,
				name: guests.name,
				preferredName: guests.preferredName,
				email: guests.email,
				phone: guests.phone,
				stage: guests.stage,
				convertedMembershipId: guests.convertedMembershipId,
				createdAt: guests.createdAt,
			})
			.from(guests)
			.where(eq(guests.clubId, clubId))
			.orderBy(asc(guests.name)),
		db
			.select({
				guestId: visits.guestId,
				visitCount: count(),
				firstVisitAt: min(visits.scheduledAt),
			})
			.from(visits)
			.groupBy(visits.guestId),
		db
			.select({
				guestId: roleSlots.assignedGuestId,
				heldSlotCount: count(),
			})
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(
				and(eq(meetings.clubId, clubId), isNotNull(roleSlots.assignedGuestId)),
			)
			.groupBy(roleSlots.assignedGuestId),
	]);

	const visitsByGuest = new Map(visitRows.map((v) => [v.guestId, v]));
	const slotsByGuest = new Map(slotRows.map((s) => [s.guestId, s]));

	return rows.map((r) => {
		const v = visitsByGuest.get(r.id);
		return {
			id: r.id,
			name: r.name,
			preferredName: r.preferredName,
			email: r.email,
			phone: r.phone,
			stage: r.stage,
			convertedMembershipId: r.convertedMembershipId,
			visitCount: Number(v?.visitCount ?? 0),
			firstVisitAt: v?.firstVisitAt ? new Date(v.firstVisitAt) : null,
			heldSlotCount: Number(slotsByGuest.get(r.id)?.heldSlotCount ?? 0),
			createdAt: r.createdAt,
		};
	});
}

export interface UpdateGuestInput {
	clubId: string;
	guestId: string;
	name: string;
	/** What they're called, when it isn't the first token of `name` (#486).
	 *  Blank is stored as NULL so `greetingName` falls back. */
	preferredName?: string | null;
	email?: string | null;
	phone?: string | null;
}

/**
 * Fix a guest's details (#364) — name (required) plus optional email/phone.
 * Before this there was no update path at all, so a typo'd name was permanent
 * and public (guest-held slots render on the agenda with a "· Guest" marker).
 *
 * Club-scoped; the phone is standardized to E.164 on write like every other
 * contact write path (#295). Allowed at ANY stage, `joined` included: the guest
 * row is only ever the record of the VISITOR, so correcting it is always safe —
 * the Membership that convert-to-member created is a separate row, edited on the
 * roster.
 *
 * The edit is REFUSED when the new phone/email already belongs to a different
 * club guest. `captureGuestVisit` dedups on exactly those two keys, so allowing
 * the collision would leave two rows matching one submission — the returning
 * visitor's history would then split across them depending on which row the
 * lookup happened to pick. Create can silently reuse the match; an edit cannot
 * (that would be a merge, and merging two visit histories is not this path's
 * job), so it fails with a message naming the other guest.
 */
export async function applyUpdateGuest(
	input: UpdateGuestInput,
): Promise<{ ok: true }> {
	const name = input.name.trim();
	if (!name) throw new Error("A guest name is required.");
	const [guest] = await db
		.select({ id: guests.id })
		.from(guests)
		.where(and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)))
		.limit(1);
	if (!guest) throw new Error("Guest not found in this club.");

	const cc = await loadClubDefaultCountryCode(input.clubId);
	const email = input.email?.trim() || null;
	const phone = toStoredPhone(input.phone, cc);

	const clash = await findGuestByContact(db, input.clubId, {
		digits: normalizePhone(phone),
		email,
		name,
		excludeGuestId: input.guestId,
	});
	if (clash) {
		throw new Error(
			`Another guest in this club (${clash.name}) already has that phone number or email.`,
		);
	}

	await db
		.update(guests)
		.set({
			name,
			preferredName: input.preferredName?.trim() || null,
			email,
			phone,
			updatedAt: new Date(),
		})
		.where(eq(guests.id, input.guestId));
	return { ok: true as const };
}

export interface DeleteGuestInput {
	clubId: string;
	guestId: string;
	actorMemberId: string | null;
}

export interface DeleteGuestResult {
	ok: true;
	/** Slots that were held by this guest and have been reset to Open. */
	slotsReopened: number;
}

/**
 * Delete a guest added by mistake (#364). Club-scoped; caller gates on admin.
 *
 * Rules:
 * - A CONVERTED guest (stage `joined` / `converted_membership_id` set) is NEVER
 *   deleted — the Membership is the record of truth now and this row is the
 *   durable history of how they arrived (ADR-0018). Rejected with a message the
 *   UI surfaces; remove them from the roster instead.
 * - Slots the guest HOLDS are reset to Open first (assignee cleared, status
 *   `open`, `claimed_at` cleared), each logged as a `release` — mirroring
 *   `applyMemberRemove`. `role_slots.assigned_guest_id` is ON DELETE SET NULL,
 *   so skipping this would leave slots "claimed" by nobody. Past slots are reset
 *   too (unlike a member removal, which keeps history): the FK nulls them either
 *   way, so leaving them `claimed` would just be a lie.
 * - Their minutes rows (attendance, Table Topics, awards) CASCADE with the row —
 *   they are the record of someone who, by the officer's own action, was never
 *   there. That is also why a real visitor should be marked `lost` rather than
 *   deleted; delete is for mistakes.
 *
 * Everything runs in ONE transaction, and both reads that gate a write take the
 * write's own predicate with them — the concurrent writers here are not
 * hypothetical:
 * - The guest row is read `FOR UPDATE`. `applyConvertGuestToMember` is one
 *   click away in the same view; read outside the transaction, a convert that
 *   commits in the gap would leave this delete happily destroying the joined
 *   guest and the pipeline history the "never deleted" rule exists to protect.
 * - Each slot UPDATE re-asserts `assigned_guest_id = <this guest>` and its
 *   effect is read from `RETURNING`, so the count reflects what actually
 *   changed. `claimSlot`/`reassignSlot` (`src/server/slots.ts`) are PUBLIC,
 *   no-session server fns that accept a guest-held slot: an id-only UPDATE
 *   could land on a slot a visitor just took for a member and blank it to
 *   `status='open'` while leaving `assigned_member_id` set — a slot showing
 *   that member's name that `claimSlot`'s `WHERE status='open'` guard then lets
 *   anyone silently take. The conditional UPDATE is the race guard; same
 *   standard as `removeOpenRoleSlots` and `reassignSlotCore` (`slots-logic.ts`).
 */
export async function applyDeleteGuest(
	input: DeleteGuestInput,
): Promise<DeleteGuestResult> {
	return db.transaction(async (tx) => {
		const [guest] = await tx
			.select({
				id: guests.id,
				name: guests.name,
				stage: guests.stage,
				convertedMembershipId: guests.convertedMembershipId,
			})
			.from(guests)
			.where(and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)))
			.limit(1)
			.for("update");
		if (!guest) throw new Error("Guest not found in this club.");
		if (guest.stage === "joined" || guest.convertedMembershipId) {
			throw new Error(
				"This guest is now a club member — remove them from the roster instead.",
			);
		}

		const held = await tx
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(
				and(
					eq(roleSlots.assignedGuestId, input.guestId),
					eq(meetings.clubId, input.clubId),
				),
			);
		let slotsReopened = 0;
		for (const slot of held) {
			const reopened = await tx
				.update(roleSlots)
				.set({ assignedGuestId: null, status: "open", claimedAt: null })
				.where(
					and(
						eq(roleSlots.id, slot.id),
						eq(roleSlots.assignedGuestId, input.guestId),
					),
				)
				.returning({ id: roleSlots.id });
			// Someone else took the slot between the read and the write — it is
			// theirs now, and a `release` row here would blame the wrong person.
			if (reopened.length === 0) continue;
			slotsReopened += 1;
			await logActivity(tx, {
				clubId: input.clubId,
				actorMemberId: input.actorMemberId,
				action: "release",
				targetType: "slot",
				targetId: slot.id,
				detail: { guestId: input.guestId, guestName: guest.name },
			});
		}
		await tx.delete(guests).where(eq(guests.id, input.guestId));
		return { ok: true as const, slotsReopened };
	});
}

export interface SetGuestStageInput {
	clubId: string;
	guestId: string;
	stage: ManualGuestStage;
}

/**
 * Move a guest between `prospect`/`following_up`/`lost`. A `joined` guest is
 * frozen here — they are a member now, reached only via convert-to-member — so
 * changing their stage is rejected. Club-scoped.
 */
export async function applySetGuestStage(
	input: SetGuestStageInput,
): Promise<{ ok: true; stage: ManualGuestStage }> {
	const [guest] = await db
		.select({ id: guests.id, stage: guests.stage })
		.from(guests)
		.where(and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)))
		.limit(1);
	if (!guest) throw new Error("Guest not found in this club.");
	if (guest.stage === "joined") {
		throw new Error("This guest has already joined as a member.");
	}
	await db
		.update(guests)
		.set({ stage: input.stage, updatedAt: new Date() })
		.where(eq(guests.id, input.guestId));
	return { ok: true as const, stage: input.stage };
}

export interface ConvertGuestInput {
	clubId: string;
	guestId: string;
	actorMemberId: string | null;
}

export interface ConvertGuestResult {
	ok: true;
	membershipId: string;
	personId: string;
}

/**
 * Convert-to-member (ADR-0018): promote a guest into a club Membership.
 *
 * Transactional: (1) dedup the Person by email→phone-with-name-agreement (link
 * an existing Person, else create one — see the step-1 comment for why a bare
 * phone match is not enough); (2) create the Membership for this club (`clubRole: member`,
 * `joinedAt: today`) — or reuse the person's existing membership so we never
 * violate one-membership-per-person-per-club; (3) re-point every role slot the
 * guest holds to the new member (member-XOR-guest holds — set member + clear
 * guest together); (4) stamp the guest `stage: joined` with
 * `converted_membership_id` (the row PERSISTS, its past attendance stays as
 * guest history); (5) write an activity_log entry. Caller gates on admin.
 */
export async function applyConvertGuestToMember(
	input: ConvertGuestInput,
): Promise<ConvertGuestResult> {
	const cc = await loadClubDefaultCountryCode(input.clubId);

	return db.transaction(async (tx) => {
		// Lock the guest row FIRST, and re-check `stage` under that lock.
		//
		// The unique index (#489) only catches a double-add once both racers have
		// resolved the SAME Person. Two concurrent converts of one CONTACTLESS
		// guest — email and phone are both optional on the public book — each fall
		// through to "create a fresh Person", so the two membership inserts carry
		// DIFFERENT person_ids, the index never fires, and the club gets two roster
		// rows plus two Person rows for one human. Serializing on the guest row is
		// what actually closes that, and it is also what makes the `stage` check
		// mean anything: read outside the transaction it was a stale snapshot.
		const [guest] = await tx
			.select()
			.from(guests)
			.where(and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)))
			.limit(1)
			.for("update");
		if (!guest) throw new Error("Guest not found in this club.");
		if (guest.stage === "joined") {
			throw new Error("This guest has already been converted to a member.");
		}

		const name = guest.name.trim();
		// A "goes by" name recorded while they were a guest survives the promotion
		// (#486) — it was true of the human, not of the guest row.
		const preferredName = guest.preferredName?.trim() || null;
		const email = guest.email?.trim() || null;
		// Re-standardize to E.164 on the way into people/members (#295) — the guest
		// row may predate normalize-on-write; the digits form (dedup) follows it.
		const phone = toStoredPhone(guest.phone, cc);
		const digits = normalizePhone(phone);
		// 1. Person dedup (email → phone+name → create). People are global
		//    (club-less), so a wrong match here reaches across every club.
		//
		//    Email leads because it identifies ONE human. Phone does not: a shared
		//    household or work number is ordinary in a guest book (a member brings
		//    their spouse, both write the same mobile), and matching on it alone
		//    fused the two — taking the newcomer's future speeches and Pathways
		//    enrollments onto the wrong Person, since all three FKs are
		//    Person-scoped. So a phone match must also agree on the name (#488).
		//
		//    When neither qualifies, a FRESH Person is the right answer rather than
		//    a best guess: ADR-0008 treats dedupe/merge as a later deliberate
		//    action (`applySelfAdd` says the same), and the superadmin merge tool
		//    exists to fuse two Persons after the fact. Under-matching is visible
		//    and reversible; over-matching is neither.
		let personId: string | null = null;
		// Oldest-first and tie-broken on id: a bare `limit(1)` over two matching
		// rows is a Postgres coin flip, so which human a guest converted onto was
		// not even stable across runs. `findGuestByContact` already does this.
		const order = [asc(people.createdAt), asc(people.id)] as const;
		if (email) {
			const [p] = await tx
				.select({ id: people.id })
				.from(people)
				.where(sql`lower(${people.email}) = ${email.toLowerCase()}`)
				.orderBy(...order)
				.limit(1);
			if (p) personId = p.id;
		}
		if (!personId && digits) {
			// Every phone match is a CANDIDATE, not a result — scan them for one
			// whose name agrees rather than taking the first row and hoping.
			const candidates = await tx
				.select({ id: people.id, name: people.name })
				.from(people)
				.where(
					sql`regexp_replace(coalesce(${people.phone}, ''), '[^0-9]', '', 'g') = ${digits}`,
				)
				.orderBy(...order)
				.limit(PHONE_CANDIDATE_LIMIT);
			const match = candidates.find((p) => namesAgree(p.name, name));
			if (match) personId = match.id;
		}
		if (!personId) {
			const [p] = await tx
				.insert(people)
				.values({ name, preferredName, email, phone })
				.returning({ id: people.id });
			if (!p) throw new Error("Failed to create person.");
			personId = p.id;
		} else if (preferredName) {
			// Deduped onto an EXISTING Person: the insert above never ran, so seed
			// the goes-by name here too or it is lost at the person level (#486).
			// Guarded on NULL, same as the membership-edit seed-up — whatever this
			// human already recorded in another club wins over a guest-book entry.
			await tx
				.update(people)
				.set({ preferredName })
				.where(and(eq(people.id, personId), isNull(people.preferredName)));
		}

		// 2. Membership — reuse the person's existing one in this club, else create.
		const [existingMembership] = await tx
			.select({ id: members.id })
			.from(members)
			.where(
				and(eq(members.personId, personId), eq(members.clubId, input.clubId)),
			)
			.limit(1);
		let membershipId: string;
		if (existingMembership) {
			membershipId = existingMembership.id;
		} else {
			// The SELECT above is the fast path, not the guarantee: it runs under
			// READ COMMITTED with no row to lock, so a concurrent convert of a second
			// guest that deduped onto this same Person can pass it too. The unique
			// index (#489) is what actually holds the line.
			//
			// DO NOTHING rather than a caught error: inside a transaction a raw
			// constraint violation poisons the whole tx (every later statement fails
			// with "current transaction is aborted"), so there would be nothing left
			// to recover with. On conflict we get zero rows back and re-read — under
			// READ COMMITTED the next statement takes a fresh snapshot, so the row
			// the winning transaction committed is visible.
			const [m] = await tx
				.insert(members)
				.values({
					clubId: input.clubId,
					personId,
					name,
					preferredName,
					email,
					phone,
					clubRole: "member",
					status: "active",
					joinedAt: new Date(),
				})
				.onConflictDoNothing({
					target: [members.clubId, members.personId],
				})
				.returning({ id: members.id });
			if (m) {
				membershipId = m.id;
			} else {
				const [raced] = await tx
					.select({ id: members.id })
					.from(members)
					.where(
						and(
							eq(members.personId, personId),
							eq(members.clubId, input.clubId),
						),
					)
					.limit(1);
				if (!raced) throw new Error("Failed to create membership.");
				membershipId = raced.id;
			}
		}

		// 3. Re-point the guest's role slots to the new member (XOR constraint holds).
		await tx
			.update(roleSlots)
			.set({ assignedMemberId: membershipId, assignedGuestId: null })
			.where(eq(roleSlots.assignedGuestId, input.guestId));

		// 4. Freeze the guest as joined with its membership pointer (never deleted).
		await tx
			.update(guests)
			.set({
				stage: "joined",
				convertedMembershipId: membershipId,
				updatedAt: new Date(),
			})
			.where(eq(guests.id, input.guestId));

		// 5. Activity log.
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: input.actorMemberId,
			action: "member_add",
			targetType: "member",
			targetId: membershipId,
			detail: { name, fromGuestId: input.guestId, personId },
		});

		return { ok: true as const, membershipId, personId };
	});
}
