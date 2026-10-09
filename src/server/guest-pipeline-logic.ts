// VP-Membership guest-pipeline DB logic (#208 / ADR-0018), split out from the
// createServerFn wrappers in `guest-pipeline.ts` (a client-imported module the
// guard test forbids from exporting db-touching functions). Integration-testable
// by mocking `#/db`. See the header of `members-logic.ts` for the why.
import {
	and,
	asc,
	count,
	desc,
	eq,
	gte,
	ilike,
	inArray,
	isNotNull,
	isNull,
	min,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";
import { db } from "#/db";
import {
	activityLog,
	clubs,
	guestInvites,
	guests,
	meetingAttendance,
	meetings,
	memberDues,
	members,
	officerTerms,
	pathEnrollments,
	people,
	roleSlots,
	speeches,
	tableTopicsSpeakers,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE, isClubArchived } from "#/lib/club-archive";
import { isAtMeetingNow } from "#/lib/guest-book-window";
import {
	GUEST_CONTACT_REFUSAL_MESSAGES,
	type GuestContactRefusal,
} from "#/lib/guest-contact";
import {
	CONVERT_NAME_CLASH_MESSAGE,
	isStrandedConvertedGuest,
	LINK_ALREADY_JOINED_MESSAGE,
	LINK_MEMBER_NOT_IN_CLUB_MESSAGE,
	UNDO_MEMBER_HAS_ACCOUNT_MESSAGE,
	UNDO_MEMBER_HAS_HISTORY_MESSAGE,
	UNDO_NO_RECORD_MESSAGE,
	UNDO_NOT_CONVERTED_MESSAGE,
	UNLINK_NOT_LINKED_MESSAGE,
} from "#/lib/guest-convert";
import { isInvitableStage, NOT_INVITABLE_MESSAGE } from "#/lib/guest-invite";
import { type GuestLinkPreview, sameGuestLinkPreview } from "#/lib/guest-link";
import {
	acceptedStatuses,
	assertMeetingAccepts,
} from "#/lib/meeting-lifecycle";
import type { OfficerPosition } from "#/lib/officers";
import { namesAgree } from "#/lib/person-name";
import {
	coalesceToE164,
	DEFAULT_COUNTRY_CODE,
	toStoredPhone,
} from "#/lib/phone";
import {
	guestContactFillable,
	guestContactRefusalFor,
	guestContactRefusalSql,
	guestContactWritable,
	identityIgnoredGuestPerson,
	normalizedEmail,
	pristineGuestPerson,
	rosterConflictFor,
} from "./account-link-logic";
import { logActivity } from "./activity";
import {
	CLUB_BUSY_MESSAGE,
	forUpdate,
	lockClubForWrite,
	lockPersonsInOrder,
	noKeyUpdate,
} from "./club-write-lock";
import { loadClubDefaultCountryCode } from "./clubs-logic";
import {
	assertClubNotArchived,
	assertStillClubAdmin,
	NO_PERMISSION_MESSAGE,
	NOT_A_MEMBER_MESSAGE,
	requireClubRole,
} from "./guards";
import {
	createGuestRecord,
	deleteAbandonedGuestPerson,
	deleteGuestPersonIfUnreferenced,
	GUEST_NOT_IN_CLUB_MESSAGE,
	RECORD_CHANGED_MESSAGE,
	separateGuestFromMemberPerson,
} from "./guests-logic";
import { closeOpenOfficerTerms } from "./officers-logic";
import {
	clubsHoldingPersons,
	guestLinkResult,
	isGuestOnlyPerson,
	mergePeople,
	readGuestLinkRecord,
} from "./people-merge-logic";
import { isDeadlock } from "./pg-errors";

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
 * — which adopts the guest's own Person (it created a fresh one before #1124),
 * the recoverable direction (ADR-0008).
 */
const PHONE_CANDIDATE_LIMIT = 50;

/** Either the main db client or a drizzle transaction (see `activity.ts`). */
type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * Whether any club holds `personId` as a member, read WITHOUT a lock, to choose
 * how strongly to lock that Person EARLY (`lockPersonsInOrder`, in the lock
 * order, before the guest row). A Person who holds a membership is not a delete
 * candidate, so a guest delete or a link locks it `FOR NO KEY UPDATE` and does
 * not block a speaker claim's key share; one who holds none gets `FOR UPDATE`.
 *
 * The read can be STALE, and the choice is only an early one, not a decision:
 * the delete takes `FOR UPDATE` itself, in its own statement just before the
 * DELETE, once the Person is a candidate, whatever was taken here
 * (`deleteGuestPersonIfUnreferenced`), and its WHERE decides after that. What a
 * stale read costs is a strong lock held earlier than needed, which can cycle
 * with a concurrent CSV import of another club (a 40P01, no data loss).
 */
async function holdsMembership(
	tx: DbOrTx,
	personId: string | null | undefined,
): Promise<boolean> {
	if (!personId) return false;
	const [row] = await tx
		.select({ id: members.id })
		.from(members)
		.where(eq(members.personId, personId))
		.limit(1);
	return Boolean(row);
}

/**
 * The guest row `findGuestByContact` resolves: identity + the dedup keys.
 *
 * `email` and `phone` are the guest's PERSON's (#1125): a guest's contact lives
 * on `people`, and every read of it joins `guests.person_id`. `personId` rides
 * along for the one caller that writes (the public fill in `captureGuestVisit`).
 * A candidate a caller SYNTHESISES (the guest-book plan's not-yet-created guests)
 * is a `GuestMatchCandidate`, which has no Person.
 */
type GuestKeys = {
	id: string;
	name: string;
	email: string | null;
	phone: string | null;
};

/** A club guest as the DATABASE resolves it: the keys above and its Person. */
type GuestContactRow = GuestKeys & { personId: string };

/**
 * What `matchGuest` compares against. Wider than `GuestContactRow` by the two
 * columns the ORDERING needs, because the order is part of the answer (below)
 * and a caller that loaded rows in some other order would get a different one.
 */
export interface GuestMatchCandidate extends GuestKeys {
	createdAt: Date;
}

/** The name a caller is presenting, with whatever contact came with it. */
export interface GuestMatchInput {
	name: string;
	email: string | null;
	/**
	 * The E.164 STORED form (`toStoredPhone(raw, cc)`), not raw input. Both sides
	 * are reduced to digits before comparing, and the digits of `+1 (555)
	 * 123-4567` and of `(555) 123-4567` differ — that mismatch is the whole of
	 * #397.
	 */
	phone: string | null;
}

/**
 * What the club's guest list says about one presented name+contact.
 *
 * `already_present` is deliberately NOT here: whether a matched guest already
 * has attendance at a particular meeting is a fact about a meeting, not about
 * the guest list, and folding it in would make this function need a meeting.
 * `record_guest_book` upgrades `matched` to `already_present` itself.
 */
export type GuestMatch<C extends GuestMatchCandidate = GuestMatchCandidate> =
	| { outcome: "matched"; via: "email" | "phone"; guest: C }
	| { outcome: "new" }
	| {
			outcome: "ambiguous";
			reason: "phone_name_disagree" | "name_only";
			candidates: C[];
	  };

/**
 * THE guest dedup rule (#488 / ADR-0018), over an in-memory candidate set.
 *
 * Email leads, then a phone whose name also agrees — mirroring
 * `applyConvertGuestToMember`'s Person dedup. The name check on the phone
 * branch is the same guard as that one, for the same reason: a spouse or
 * coworker signing the guest book with the shared number they already gave is
 * TWO prospects, and collapsing them into one row silently merges their
 * attendance and understates the VP-Membership funnel.
 *
 * **Why a pure function over candidates rather than a query.** Three callers
 * need this rule and they need it at two very different scales. The single-guest
 * paths (`captureGuestVisit` at the door, `applyUpdateGuest`'s clash check) hand
 * it the small bounded set their own indexed queries returned. The MCP
 * guest-book transcription (#773) hands it the club's guests, loaded ONCE for a
 * page of up to 100 entries — the query-per-lookup shape would be ~200 round
 * trips per preview and again inside the locked apply transaction. A second
 * implementation for the batch path is how two paths come to disagree about who
 * is the same visitor, so there is one rule and the caller chooses the I/O.
 *
 * **Ordering is part of the answer.** Candidates are sorted oldest-first and
 * tie-broken on id before anything is compared: over two matching rows an
 * arbitrary pick would split a returning visitor's history nondeterministically
 * between them.
 *
 * **`ambiguous` is a REPORT, not a decision.** This function never decides what
 * to do about one — the public path treats it as "no match, create" (its
 * long-standing behaviour, which must not change), and MCP planning blocks on it
 * and asks a human. Two situations produce it:
 *   - `phone_name_disagree`: the number is on file under a name that does not
 *     agree. The public path creating a second prospect here is CORRECT (#488);
 *     a transcriber looking at one handwritten line deserves to be asked.
 *   - `name_only`: no email and no phone at all, but an existing guest's name
 *     agrees. Reported only when `nameOnlyAmbiguity` is set, because a name is
 *     not a dedup key — the public path must keep creating a new guest for a
 *     visitor who gives only a name, or two different Sam Rays become one.
 */
export function matchGuest<C extends GuestMatchCandidate>(
	candidates: C[],
	input: GuestMatchInput,
	opts?: { excludeGuestId?: string; nameOnlyAmbiguity?: boolean },
): GuestMatch<C> {
	const pool = candidates
		.filter((c) => c.id !== opts?.excludeGuestId)
		.sort(
			(a, b) =>
				a.createdAt.getTime() - b.createdAt.getTime() ||
				(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		);

	const email = input.email?.trim().toLowerCase() || null;
	if (email) {
		const byEmail = pool.find((c) => c.email?.trim().toLowerCase() === email);
		if (byEmail) return { outcome: "matched", via: "email", guest: byEmail };
	}

	const digits = normalizePhone(input.phone);
	if (digits) {
		const samePhone = pool.filter((c) => normalizePhone(c.phone) === digits);
		const agreeing = samePhone.find((c) => namesAgree(c.name, input.name));
		if (agreeing) return { outcome: "matched", via: "phone", guest: agreeing };
		if (samePhone.length > 0) {
			return {
				outcome: "ambiguous",
				reason: "phone_name_disagree",
				candidates: samePhone,
			};
		}
	}

	if (opts?.nameOnlyAmbiguity && !email && !digits) {
		const byName = pool.filter((c) => namesAgree(c.name, input.name));
		if (byName.length > 0) {
			return { outcome: "ambiguous", reason: "name_only", candidates: byName };
		}
	}

	return { outcome: "new" };
}

/**
 * `matchGuest` against the database, for a SINGLE presented name+contact.
 *
 * This is the QUERY half; the rule itself is `matchGuest` above. It fetches
 * exactly the candidate universe the old `findGuestByContact` did — the
 * email-matching rows and up to `PHONE_CANDIDATE_LIMIT` rows sharing the
 * number, both club-scoped, both indexed — and applies the shared comparison to
 * them. Keeping the two bounded queries rather than loading the club's guests
 * matters here: the public guest book runs this on an unauthenticated POST, one
 * visitor at a time. The BATCH path (MCP guest-book transcription) does the
 * opposite — `loadGuestMatchCandidates` once, then `matchGuest` per entry — for
 * the reason given on `matchGuest`.
 *
 * `input.phone` is the caller's number in the E.164 STORED form; the SQL
 * compares its digits against the STORED phone's digits. Both sides therefore
 * have to be E.164 for the compare to mean anything — writes are (every path
 * funnels through `toStoredPhone` with a never-null country code), and rows
 * written before that are brought over by `scripts/backfill-phone-e164.ts`
 * (#397).
 *
 * `nameOnlyAmbiguity` is NOT offered: an entry with no contact details has no
 * candidate query to run, so a name-only scan would mean loading the club's
 * guests — which is the batch path's job, not this one's.
 */
async function findGuestMatch(
	conn: DbOrTx,
	clubId: string,
	input: GuestMatchInput,
	opts?: { excludeGuestId?: string; excludePersonId?: string },
): Promise<GuestMatch<GuestMatchCandidate & { personId: string }>> {
	const cols = {
		id: guests.id,
		name: guests.name,
		// The Person's contact (#1125); the match stays scoped to THIS club's guest
		// rows, so a Person another club also holds is found only through this
		// club's own row.
		email: people.email,
		phone: people.phone,
		personId: guests.personId,
		createdAt: guests.createdAt,
	};
	// `excludePersonId`: another guest row on the SAME Person is not another
	// human (several converted guest rows can share one member Person, #635), so
	// an edit's clash check must not count it.
	const scope = and(
		eq(guests.clubId, clubId),
		opts?.excludeGuestId ? ne(guests.id, opts.excludeGuestId) : undefined,
		opts?.excludePersonId
			? ne(guests.personId, opts.excludePersonId)
			: undefined,
	);
	const order = [asc(guests.createdAt), asc(guests.id)] as const;

	const email = input.email?.trim() || null;
	const digits = normalizePhone(input.phone);

	const candidates: Array<GuestMatchCandidate & { personId: string }> = [];
	if (email) {
		candidates.push(
			...(await conn
				.select(cols)
				.from(guests)
				.innerJoin(people, eq(people.id, guests.personId))
				.where(and(scope, sql`lower(${people.email}) = ${email.toLowerCase()}`))
				.orderBy(...order)
				.limit(1)),
		);
	}
	if (digits) {
		candidates.push(
			...(await conn
				.select(cols)
				.from(guests)
				.innerJoin(people, eq(people.id, guests.personId))
				.where(
					and(
						scope,
						sql`regexp_replace(coalesce(${people.phone}, ''), '[^0-9]', '', 'g') = ${digits}`,
					),
				)
				.orderBy(...order)
				.limit(PHONE_CANDIDATE_LIMIT)),
		);
	}
	return matchGuest(candidates, input, opts);
}

/**
 * The club guest a presented name+contact resolves to, or undefined.
 *
 * Collapses `findGuestMatch`'s three outcomes to the two its callers act on:
 * `matched` yields the row, and BOTH `new` and `ambiguous` yield undefined.
 * That is deliberate and is the behaviour these paths have always had — the
 * public guest book creates a second prospect for a shared number under a
 * disagreeing name (#488), and the edit path lets that same edit through rather
 * than calling it a clash.
 *
 * EXPORTED so `minutes-logic`'s `resolveGuestId` shares it (#773). Before that
 * it inserted with an id-only `onConflictDoNothing`, so an officer adding a
 * returning visitor to a past meeting minted a duplicate `guests` row —
 * silently, because the minutes rendered the right name either way.
 */
export async function findGuestForContact(
	conn: DbOrTx,
	clubId: string,
	input: GuestMatchInput,
	opts?: { excludeGuestId?: string; excludePersonId?: string },
): Promise<GuestContactRow | undefined> {
	const match = await findGuestMatch(conn, clubId, input, opts);
	return match.outcome === "matched" ? match.guest : undefined;
}

/**
 * Every guest of a club that the MCP batch matcher may match against, loaded
 * ONCE per call (#773). Same stage filter as `listClubGuests` would NOT do:
 * this deliberately includes `joined` and `lost` guests, because the question
 * is "does this row already exist", not "who should the picker offer".
 * Transcribing a page that names a guest who has since joined must reuse their
 * row, not mint a second one.
 */
export async function loadGuestMatchCandidates(
	conn: DbOrTx,
	clubId: string,
): Promise<Array<GuestMatchCandidate & { personId: string }>> {
	return conn
		.select({
			id: guests.id,
			name: guests.name,
			// The Person's contact (#1125).
			email: people.email,
			phone: people.phone,
			personId: guests.personId,
			createdAt: guests.createdAt,
		})
		.from(guests)
		.innerJoin(people, eq(people.id, guests.personId))
		.where(eq(guests.clubId, clubId))
		.orderBy(asc(guests.createdAt), asc(guests.id));
}

/**
 * The two club-level facts `loadGuestPipeline` needs, in ONE round trip.
 *
 * They used to be two functions reading the SAME `clubs` row — a local
 * `loadClubTimeZone` and `clubs-logic`'s `loadClubDefaultCountryCode` — issued
 * together in a `Promise.all`, which made them concurrent but still two queries
 * and two round trips for one row.
 *
 * Both fallbacks are preserved exactly, and they are not the same fallback:
 *   - timezone: the schema default, used when the club ROW is missing.
 *   - country code: `?.trim() || DEFAULT_COUNTRY_CODE` — also used when the
 *     column is NULL or blank, because a club that never set one still has to
 *     produce a dedup key (#397). `loadClubDefaultCountryCode`'s contract is
 *     NEVER-NULL, so the `||` has to stay a `||` and not become a `??`.
 */
async function loadClubPipelineSettings(
	clubId: string,
): Promise<{ timeZone: string; countryCode: string }> {
	const [club] = await db
		.select({
			timezone: clubs.timezone,
			defaultCountryCode: clubs.defaultCountryCode,
		})
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	return {
		timeZone: club?.timezone ?? "America/Chicago",
		countryCode: club?.defaultCountryCode?.trim() || DEFAULT_COUNTRY_CODE,
	};
}

/**
 * The club's current/nearest meeting for guest-book capture: the meeting
 * HAPPENING NOW (within the grace window either side of it — the guest is at
 * it), else the next upcoming scheduled meeting. Returns null when neither
 * exists (capture then records the guest with no attendance row).
 *
 * `atMeeting` distinguishes the two, and callers MUST NOT treat them alike when
 * writing attendance — see `captureGuestVisit`.
 *
 * The window is ABSOLUTE time (`isAtMeetingNow`), not a club-local calendar-day
 * comparison. See `#/lib/guest-book-window` for why the date-key version was
 * wrong in both directions.
 */
// Public guest-book throttle. `submitGuestBook` is a session-less public write
// (the club link is the credential, #239), and since v1.9.0.0 it is linked from
// the public club page rather than only appearing on a printed QR — so the
// surface is now guessable as well as unauthenticated. Uncapped it could mint
// `guests` rows without limit, and DURING a meeting each new guest also becomes
// a `meeting_attendance` row with `status: "present"` that reaches the official
// minutes and the minutes email.
//
// Capping NEW guests therefore caps fabricated attendance too: attendance is
// unique per (meeting, guest), so one guest can only ever produce one row.
//
// Why 30: guests arrive in BATCHES — an open house is exactly when a club most
// wants the form working and most wants to impress visitors. 30 new guests in
// one club in one hour clears any real meeting and still bounds abuse to a
// number an officer can delete by hand. (30 was originally picked against the
// public member self-add's 15 — the sibling cap on a rare individual event, so
// double it for a path where arrivals cluster. #630 deleted that path and its
// constants, which leaves 30 standing on the batch argument above rather than on
// a ratio. Do NOT repoint the comparison at `MAX_BALLOT_GUESTS_PER_MEETING`: it
// is 60, so a "batches justify a bigger cap" sentence aimed at it argues for the
// opposite of 30.)
//
// A RETURNING guest (matched by email or phone) does not consume the cap: only
// the create path counts, so regulars are never throttled.
export const GUEST_BOOK_WINDOW_MS = 60 * 60 * 1000; // 1h
export const GUEST_BOOK_MAX_NEW_PER_WINDOW = 30;
export const GUEST_BOOK_THROTTLED_MESSAGE =
	"Too many guests have just signed in for this club — please ask an officer to add you.";

export async function resolveCurrentMeeting(
	clubId: string,
): Promise<{ meetingId: string; atMeeting: boolean } | null> {
	const now = new Date();

	// Bounded to meetings that could plausibly be "now" or next, rather than
	// every meeting the club has ever held: this runs on an unauthenticated
	// POST, and the old unbounded scan grew with the club's whole history.
	const horizon = new Date(now.getTime() - 24 * 60 * 60 * 1000);
	const rows = await db
		.select({
			id: meetings.id,
			scheduledAt: meetings.scheduledAt,
			lengthMinutes: meetings.lengthMinutes,
		})
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, clubId),
				// The meetings a visit may be RECORDED against: the `record` write
				// class's accepted statuses (#1137), so which meeting this picks and
				// which one `captureInTransaction` then refuses are one policy.
				inArray(meetings.status, acceptedStatuses("record")),
				gte(meetings.scheduledAt, horizon),
			),
		)
		.orderBy(asc(meetings.scheduledAt));
	if (rows.length === 0) return null;

	const here = rows.find((r) =>
		isAtMeetingNow(r.scheduledAt, r.lengthMinutes, now),
	);
	if (here) return { meetingId: here.id, atMeeting: true };

	const upcoming = rows.find((r) => r.scheduledAt.getTime() >= now.getTime());
	return upcoming ? { meetingId: upcoming.id, atMeeting: false } : null;
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
 * Lock the club row and refuse an archived club, in ONE statement (#858).
 *
 * `CODING_STANDARDS.md`: "Where a write already holds a club lock, gate INSIDE
 * it". `archiveClub` sets `clubs.archived_at` with an `UPDATE`, and an `UPDATE`
 * waits on both lock strengths used here, so once this returns the club cannot
 * be archived until the transaction ends — and under READ COMMITTED a row lock
 * that WAITED re-reads the row version it was granted, so a takedown that
 * committed while we queued is seen here rather than missed.
 *
 * Two strengths, on purpose:
 * - `no key update` on the CREATE path, which serialises the sign-up
 *   throttle's COUNT. Same statement, now also answering "archived?". It was
 *   `FOR UPDATE` until #925, and `FOR UPDATE` is the one strength that
 *   conflicts with the `FOR KEY SHARE` every foreign-key insert takes on the
 *   club row — so an officer's first agenda edit (meeting `FOR UPDATE`, then a
 *   template insert referencing the club) waited on this capture while this
 *   capture's attendance insert waited on that meeting: a 40P01. NO KEY UPDATE
 *   still conflicts with itself, with SHARE, and with the archiving `UPDATE`,
 *   which is everything this lock is FOR; it simply lets foreign-key inserts
 *   past, the same trade the template save makes (`nextClubTemplateKey`).
 * - `share` on the RETURNING-guest path, which fills in contact details on an
 *   existing row and records a visit — still PII landing in a taken-down club,
 *   so it is gated too. It takes SHARE because it needs only to hold the
 *   takedown off, and SHARE also coexists with the `FOR KEY SHARE` a
 *   foreign-key insert takes: a convert that holds this guest's row lock and
 *   then inserts a `members` row must never wait on us while we wait on its
 *   guest row.
 *
 * Both run under the club write lock (`lockClubForWrite`, #925), which
 * `captureGuestVisit` takes before anything else, so captures in one club no
 * longer contend for this row with each other at all; the strengths are about
 * the writers that do NOT take that lock.
 */
async function lockOpenClub(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	clubId: string,
	strength: "no key update" | "share",
): Promise<void> {
	const [club] = await tx
		.select({ archivedAt: clubs.archivedAt })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.for(strength);
	if (!club) throw new Error("Club not found.");
	if (isClubArchived(club)) throw new Error(CLUB_ARCHIVED_MESSAGE);
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
 * trusts the club link. It used to say "mirroring `addMember`"; that public
 * roster self-add was admin-gated at #616 and deleted at #630, so this is now
 * the front door for a non-member rather than the second-best one.
 */
export async function captureGuestVisit(
	input: CaptureGuestInput,
): Promise<CaptureGuestResult> {
	// #555, FIRST — before the name is even validated. This path mints a `guests`
	// row carrying a visitor's name and optional email and phone, so it is one of
	// the three that make an archived club keep accreting PII while every read of
	// it returns empty. A taken-down club must not collect contact details, and
	// "your name is required" is the wrong first answer to give someone signing
	// the guest book of a club that no longer exists.
	//
	// This is the FAST answer, not the gate: it is check-then-act, so a club
	// archived between here and the insert would still collect the row. The
	// authoritative read is `lockOpenClub`, inside the transaction, on both write
	// paths (#858).
	await assertClubNotArchived(input.clubId);
	const name = input.name.trim();
	if (!name) throw new Error("Please enter your name.");
	const email = input.email?.trim() || null;
	// Standardize to E.164 on write (#295); `matchGuest` reduces this normalized
	// value to digits for dedup, so matching stays consistent. The country code
	// is never null (#397), so the guest who types `(555) 123-4567` on their
	// first visit and `+1 (555) 123-4567` on their second is ONE guest with two
	// visits — not two "1 visit" prospects.
	const cc = await loadClubDefaultCountryCode(input.clubId);
	const phone = toStoredPhone(input.phone, cc);

	// Attendance is only written for a meeting HAPPENING NOW. Since #319 the
	// guest book is linked from the public club page ("Planning a visit?"), not
	// just the printed QR code handed out AT a meeting, so an advance sign-up is
	// now the expected flow rather than an edge case. `resolveCurrentMeeting`
	// falls back to the NEXT upcoming meeting when none is in progress — writing
	// `status: "present"` against that would put a guest who has not arrived
	// (and may never) into that meeting's official minutes (`minutes-logic.ts`
	// reads `meeting_attendance` with no date gate) and email them to the club.
	// The guest row itself is still created, so the VPE sees the prospect either
	// way.
	const current = await resolveCurrentMeeting(input.clubId);
	const meetingId = current?.atMeeting ? current.meetingId : null;

	try {
		return await captureInTransaction(input, meetingId, {
			name,
			email,
			phone,
		});
	} catch (err) {
		// #925. The writers that lock this club AND one of its meetings take the
		// club write lock first, so none of them can deadlock a check-in; a 40P01
		// here is a cycle through some writer that does not. Nothing was written
		// (the transaction rolled back), so a visitor reads "try again" rather
		// than the driver's `Failed query: …`. The original rides on `cause`, so a
		// SQLSTATE check still sees it.
		if (isDeadlock(err)) throw new Error(CLUB_BUSY_MESSAGE, { cause: err });
		throw err;
	}
}

/**
 * The public guest book's fill of a returning guest's BLANK email or phone
 * (#1125). A guest's contact lives on their Person, so this writes
 * `people.email` / `people.phone`, and only under `guestContactFillable(clubId)`
 * in the UPDATE's own WHERE: the Person is guest-only, nobody has signed in as
 * them, no club holds them as a member, and no OTHER club holds a guest row on
 * them. The book has no session (the club link is the credential), so it may not
 * put an address on a Person another club, or any membership, reaches. Where the
 * predicate refuses, nothing is written and the visit is still recorded.
 *
 * Fill-only, as it always was: a value already there is kept, and the SQL says so
 * itself (`coalesce`), so a Person edited since the match was read is not
 * overwritten. The caller holds the club write lock, which is what keeps this
 * guest row pointing at the same Person (every writer of `guests.person_id`
 * takes it first); the Person is then locked `FOR UPDATE`, the protocol's second
 * step (ADR-0031), so a contact edit or a convert of this Person waits.
 */
async function fillBlankGuestContact(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	clubId: string,
	existing: GuestContactRow,
	contact: { email: string | null; phone: string | null },
): Promise<void> {
	const fillsEmail = existing.email === null && contact.email !== null;
	const fillsPhone = existing.phone === null && contact.phone !== null;
	if ((!fillsEmail && !fillsPhone) || !existing.personId) return;
	await lockPersonsInOrder(tx, forUpdate(existing.personId));
	await tx
		.update(people)
		.set({
			email: sql`coalesce(${people.email}, ${contact.email})`,
			phone: sql`coalesce(${people.phone}, ${contact.phone})`,
		})
		.where(and(eq(people.id, existing.personId), guestContactFillable(clubId)));
}

/** `captureGuestVisit`'s transaction — split out only so the deadlock
 *  translation wraps every statement in it at once. */
function captureInTransaction(
	input: { clubId: string },
	meetingId: string | null,
	contact: { name: string; email: string | null; phone: string | null },
): Promise<CaptureGuestResult> {
	const { name, email, phone } = contact;
	return db.transaction(async (tx) => {
		// 0. The club write lock, before any row is locked (#925). A new guest
		//    locks the club and then (through the attendance insert's foreign
		//    key) the meeting; a ballot join and a template save lock the meeting
		//    and then the club. No single row order suits both, so every one of
		//    them takes this first and they serialise per club. It replaces none
		//    of the row locks below: the club lock is still the throttle's
		//    serialisation and the archive gate.
		await lockClubForWrite(tx, input.clubId);

		// 1. Dedup, club-scoped: email → phone-with-name-agreement → none.
		//    An `ambiguous` outcome (shared number, disagreeing name) resolves to
		//    undefined here and creates a second prospect — which is #488's rule
		//    and this path's long-standing behaviour, not an oversight.
		const existing = await findGuestForContact(tx, input.clubId, {
			name,
			email,
			phone,
		});

		let guestId: string;
		let created: boolean;
		if (existing) {
			guestId = existing.id;
			created = false;
			// Gate before the contact fill-in and the attendance row (#858).
			await lockOpenClub(tx, input.clubId, "share");
			// Fill in contact the returning guest supplied but we didn't have; keep
			// their name and stage untouched.
			await fillBlankGuestContact(tx, input.clubId, existing, { email, phone });
		} else {
			// Throttle the CREATE path only. Both statements run inside this
			// transaction, behind a lock on the club row — a count taken OUTSIDE
			// the transaction is not a cap at all: every concurrent request reads
			// the same pre-insert total and they all pass. That exact bypass was
			// proved on the voting guest cap (#510), where 200 concurrent calls
			// cleared a limit of 60. The club lock serialises signups per club, and
			// under READ COMMITTED the COUNT below takes a fresh snapshot once the
			// lock is granted, so it sees the rows the requests ahead committed.
			// The same locked read is the archive gate (#858).
			await lockOpenClub(tx, input.clubId, "no key update");
			const since = new Date(Date.now() - GUEST_BOOK_WINDOW_MS);
			const [recent] = await tx
				.select({ n: count() })
				.from(guests)
				.where(
					and(eq(guests.clubId, input.clubId), gte(guests.createdAt, since)),
				);
			if ((recent?.n ?? 0) >= GUEST_BOOK_MAX_NEW_PER_WINDOW) {
				throw new Error(GUEST_BOOK_THROTTLED_MESSAGE);
			}
			// The guest and their Person in one go (#1124): a failure on either
			// insert leaves neither, so the public book cannot mint an orphan Person.
			const row = await createGuestRecord(tx, {
				clubId: input.clubId,
				name,
				email,
				phone,
				stage: "prospect",
			});
			guestId = row.id;
			created = true;
		}

		// 2. Record the visit. Idempotent per (meeting, guest); a distinct meeting
		//    for a returning guest yields a new row.
		let attendanceRecorded = false;
		if (meetingId) {
			// A visit is the RECORD of who was in the room, so this is the `record`
			// write class (#1137): a meeting the class refuses takes no visit, and a
			// refusal here rolls the transaction back, guest row and all. After the
			// archive gate above, so takedown still outranks the meeting's own state.
			//
			// `resolveCurrentMeeting` already skips such a meeting, so this is
			// reachable only when the meeting is cancelled AFTER that read, which runs
			// outside the transaction, and before the insert below, which runs behind
			// the club write lock a busy club can queue on. That window is real and it
			// is the whole of what this guards, so the read takes the meeting row
			// `FOR SHARE`. Every status writer takes the row `FOR NO KEY UPDATE`
			// (`lockMeetingForSlotEdit`), and the two conflict: a cancel still in
			// flight is waited for and then seen, and once the SHARE is held a cancel
			// waits for this transaction. The order is club write lock, then the club
			// row (`lockOpenClub`), then this meeting row, the same one the attendance
			// insert's foreign key already implies. A meeting that is gone is refused
			// too, rather than left to the foreign key's driver error.
			const [target] = await tx
				.select({ status: meetings.status })
				.from(meetings)
				.where(eq(meetings.id, meetingId))
				.limit(1)
				.for("share");
			if (!target) throw new Error("Meeting not found.");
			assertMeetingAccepts(target.status, "record");
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
	/** The guest's PERSON's address (#1125): a guest's contact lives on `people`. */
	email: string | null;
	/**
	 * DISPLAY phone: E.164 where it can be derived, otherwise the stored value
	 * verbatim (`coalesceToE164`) — what the card's WhatsApp link reads.
	 *
	 * Never bind the EDIT DIALOG to this; bind it to `phoneRaw`.
	 */
	phone: string | null;
	/**
	 * The Person's phone byte-for-byte (#1125) — what the edit dialog prefills.
	 *
	 * Coalescing is a country-code GUESS, so `"415-555-2671 x12"` displays as
	 * `"+1415555267112"`. Prefilling the dialog with the guess shows the VPM a
	 * number nobody typed, on the one screen that is supposed to show what is on
	 * file — and it is the screen they open to fix a NAME.
	 *
	 * It does not currently corrupt the column, but only by coincidence:
	 * `applyUpdateGuest` re-normalizes with `toStoredPhone`, which is a fixed point
	 * over `coalesceToE164` (pinned in `phone.test.ts`), so the guess and the raw
	 * value happen to store identically — and for the same reason the dedup clash
	 * check compares the same digits either way. Neither function promises that.
	 * Round-tripping the raw bytes is what makes the prefill correct rather than
	 * accidentally harmless. See `loadMemberProfile` for the same split.
	 */
	phoneRaw: string | null;
	/**
	 * Why an officer of this club may NOT change this guest's email or phone, or
	 * null when they may (#1125, `guestContactWritable`). The first of "signed in",
	 * "a member here", "a member of another club" that applies. The Edit guest
	 * dialog reads it to show the contact read-only with the matching sentence
	 * (`GUEST_CONTACT_REFUSAL_MESSAGES`), so the refusal `applyUpdateGuest` throws
	 * is normally never reached from the UI. The READ form of the writer's own
	 * WHERE, never the gate.
	 */
	contactRefusal: GuestContactRefusal | null;
	stage: GuestStage;
	convertedMembershipId: string | null;
	/**
	 * This guest's membership pointer came from a LINK (#635) that recorded the
	 * slots it moved, so it can be undone.
	 *
	 * False for a real `applyConvertGuestToMember`, which also created a Person
	 * and a membership and has no slot record to replay — undoing that is #618.
	 * The board needs the distinction because both set `convertedMembershipId`:
	 * without it the Unlink button appears on a converted guest and fails every
	 * time, with a message saying they are not linked when they plainly are.
	 */
	linkReversible: boolean;
	/**
	 * This guest's conversion carries the record `applyUndoGuestConversion`
	 * replays (#618), so the card may offer an Undo.
	 *
	 * False for a conversion performed before that record existed — the undo
	 * would be refused, and a button that always fails is worse than none. Also
	 * false for a LINK, which `linkReversible` covers and Unlink handles.
	 */
	conversionUndoable: boolean;
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
	/**
	 * The most recent invite draft an officer opened for this guest (#899), by
	 * `invitedAt`, counting only meetings that are NOT cancelled. Null when there
	 * is none. `invitedByName` is null when the inviter was deleted or was an
	 * impersonating superadmin (no membership). A row means a draft was OPENED —
	 * the app cannot see whether it was sent.
	 */
	lastInvite: {
		meetingId: string;
		meetingAt: Date;
		invitedByName: string | null;
	} | null;
	/** DISTINCT non-cancelled meetings this guest has been invited to (#899). */
	inviteCount: number;
	/**
	 * Another club holds this guest's Person, as a guest or a member (#1127). A
	 * boolean and nothing about that club: clubs stay blind. Drives "Separate from
	 * other clubs". Absent reads as false.
	 */
	sharedWithOtherClub?: boolean;
	/**
	 * The ids, out of the viewer's other admin clubs (`loadOtherAdminClubs`), where
	 * "Add to <club>" is offered: the Person has no unconverted guest row and no
	 * active membership there. Empty for a converted guest and when the caller named
	 * no clubs. Absent reads as empty.
	 */
	addableTo?: string[];
	/**
	 * Those meetings' ids. `lastInvite` is the latest by `invitedAt`, so it
	 * cannot say whether the guest is invited to the NEXT meeting — a guest
	 * invited to Oct 3 and then Oct 10 has Oct 10 as `lastInvite`.
	 */
	invitedMeetingIds: string[];
	createdAt: Date;
}

/**
 * The (guest, meeting) pairs that count as a VISIT for one club (#374).
 *
 * A guest visited a meeting when the meeting is NOT cancelled, its DATE has
 * arrived in the CLUB's timezone, and any of these is true: a PRESENT attendance
 * row exists (the guest book, or an officer adding them in the minutes), they HELD
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
 *   - Too loose for later. A slot claimed or a Table Topics turn recorded
 *     against a FUTURE meeting is a plan, not a visit; ungated it would render
 *     as "1 visit · first Aug 1" — a visit dated a week ahead. It starts
 *     counting on 1 Aug, like every other source.
 * A club's day is the day it is in the club's town, so the compare is
 * club-local.
 *
 * The third source, guest-book attendance, no longer needs this gate to be
 * correct: since #319 `captureGuestVisit` writes an attendance row ONLY for a
 * meeting in progress (`isAtMeetingNow`), so a future-dated attendance row is
 * not produced in the first place. The gate stays because it costs nothing and
 * still protects the other two sources — and any rows written before #319.
 *
 * `union` (not `union all`) de-dupes the pairs, so a guest with an attendance
 * row AND a role slot AND a Table Topics turn at one meeting counts once.
 *
 * This is a READ-SIDE derivation only: participation never writes an attendance
 * row, so the "holding a slot never sets attendance" rule (#218,
 * `minutes-logic.ts`) is untouched.
 */
function guestVisits(conn: DbOrTx, clubId: string, timeZone: string) {
	const happened = and(
		eq(meetings.clubId, clubId),
		ne(meetings.status, "cancelled"),
		sql`(${meetings.scheduledAt} at time zone ${timeZone}::text)::date <= (now() at time zone ${timeZone}::text)::date`,
	);
	const attended = conn
		.select({
			guestId: meetingAttendance.guestId,
			meetingId: meetings.id,
			scheduledAt: meetings.scheduledAt,
		})
		.from(meetingAttendance)
		.innerJoin(meetings, eq(meetings.id, meetingAttendance.meetingId))
		// A PRESENT record only. The column defaults to 'absent', and an absent
		// or excused row is a guest who was expected and did not come.
		.where(
			and(
				happened,
				isNotNull(meetingAttendance.guestId),
				eq(meetingAttendance.status, "present"),
			),
		);
	const heldRole = conn
		.select({
			guestId: roleSlots.assignedGuestId,
			meetingId: meetings.id,
			scheduledAt: meetings.scheduledAt,
		})
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(and(happened, isNotNull(roleSlots.assignedGuestId)));
	const spoke = conn
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

/** One guest's derived visit summary: see {@link guestVisits}. */
export interface GuestVisitSummary {
	guestId: string | null;
	visitCount: number;
	firstVisitAt: Date | null;
}

/**
 * Every guest of a club's visit count and first visit, from {@link guestVisits}.
 * THE statement of "how many times has this guest visited": the pipeline board
 * reads it, and so does the club data export's `guests.csv`, so the two can
 * never disagree about a guest. Takes a connection because the export reads
 * inside its own read-only snapshot transaction.
 */
export async function loadGuestVisitSummaries(
	conn: DbOrTx,
	clubId: string,
	timeZone: string,
): Promise<GuestVisitSummary[]> {
	const visits = guestVisits(conn, clubId, timeZone).as("guest_visits");
	return conn
		.select({
			guestId: visits.guestId,
			visitCount: count(),
			firstVisitAt: min(visits.scheduledAt),
		})
		.from(visits)
		.groupBy(visits.guestId);
}

/**
 * Every guest in a club with a DERIVED first-visit date, visit count, and
 * held-slot count — never stored counters (the derived style of
 * `role-recency-logic.ts`). See `guestVisits` for what counts as a visit.
 * Served for the pipeline view; the caller buckets by `stage`.
 */
export async function loadGuestPipeline(
	clubId: string,
	/**
	 * The viewer's OTHER admin clubs (#1127), for each row's `addableTo`. Callers
	 * that are not a viewer's board (the MCP reader, an export) pass none.
	 */
	otherAdminClubIds: string[] = [],
): Promise<PipelineGuestRow[]> {
	// Both club-level facts in ONE query. They live on the same `clubs` row, and
	// the timezone has to resolve before the visits subquery can be built, so a
	// `Promise.all` over two loaders bought concurrency for a round trip that did
	// not need to exist at all.
	const { timeZone: tz, countryCode: cc } =
		await loadClubPipelineSettings(clubId);
	const [rows, visitRows, slotRows, linkRows, conversionRows, inviteRows] =
		await Promise.all([
			db
				.select({
					id: guests.id,
					name: guests.name,
					preferredName: guests.preferredName,
					// A guest's contact lives on their Person (#1125), and so does the
					// answer to "may this club change it".
					email: people.email,
					phone: people.phone,
					contactRefusal: guestContactRefusalSql(clubId),
					stage: guests.stage,
					convertedMembershipId: guests.convertedMembershipId,
					createdAt: guests.createdAt,
					personId: guests.personId,
					// Another club's guest row or membership on this Person (#1127). A
					// boolean only; nothing about that club is selected.
					sharedWithOtherClub: sql<boolean>`${personHeldElsewhereSql(sql`${guests.personId}`, sql`${clubId}::uuid`)}`,
				})
				.from(guests)
				.innerJoin(people, eq(people.id, guests.personId))
				.where(eq(guests.clubId, clubId))
				.orderBy(asc(guests.name)),
			loadGuestVisitSummaries(db, clubId, tz),
			db
				.select({
					guestId: roleSlots.assignedGuestId,
					heldSlotCount: count(),
				})
				.from(roleSlots)
				.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
				.where(
					and(
						eq(meetings.clubId, clubId),
						isNotNull(roleSlots.assignedGuestId),
					),
				)
				.groupBy(roleSlots.assignedGuestId),
			// Which guests' pointers came from a LINK (#635) rather than a real
			// convert. Joined to `guests` on BOTH the guest id and the CURRENT
			// membership, so a stale record from a link that was since undone and
			// replaced by a real convert does not read as reversible.
			db
				.select({ guestId: guests.id })
				.from(activityLog)
				.innerJoin(
					guests,
					// Both comparisons cast explicitly. `activity_log.target_id` is TEXT
					// while `guests.id` / `converted_membership_id` are UUID, and Postgres
					// has no text=uuid operator — the uncast version was a 500 on every
					// board load, not a wrong answer.
					and(
						sql`${activityLog.detail}->>'fromGuestId' = ${guests.id}::text`,
						sql`${activityLog.targetId} = ${guests.convertedMembershipId}::text`,
					),
				)
				.where(
					and(
						eq(activityLog.clubId, clubId),
						eq(activityLog.action, "member_merge"),
					),
				),
			// Which guests' CONVERSIONS carry a replayable record (#618). Same join
			// shape as the links above and for the same reason, but the predicate is
			// applied in JS rather than in SQL: `readConversionRecord` is what
			// `applyUndoGuestConversion` refuses on, and a second definition of
			// "replayable" expressed in `jsonb ?` operators would drift from it. The
			// board offering an Undo the server then refuses is precisely the bug the
			// link comment above records.
			db
				.select({ guestId: guests.id, detail: activityLog.detail })
				.from(activityLog)
				.innerJoin(
					guests,
					and(
						sql`${activityLog.detail}->>'fromGuestId' = ${guests.id}::text`,
						sql`${activityLog.targetId} = ${guests.convertedMembershipId}::text`,
					),
				)
				.where(
					and(
						eq(activityLog.clubId, clubId),
						eq(activityLog.action, "member_add"),
					),
				),
			// Invite drafts (#899). An invite to a meeting cancelled afterwards stays
			// in the table but is not shown, so the filter is here rather than a
			// delete on cancel. Latest first, so the first row per guest is
			// `lastInvite`; one row per (guest, meeting) by the unique index, so the
			// row count per guest IS the distinct-meeting count.
			db
				.select({
					guestId: guestInvites.guestId,
					meetingId: guestInvites.meetingId,
					meetingAt: meetings.scheduledAt,
					invitedByName: members.name,
				})
				.from(guestInvites)
				.innerJoin(meetings, eq(meetings.id, guestInvites.meetingId))
				.leftJoin(members, eq(members.id, guestInvites.invitedByMemberId))
				.where(
					and(
						eq(guestInvites.clubId, clubId),
						eq(meetings.clubId, clubId),
						ne(meetings.status, "cancelled"),
					),
				)
				.orderBy(desc(guestInvites.invitedAt), desc(guestInvites.id)),
		]);

	// Which of the viewer's other admin clubs already hold each Person (#1127):
	// an unconverted guest row or an active membership there means "Add to" is
	// not offered. One read, only when the viewer has another club at all.
	const heldIn = new Map<string, Set<string>>();
	if (otherAdminClubIds.length > 0 && rows.length > 0) {
		const personIds = [...new Set(rows.map((r) => r.personId))];
		// One probe of every (Person, club) pair, by the same rule Add's refusal uses.
		const held = await db.execute<{ person_id: string; club_id: string }>(sql`
			select pc.person_id, pc.club_id
			from (
				select p.person_id, c.club_id
				from unnest(${sql.param(personIds)}::uuid[]) as p(person_id)
				cross join unnest(${sql.param(otherAdminClubIds)}::uuid[]) as c(club_id)
			) pc
			where ${personHereSql(sql`pc.person_id`, sql`pc.club_id`)}`);
		for (const h of held.rows) {
			const set = heldIn.get(h.person_id) ?? new Set<string>();
			set.add(h.club_id);
			heldIn.set(h.person_id, set);
		}
	}

	const visitsByGuest = new Map(visitRows.map((v) => [v.guestId, v]));
	const slotsByGuest = new Map(slotRows.map((s) => [s.guestId, s]));
	const reversible = new Set(linkRows.map((l) => l.guestId));
	const undoable = new Set(
		conversionRows
			.filter((c) => readConversionRecord(c.detail) !== null)
			.map((c) => c.guestId),
	);
	const invitesByGuest = new Map<
		string,
		{
			last: PipelineGuestRow["lastInvite"];
			meetings: Set<string>;
		}
	>();
	for (const inv of inviteRows) {
		const entry = invitesByGuest.get(inv.guestId);
		if (entry) {
			entry.meetings.add(inv.meetingId);
			continue;
		}
		invitesByGuest.set(inv.guestId, {
			last: {
				meetingId: inv.meetingId,
				meetingAt: new Date(inv.meetingAt),
				invitedByName: inv.invitedByName ?? null,
			},
			meetings: new Set([inv.meetingId]),
		});
	}

	return rows.map((r) => {
		const v = visitsByGuest.get(r.id);
		return {
			id: r.id,
			name: r.name,
			preferredName: r.preferredName,
			email: r.email,
			// Coalesced to E.164 (#295) so the pipeline card's WhatsApp link is a
			// valid full number even for rows written before normalize-on-write, and
			// a digit-less value still reaches the UI — see `#/lib/phone`.
			phone: coalesceToE164(r.phone, cc),
			// The column verbatim, for the edit dialog. See `PipelineGuestRow.phoneRaw`.
			phoneRaw: r.phone,
			contactRefusal: r.contactRefusal ?? null,
			stage: r.stage,
			convertedMembershipId: r.convertedMembershipId,
			linkReversible: reversible.has(r.id),
			conversionUndoable: undoable.has(r.id),
			visitCount: Number(v?.visitCount ?? 0),
			firstVisitAt: v?.firstVisitAt ? new Date(v.firstVisitAt) : null,
			heldSlotCount: Number(slotsByGuest.get(r.id)?.heldSlotCount ?? 0),
			lastInvite: invitesByGuest.get(r.id)?.last ?? null,
			inviteCount: invitesByGuest.get(r.id)?.meetings.size ?? 0,
			invitedMeetingIds: [...(invitesByGuest.get(r.id)?.meetings ?? [])],
			sharedWithOtherClub: Boolean(r.sharedWithOtherClub),
			addableTo:
				r.stage === "joined"
					? []
					: otherAdminClubIds.filter((id) => !heldIn.get(r.personId)?.has(id)),
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
 * **Where each field goes (#1125, ADR-0031).** The name and goes-by name stay on
 * the guest row, per club like `members.name`. The email and phone are the
 * PERSON's, so they are written to `people`, and only under
 * `guestContactWritable(clubId)` in that UPDATE's own WHERE: the Person is
 * guest-only (nobody has signed in as them, no club has them as a member) and
 * this club holds a guest row on them. The fix then shows in every club that
 * holds a guest row on the Person, because it is one person with one address.
 * The Person owns their contact and clubs are custodians until the person speaks
 * for themselves (the maintainer, 2026-10-07).
 *
 * A submitted email and phone that equal what is stored write nothing: a form
 * that only fixes a NAME resends the contact it displayed, and that must work for
 * a guest whose Person is a member's. When they differ and the write matches no
 * row, the whole edit (the name too) rolls back and one message says why, the
 * first that applies: signed in, a member here, a member of another club
 * (`GUEST_CONTACT_REFUSAL_MESSAGES`). The pipeline row carries the same reason
 * (`contactRefusal`) so the dialog shows the contact read-only and this is
 * normally never reached from it.
 *
 * Lock protocol (ADR-0031): the club's write lock, then the Person `FOR UPDATE`;
 * the guest row is written last. Every writer of `guests.person_id` takes the club
 * lock first, so the Person read before the Person lock is the Person locked.
 *
 * The edit is REFUSED when the new phone/email already belongs to a different
 * club guest. `captureGuestVisit` dedups on exactly those two keys, so allowing
 * the collision would leave two rows matching one submission — the returning
 * visitor's history would then split across them depending on which row the
 * lookup happened to pick. Create can silently reuse the match; an edit cannot
 * (that would be a merge, and merging two visit histories is not this path's
 * job), so it fails with a message naming the other guest. Another guest row on
 * the SAME Person is not another human, so it never clashes.
 */
export async function applyUpdateGuest(
	input: UpdateGuestInput,
): Promise<{ ok: true }> {
	const name = input.name.trim();
	if (!name) throw new Error("A guest name is required.");

	const cc = await loadClubDefaultCountryCode(input.clubId);
	// OMITTED contact (`undefined`) is "leave it as it is" (#1125); `null` or blank
	// clears it. The dialog sends a field only when the officer changed it, so a
	// form that only fixes a name neither re-sends a stale copy over a newer value
	// nor trips a check on a stored value it never touched.
	const sentEmail =
		input.email === undefined ? undefined : input.email?.trim() || null;
	const sentPhone =
		input.phone === undefined ? undefined : toStoredPhone(input.phone, cc);

	try {
		return await db.transaction(async (tx) => {
			// 1. The club write lock, before any row lock (ADR-0031).
			await lockClubForWrite(tx, input.clubId);

			// 2. The Person, locked. Read first to learn WHICH Person; the club lock
			//    is what keeps that answer true until the Person lock is held.
			const [peek] = await tx
				.select({ personId: guests.personId })
				.from(guests)
				.where(
					and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)),
				)
				.limit(1);
			if (!peek) throw new Error("Guest not found in this club.");
			await lockPersonsInOrder(tx, forUpdate(peek.personId));

			const [guest] = await tx
				.select({
					personId: guests.personId,
					email: people.email,
					phone: people.phone,
				})
				.from(guests)
				.innerJoin(people, eq(people.id, guests.personId))
				.where(
					and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)),
				)
				.limit(1);
			if (!guest) throw new Error("Guest not found in this club.");
			if (guest.personId !== peek.personId)
				throw new Error(RECORD_CHANGED_MESSAGE);

			// What is stored, and what the edit would leave: an omitted field keeps the
			// stored value (read under the Person lock, so it is the NEWEST one).
			// The stored phone is compared both as stored and as `toStoredPhone` would
			// store it, so a legacy value that was never normalized does not read as a
			// change on a form that only fixed a name.
			const storedEmail = guest.email ?? null;
			const storedPhone = guest.phone ?? null;
			const emailChanged =
				sentEmail !== undefined && sentEmail !== (storedEmail?.trim() || null);
			const phoneChanged =
				sentPhone !== undefined &&
				sentPhone !== storedPhone &&
				sentPhone !== toStoredPhone(storedPhone, cc);
			const email = emailChanged ? (sentEmail ?? null) : storedEmail;
			const phone = phoneChanged ? (sentPhone ?? null) : storedPhone;

			// The clash check runs on a SUBMITTED CHANGE only, and only for the changed
			// key: a stored value the officer did not touch is not re-litigated by a
			// name fix (a legacy duplicate would otherwise block every edit of it).
			const clash =
				emailChanged || phoneChanged
					? await findGuestForContact(
							tx,
							input.clubId,
							{
								name,
								email: emailChanged ? email : null,
								phone: phoneChanged ? phone : null,
							},
							{
								excludeGuestId: input.guestId,
								excludePersonId: guest.personId,
							},
						)
					: undefined;
			if (clash) {
				throw new Error(
					`Another guest in this club (${clash.name}) already has that phone number or email.`,
				);
			}

			// 3. The contact, on the Person, only when a submitted value differs from
			//    what is stored.
			if (emailChanged || phoneChanged) {
				const written = await tx
					.update(people)
					.set({ email, phone })
					.where(
						and(
							eq(people.id, guest.personId),
							guestContactWritable(input.clubId),
						),
					)
					.returning({ id: people.id });
				if (written.length === 0) {
					// Zero rows: the predicate refused. Say WHY from the same definition
					// the board shows; a Person the predicate no longer matches for
					// another reason (the guest moved, the Person is gone) is "changed".
					// Throwing rolls back the whole edit, the name included.
					const refusal = await guestContactRefusalFor(
						guest.personId,
						input.clubId,
						tx,
					);
					throw new Error(
						refusal
							? GUEST_CONTACT_REFUSAL_MESSAGES[refusal]
							: RECORD_CHANGED_MESSAGE,
					);
				}
			}

			// 4. The guest row: name and goes-by name, per club.
			await tx
				.update(guests)
				.set({
					name,
					preferredName: input.preferredName?.trim() || null,
					updatedAt: new Date(),
				})
				.where(
					and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)),
				);
			return { ok: true as const };
		});
	} catch (err) {
		// The writers that lock this club take its write lock first; a 40P01 is a
		// cycle through one that does not. Nothing was written (the transaction
		// rolled back), so say "try again", not the driver's `Failed query: …`.
		if (isDeadlock(err)) throw new Error(CLUB_BUSY_MESSAGE, { cause: err });
		throw err;
	}
}

export interface DeleteGuestInput {
	clubId: string;
	guestId: string;
	actorMemberId: string | null;
}

/** `applyDeleteGuest` refuses a guest who owns a speech (#1046). */
export const GUEST_HAS_SPEECHES_MESSAGE =
	"This guest has speeches on record, so they can't be deleted — mark them lost instead.";

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
 * - A guest who OWNS a speech (`speeches.guest_id`, #1046: a visiting
 *   Toastmaster's speech from imported history) is REFUSED
 *   ({@link GUEST_HAS_SPEECHES_MESSAGE}). The FK would cascade the speech away
 *   with the row, and a speech on record is club history, not a mistake. The
 *   check runs after the guest row is locked, in this transaction, so a speech
 *   inserted concurrently is either seen or waits on the lock. (Deleting the
 *   whole CLUB still cascades them; that is the FK, deliberately unchanged.)
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
		// The lock protocol (ADR-0031): the club write lock, then the guest's Person,
		// then the guest row, because the guest's Person goes with it when nothing
		// else references it (M2 of #1155).
		await lockClubForWrite(tx, input.clubId);
		const [peek] = await tx
			.select({ personId: guests.personId })
			.from(guests)
			.where(and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)))
			.limit(1);
		// An EARLY lock, chosen from an unlocked read that may be stale
		// (`holdsMembership`): FOR UPDATE on a Person that holds no membership, which
		// this delete may then delete; FOR NO KEY UPDATE on one that does (a linked or
		// converted guest's member Person), which would otherwise cycle with a speaker
		// claim. The delete itself takes FOR UPDATE once the Person is a candidate
		// (`deleteGuestPersonIfUnreferenced`), whatever this took.
		await lockPersonsInOrder(
			tx,
			(await holdsMembership(tx, peek?.personId))
				? noKeyUpdate(peek?.personId)
				: forUpdate(peek?.personId),
		);

		const [guest] = await tx
			.select({
				id: guests.id,
				name: guests.name,
				stage: guests.stage,
				convertedMembershipId: guests.convertedMembershipId,
				personId: guests.personId,
			})
			.from(guests)
			.where(and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)))
			.limit(1)
			.for("update");
		if (!guest) throw new Error("Guest not found in this club.");
		if ((guest.personId ?? null) !== (peek?.personId ?? null)) {
			throw new Error(RECORD_CHANGED_MESSAGE);
		}
		// Same correction as `applySetGuestStage` (#618), and this one's message was
		// actively misleading: it told the admin to "remove them from the roster
		// instead" — advice they had already followed, which is precisely how the
		// row reached this state. A stranded row is a guest again, so it may be
		// deleted like any other.
		if (
			(guest.stage === "joined" || guest.convertedMembershipId) &&
			!isStrandedConvertedGuest(guest)
		) {
			throw new Error(
				"This guest is now a club member — remove them from the roster instead.",
			);
		}
		const [spoke] = await tx
			.select({ id: speeches.id })
			.from(speeches)
			.where(eq(speeches.guestId, input.guestId))
			.limit(1);
		if (spoke) throw new Error(GUEST_HAS_SPEECHES_MESSAGE);

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
		await clearRecordedGuestContact(tx, input.clubId, input.guestId);
		await tx.delete(guests).where(eq(guests.id, input.guestId));
		// A guest is a Person (#1124): the Person goes with the guest, unless
		// something else still names it: another club's guest row, a membership, a
		// sign-in, a speech or an enrolment. Without this every mistaken or spam
		// guest left a name behind that no club can see and no delete reaches.
		if (guest.personId) {
			await deleteGuestPersonIfUnreferenced(tx, guest.personId);
		}
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
		.select({
			id: guests.id,
			stage: guests.stage,
			convertedMembershipId: guests.convertedMembershipId,
		})
		.from(guests)
		.where(and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)))
		.limit(1);
	if (!guest) throw new Error("Guest not found in this club.");
	// A joined guest is frozen because they ARE a member — reached only through
	// convert-to-member. That reasoning stops applying the moment the membership
	// is gone: `converted_membership_id` is `onDelete: "set null"`, so removing
	// the member from the roster left this row saying `joined` with nothing to
	// point at, and refusing here was what made the pipeline card a dead end with
	// no control on it at all (#618). Stranded rows may move again.
	if (guest.stage === "joined" && !isStrandedConvertedGuest(guest)) {
		throw new Error("This guest has already joined as a member.");
	}
	await db
		.update(guests)
		.set({ stage: input.stage, updatedAt: new Date() })
		.where(eq(guests.id, input.guestId));
	return { ok: true as const, stage: input.stage };
}

export interface RecordGuestInviteInput {
	clubId: string;
	guestId: string;
	meetingId: string;
	/** The resolved membership's id — never client input. Null for an
	 *  impersonating superadmin, who has no membership. */
	actorMemberId: string | null;
}

/**
 * Record that an officer opened an invite draft for `guestId` to `meetingId`
 * (#899). The app never sends: this is a coordination record so two officers do
 * not double up, not a delivery receipt.
 *
 * One row per (guest, meeting): a repeat upserts `invitedAt` and the actor.
 * Only a guest still in the funnel (`prospect` / `following_up`) may be
 * invited — every other stage is refused, a stranded `joined` row included (it
 * can be moved back to Prospect first, which `applySetGuestStage` allows). The
 * meeting must be this club's, not cancelled, and not yet started. Stage is
 * never changed. Club-scoped; the caller gates on admin, which also asserts the
 * archive gate.
 */
export async function applyRecordGuestInvite(
	input: RecordGuestInviteInput,
): Promise<{ ok: true }> {
	const [guest] = await db
		.select({ id: guests.id, stage: guests.stage })
		.from(guests)
		.where(and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)))
		.limit(1);
	if (!guest) throw new Error("Guest not found in this club.");
	if (!isInvitableStage(guest.stage)) throw new Error(NOT_INVITABLE_MESSAGE);
	const [meeting] = await db
		.select({
			id: meetings.id,
			scheduledAt: meetings.scheduledAt,
			status: meetings.status,
		})
		.from(meetings)
		.where(
			and(eq(meetings.id, input.meetingId), eq(meetings.clubId, input.clubId)),
		)
		.limit(1);
	if (!meeting) throw new Error("Meeting not found in this club.");
	// The `record` write class (#1137): an invite records an officer's act
	// against the meeting, and a cancelled one takes none. The sentence stays this
	// writer's own, which the VP Membership card shows as written.
	assertMeetingAccepts(meeting.status, "record", {
		messages: { cancelled: "That meeting is cancelled." },
	});
	if (meeting.scheduledAt.getTime() < Date.now()) {
		throw new Error("That meeting has already started.");
	}
	const invitedAt = new Date();
	await db
		.insert(guestInvites)
		.values({
			clubId: input.clubId,
			guestId: input.guestId,
			meetingId: input.meetingId,
			invitedByMemberId: input.actorMemberId,
			invitedAt,
		})
		.onConflictDoUpdate({
			target: [guestInvites.guestId, guestInvites.meetingId],
			set: { invitedAt, invitedByMemberId: input.actorMemberId },
		});
	return { ok: true as const };
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
	/**
	 * Convert REUSED a membership that had lapsed, and set it back to `active`
	 * (#501). The UI says so — see `CONVERT_REACTIVATED_MESSAGE`.
	 *
	 * True ONLY when the reuse branch fired AND the row was not already active.
	 * It means REUSE-OF-A-LAPSED-ROW, not success: a fresh membership is
	 * `false`, and so is reuse of a membership that was already active, which is
	 * ordinary dedup rather than a reactivation. A notice on the common path
	 * would cry wolf and admins would learn to ignore it.
	 */
	reactivated: boolean;
	/**
	 * The elevated `club_role` the wake-up wrote back down to `member`, or
	 * absent when the reused row was not elevated (#501 review).
	 *
	 * `"admin"` is the only reachable value — `club_role` is only
	 * (admin, member) and `member` is the floor being written to. Present ONLY
	 * alongside `reactivated`: reuse of an already-active admin is ordinary
	 * dedup and is left alone.
	 */
	demotedFrom?: "admin";
	/**
	 * Open officer positions the wake-up ENDED, because effective-admin (#202)
	 * would otherwise have handed back through them exactly the access
	 * `demotedFrom` just removed (#805).
	 *
	 * Non-empty means this convert changed who the club's officers are, which
	 * is why it reaches the UI rather than staying a server-side fact — it is
	 * the same disclosure obligation as `demotedFrom`, one table over. Always
	 * `[]` on every path that did not reactivate: a sitting officer that convert
	 * merely deduped onto is left completely alone.
	 */
	closedOfficerPositions: OfficerPosition[];
	/**
	 * @deprecated Always `[]`. Shipped ONLY so a tab loaded before this deploy
	 * does not throw, and removable in the NEXT release that touches this file —
	 * once no client older than #805 can still be open, delete this field and
	 * the line that emits it. Nothing in this repo reads it; the only reader it
	 * exists for is a bundle that is no longer being served.
	 *
	 * This field is the #504 hazard one axis over: not the server fn's METHOD
	 * but its response SHAPE. The URL is derived from the file and export name,
	 * so it is byte-identical across an auto-deploy, and a client loaded before
	 * it keeps posting to the new server quite happily. What it then does is
	 * `result.retainedOfficerPositions.length` — unguarded, because the field
	 * was required — and that throws a TypeError AFTER the transaction has
	 * committed: the admin sees `toast.error("Cannot read properties of
	 * undefined")` on a convert that SUCCEEDED, and `router.invalidate()` never
	 * runs, so the board still shows the guest as a prospect. It fires only when
	 * `reactivated` is true, which is exactly the converts this feature changed.
	 *
	 * Empty rather than the closed positions: the old client's sentence said the
	 * term still stood, which is now false. `[]` makes the stale tab silent
	 * about offices and correct about everything else, and the fresh tab reads
	 * `closedOfficerPositions` for the real notice.
	 */
	retainedOfficerPositions: OfficerPosition[];
	/**
	 * The address this convert wrote onto the new roster row is already on
	 * ANOTHER Person's roster row, so neither can sign in until each has their
	 * own (#759). Absent otherwise. Reported, never refused — the member edit
	 * form's policy — and computed after commit; see the end of
	 * `applyConvertGuestToMember` for why that matters.
	 */
	rosterConflict?: "shared_address";
}

/**
 * The per-club convert lock: a transaction-scoped advisory lock, released at
 * commit or rollback. Exported so a test can hold the SAME key and prove a
 * convert waits on it; the key is namespaced so no other advisory user of this
 * database can collide with it by accident.
 */
export async function lockClubConverts(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	clubId: string,
): Promise<void> {
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtextextended(${`guest-convert:${clubId}`}, 0))`,
	);
}

/**
 * Drop the contact a link recorded for this guest from every `member_merge`
 * activity row that still carries it (#1125). The record exists only so an unlink
 * can give the guest back the contact its abandoned Person took with it; it must
 * not outlive that purpose, because activity rows outlive the guest and the Person
 * (the repo's rule is that deleting a Person removes their contact). Called when
 * the unlink has used it, when the guest is deleted, when a convert moves a
 * stranded linked guest onto a Person of its own, and when a new link supersedes an
 * older record. A club delete takes the activity log with it (`ON DELETE CASCADE`).
 */
async function clearRecordedGuestContact(
	tx: DbOrTx,
	clubId: string,
	guestId: string,
): Promise<void> {
	await tx
		.update(activityLog)
		.set({ detail: sql`${activityLog.detail} - 'guestContact'` })
		.where(
			and(
				eq(activityLog.clubId, clubId),
				eq(activityLog.action, "member_merge"),
				sql`${activityLog.detail}->>'fromGuestId' = ${guestId}`,
				sql`${activityLog.detail} ? 'guestContact'`,
			),
		);
}

/**
 * The contact a convert may treat as THE GUEST'S (#1125): the email and phone on
 * the Person its row names, but ONLY while that Person is a guest's own, i.e.
 * `identityIgnoredGuestPerson()`: nobody has signed in as them, no membership,
 * no roster-identity column and no removal on record. A Person with a past as a
 * member (a removed member's, one a wrong link pointed the guest at), or one with
 * an account, carries SOMEBODY ELSE's contact as far as this guest is concerned,
 * and copying it onto the guest's new Person would put another human's address
 * on a membership: a wrong-person sign-in key (Alice's card linked to Bob, Bob
 * removed, Alice converted: Bob signing in would bind Alice's membership). Such a
 * Person yields no contact, so the convert mints the new Person name-only and the
 * dedupe below has no address to match on either.
 *
 * Read under the Person lock the caller holds, which keeps it from changing under
 * the convert (a contact edit takes the Person `FOR UPDATE`).
 */
async function guestOwnContact(
	tx: DbOrTx,
	personId: string,
): Promise<{ email: string | null; phone: string | null }> {
	const [row] = await tx
		.select({ email: people.email, phone: people.phone })
		.from(people)
		.where(and(eq(people.id, personId), identityIgnoredGuestPerson()))
		.limit(1);
	return row ?? { email: null, phone: null };
}

/**
 * What a convert reads off the guest row and its Person: the name, the goes-by
 * name, the address and phone it would write to the Person, and the digits it
 * dedupes on.
 */
function convertIdentity(
	guest: {
		name: string;
		preferredName: string | null;
		email: string | null;
		phone: string | null;
	},
	cc: string,
) {
	const name = guest.name.trim();
	// A "goes by" name recorded while they were a guest survives the promotion
	// (#486) — it was true of the human, not of the guest row.
	const preferredName = guest.preferredName?.trim() || null;
	const email = guest.email?.trim() || null;
	// Re-standardize to E.164 on the way into `people` (#295) — the guest
	// row may predate normalize-on-write; the digits form (dedup) follows it.
	const phone = toStoredPhone(guest.phone, cc);
	return { name, preferredName, email, phone, digits: normalizePhone(phone) };
}

/**
 * The Person of THIS club's roster a convert dedupes the guest onto, or null
 * (#759, #488): email, then a phone whose name agrees. Read twice by
 * `applyConvertGuestToMember`, once before it locks the Persons and once under
 * the locks, so it takes the transaction and nothing it has locked.
 *
 * 1. Person dedup (email → phone+name → none). People are global
 *    (club-less), so both arms match only a Person THIS club already
 *    holds (#759) — an unscoped match reached across every club, and
 *    attaching a stranger's Person here denies them sign-in.
 *
 *    Email leads because it identifies ONE human. Phone does not: a shared
 *    household or work number is ordinary in a guest book (a member brings
 *    their spouse, both write the same mobile), and matching on it alone
 *    fused the two — taking the newcomer's future speeches and Pathways
 *    enrollments onto the wrong Person, since all three FKs are
 *    Person-scoped. So a phone match must also agree on the name (#488).
 *
 *    When neither qualifies the caller adopts the guest's OWN Person rather
 *    than a best guess: ADR-0008 treats dedupe/merge as a later deliberate
 *    action, and the superadmin merge tool exists to fuse two Persons after the
 *    fact. Under-matching is visible and reversible; over-matching is neither.
 */
async function matchClubMemberPerson(
	tx: DbOrTx,
	clubId: string,
	who: { name: string; email: string | null; digits: string },
): Promise<string | null> {
	const { name, email, digits } = who;
	let personId: string | null = null;
	// Oldest-first and tie-broken on id: a bare `limit(1)` over two matching
	// rows is a Postgres coin flip, so which human a guest converted onto was
	// not even stable across runs. `findGuestByContact` already does this.
	const order = [asc(people.createdAt), asc(people.id)] as const;
	if (email) {
		// Take TWO, not one. ADR-0008's precedence says to match on email only
		// when it "resolves to exactly one person", and to "never auto-merge on
		// an email shared by 2+ distinct people (guards against fusing spouses /
		// shared family emails)". A family address is real — `listDuplicatePeople`
		// exists because of it — and matching the oldest of two would be the same
		// household fusion #488 fixes for phone numbers, just on the key this
		// change promoted to go first. The CSV importer already honours this
		// (its `ambiguous` stat); the convert path did not.
		// Matches the Person's one address (#907), and only a Person THIS club
		// already holds (#759) — that is the INNER join's doing. Without it a
		// guest typed with a stranger's address attached that stranger's Person
		// to this club. A Person no club holds is refused too. A refused match
		// falls through to the caller's adopt-the-guest's-Person arm, which is safe
		// here as it is not in the importer: a guest carries no Customer ID to
		// collide with.
		const candidates = await tx
			.selectDistinct({ id: people.id, createdAt: people.createdAt })
			.from(people)
			.innerJoin(
				members,
				and(eq(members.personId, people.id), eq(members.clubId, clubId)),
			)
			.where(sql`${normalizedEmail(people.email)} = ${email.toLowerCase()}`)
			.orderBy(...order)
			.limit(2);
		if (candidates.length === 1) personId = candidates[0]?.id ?? null;
	}
	if (!personId && digits) {
		// Every phone match is a CANDIDATE, not a result — scan them for one
		// whose name agrees rather than taking the first row and hoping.
		//
		// Club-scoped for the reason the email arm is (#759): this had no scope
		// at all, so a guest carrying a stranger's phone and name attached the
		// stranger's Person to this club. One row per Person by construction —
		// `members_club_person_unique` — so the join cannot fan out.
		const candidates = await tx
			.select({ id: people.id, name: people.name })
			.from(people)
			.innerJoin(
				members,
				and(eq(members.personId, people.id), eq(members.clubId, clubId)),
			)
			.where(
				sql`regexp_replace(coalesce(${people.phone}, ''), '[^0-9]', '', 'g') = ${digits}`,
			)
			.orderBy(...order)
			.limit(PHONE_CANDIDATE_LIMIT);
		const match = candidates.find((p) => namesAgree(p.name, name));
		if (match) personId = match.id;
	}
	return personId;
}

/**
 * Convert-to-member (ADR-0018): promote a guest into a club Membership.
 *
 * Transactional: (1) dedup the Person by email→phone-with-name-agreement (link
 * an existing Person of THIS club, else adopt the guest's own Person if it is
 * PRISTINE (`pristineGuestPerson`), which already carries the guest's own
 * contact (#1125), and otherwise mint a fresh one carrying the guest's values —
 * see the step-1 comment for why a bare phone match is not enough); (2) create the Membership for this club (`clubRole: member`,
 * `joinedAt: today`) — or reuse the person's existing membership so we never
 * violate one-membership-per-person-per-club, REACTIVATING that row when it had
 * lapsed (#501) — and writing its `club_role` back down to `member` when it was
 * elevated AND ending any officer term it was still carrying (#805), because
 * waking a membership restores visibility, never authority — saying so through
 * `reactivated` / `demotedFrom` / `closedOfficerPositions`; (3) re-point every role slot the
 * guest holds to the new member (member-XOR-guest holds — set member + clear
 * guest together); (4) stamp the guest `stage: joined` with
 * `converted_membership_id` (the row PERSISTS, its past attendance stays as
 * guest history); (5) write an activity_log entry. Caller gates on admin.
 */
export async function applyConvertGuestToMember(
	input: ConvertGuestInput,
): Promise<ConvertGuestResult> {
	const cc = await loadClubDefaultCountryCode(input.clubId);
	// The Person this convert FILLED an address on, for the shared-address check
	// after commit (see the end).
	let written: { personId: string; email: string } | null = null;

	const result = await db.transaction(async (tx) => {
		// Serialize every convert in this CLUB, not just this guest (#759 review).
		// The dedup below matches only a Person whose roster row here is
		// COMMITTED, so two different guest cards for one visitor converted at
		// once each saw nothing, each minted a Person (before #1124; each guest
		// card now adopts its OWN Person), and the unique index could not collide
		// across two new person ids — a duplicate roster row. Before #759 both
		// matched one global Person and the index caught it.
		//
		// BEFORE the guest lock, and that order is load-bearing. Taken after it,
		// a convert waiting here held its guest row while it waited, and a slot
		// reassignment onto that guest (`applyAssignGuestToSlot`, whose FK check
		// needs the guest row) could sit between two converts: the lock holder
		// waiting on the slot, the slot writer on the guest, the guest's convert
		// on this lock — a deadlock with no retry. Waiting here holds nothing.
		await lockClubConverts(tx, input.clubId);

		// The lock protocol (ADR-0031): the club write lock, then the Persons, then
		// the guest row. This and the convert lock above are both advisory and wait
		// holding no row; what matters is that the club's write lock is taken
		// before any ROW lock, because `mergePeople` takes it and then both
		// Persons, and a convert that locked a Person first would be the reverse.
		//
		// The Persons are only known by reading, so they are READ without a lock,
		// locked in id order, and read again under the locks (the read-then-lock
		// rule). TWO can be involved: the guest's own, and the member of THIS club
		// the dedupe below may match instead, which the dedupe-hit path then writes
		// (the goes-by seed and the phone fill). Locking the second one only when
		// it is reached would take the Persons in whatever order the data happened
		// to fall, so both are locked together first. Either moving in between
		// refuses the convert, with nothing written.
		await lockClubForWrite(tx, input.clubId);
		const [peek] = await tx
			.select()
			.from(guests)
			.where(and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)))
			.limit(1);
		if (!peek) throw new Error("Guest not found in this club.");
		const peekMatch = await matchClubMemberPerson(
			tx,
			input.clubId,
			convertIdentity(
				{ ...peek, ...(await guestOwnContact(tx, peek.personId)) },
				cc,
			),
		);
		// NO KEY UPDATE: a convert MAY delete a Person, but only the guest's old one
		// when the guest was not pristine, and then `deleteGuestPersonIfUnreferenced`
		// takes `FOR UPDATE` on it in its own statement just before the DELETE. Taking
		// it here would block the key share a speaker claim takes on the Person while
		// it holds the slot, for every convert, including the many that delete nothing.
		await lockPersonsInOrder(tx, noKeyUpdate(peek.personId, peekMatch));

		// Then lock the guest row, and re-check `stage` under that lock.
		//
		// The unique index (#489) only catches a double-add once both racers have
		// resolved the SAME Person. Before #1124 two concurrent converts of one
		// CONTACTLESS guest — email and phone are both optional on the public book —
		// each created a fresh Person, so the two membership inserts carried
		// DIFFERENT person_ids and the club got two roster rows plus two Person rows
		// for one human. Both now adopt the guest's own Person and would collide on
		// the index, but serializing on the guest row is still what closes it
		// without a raw violation, and it is what makes the `stage` check mean
		// anything: read outside the transaction it was a stale snapshot.
		const [guest] = await tx
			.select()
			.from(guests)
			.where(and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)))
			.limit(1)
			.for("update");
		if (!guest) throw new Error("Guest not found in this club.");
		if (guest.personId !== peek.personId) {
			throw new Error(RECORD_CHANGED_MESSAGE);
		}
		if (guest.stage === "joined") {
			throw new Error("This guest has already been converted to a member.");
		}

		// A stranded guest that was once LINKED still has that link's recorded
		// contact in the activity log; a convert gives it a Person of its own, so the
		// record has no unlink left to serve.
		await clearRecordedGuestContact(tx, input.clubId, input.guestId);
		// The contact is the guest's Person's (#1125), read under the Person lock.
		const identity = convertIdentity(
			{ ...guest, ...(await guestOwnContact(tx, guest.personId)) },
			cc,
		);
		const { name, preferredName, email, phone } = identity;
		let personId = await matchClubMemberPerson(tx, input.clubId, identity);
		// The same answer the unlocked read gave, or the Persons locked above are
		// not the Persons this convert is about to write.
		if (personId !== peekMatch) throw new Error(RECORD_CHANGED_MESSAGE);
		// Whether THIS conversion minted the Person, as opposed to adopting the
		// guest's or deduping onto one that already existed. Recorded in step 5 for
		// the undo's benefit (#618): nothing readable after the fact distinguishes
		// them, and an undo never deletes a Person either way.
		let createdPerson = false;
		let createdMembership = false;
		if (!personId) {
			// No member of THIS club matched. The membership goes on a Person the guest
			// row names, but only if that Person is PRISTINE (#1124, ADR-0031,
			// `pristineGuestPerson`): nobody has signed in as it, no membership in any
			// club, nothing it owns, no other guest row, no contact or roster-identity
			// column, no removal on record. That is evidence, not proof, of a Person that
			// was only ever the guest. Only such a Person is the guest's own to rename and
			// to give contact, and that is what the maintainer ruled on 2026-10-09 (option
			// A) after a Person turned up
			// that was not: one a merge had made a former member's, one an earlier
			// convert had made a member and an officer had corrected, one a wrong link
			// had pointed at somebody else's. Writing the guest row's values onto those
			// re-keyed a real person, and let an address typed on the anonymous guest
			// book become the sign-in key of a Person with history.
			const guestPersonId = guest.personId;
			// The guest row is the officer's current word on who this is: the Person
			// was minted at capture time with the name then typed, and an officer's
			// correction since (a renamed guest, a goes-by name set or CLEARED) lives
			// only on the guest row. The membership is about to carry it, and the
			// Person is the fallback every other club reads, so it follows. The
			// contact needs no carrying: since #1125 it IS the Person's, written by
			// the guest writers, so `email` and `phone` here are the Person's own in
			// their canonical spelling (trimmed, E.164) and the statement changes no
			// address a guest writer had not already put there.
			//
			// The predicate is in the statement's own WHERE, and the statement matching
			// a row IS the decision: a sign-in, a membership or a second guest row that
			// lands after any earlier read makes it match nothing. BEFORE the membership
			// insert below, because the predicate reads false the moment this convert
			// adds one.
			const adopted = await tx
				.update(people)
				.set({ name, preferredName, email, phone })
				.where(
					and(eq(people.id, guestPersonId), pristineGuestPerson(input.guestId)),
				)
				.returning({ id: people.id });
			if (adopted.length > 0) {
				personId = guestPersonId;
			} else {
				// Not pristine. Mint a fresh Person carrying the guest row's name, goes-by
				// name and contact, point the guest at it, and convert onto it. This is
				// what a convert did before #1124. The old Person is somebody's history,
				// or the release target of an undone convert (#875), so it is not written;
				// it is deleted only if nothing references it (below).
				const [minted] = await tx
					.insert(people)
					.values({ name, preferredName, email, phone })
					.returning({ id: people.id });
				if (!minted) throw new Error("Failed to create person.");
				await tx
					.update(guests)
					.set({ personId: minted.id })
					.where(eq(guests.id, input.guestId));
				personId = minted.id;
				createdPerson = true;
				// The guest no longer names the old Person. If nothing else does, and no
				// removal names it, it would be stranded with whatever contact it
				// carries, so it goes (with its email backup); anything that references
				// it, or a release target, is left as it is, neither written nor deleted.
				await deleteAbandonedGuestPerson(tx, guestPersonId);
			}
			if (email) written = { personId, email };
		} else {
			if (preferredName) {
				// Deduped onto an EXISTING Person: the insert above never ran, so seed
				// the goes-by name here too or it is lost at the person level (#486).
				// Guarded on NULL, same as the membership-edit seed-up — whatever this
				// human already recorded in another club wins over a guest-book entry.
				await tx
					.update(people)
					.set({ preferredName })
					.where(and(eq(people.id, personId), isNull(people.preferredName)));
			}
			if (phone) {
				// The phone is the Person's (#906) — the membership no longer carries
				// one — so a guest's number reaches an EXISTING Person only by FILLING
				// a blank. Never an overwrite: the guest book is an anonymous form,
				// and a number already on file was typed by an officer or an import
				// in some club that holds this human.
				await tx
					.update(people)
					.set({ phone })
					.where(and(eq(people.id, personId), isNull(people.phone)));
			}
			// NO email write here, deliberately (#907 review). The guest book is an
			// anonymous public form, so a visitor signing it with a member's name
			// and phone and THEIR OWN address would — through a fill — put that
			// address on the member's Person, which is the key a sign-in binds on,
			// and take the account with one magic link. A matched Person keeps the
			// address it has; an officer sets one on the member page.
		}

		// 2. Membership — reuse the person's existing one in this club, else create.
		//
		// LOCKED, and the lock is what makes the wake-up below honest. Convert
		// locks the GUEST row, not the membership, so reading the status and
		// branching in JS would race a concurrent roster deactivation. #501 first
		// shipped this as a single conditional UPDATE to dodge that — but the
		// privilege decision needs the row's PRIOR `club_role`, and Postgres
		// `RETURNING` hands back post-update values, so there is nothing to read
		// the old role out of. `FOR UPDATE` is the honest way to get both: undo
		// already takes exactly this lock on exactly this row, in the same order
		// (guest first, then membership), so the two cannot deadlock.
		const [existingMembership] = await tx
			.select({
				id: members.id,
				status: members.status,
				clubRole: members.clubRole,
			})
			.from(members)
			.where(
				and(eq(members.personId, personId), eq(members.clubId, input.clubId)),
			)
			.limit(1)
			.for("update");
		let membershipId: string;
		// Which status convert woke this membership OUT of, when it reused a
		// lapsed one. Recorded in step 5 for the same reason `createdMembership`
		// is: undo must be able to put the lapse back, and nothing readable after
		// the fact distinguishes a membership convert reactivated from one that
		// was active all along.
		let reactivatedFrom: "inactive" | undefined;
		// The elevated `club_role` the wake-up wrote back DOWN, when it found one.
		// Recorded for the same two reasons, plus a third: the roster needs to be
		// able to restore it deliberately, and a demotion nothing recorded is one
		// nobody can distinguish from a membership that was never an admin.
		let demotedFrom: "admin" | undefined;
		// Open officer terms the wake-up ended (#805). Disclosed to the admin
		// because closing them changes who the club's officers are — the same
		// obligation `demotedFrom` carries, one table over.
		let closedOfficerPositions: OfficerPosition[] = [];
		if (existingMembership) {
			membershipId = existingMembership.id;
			// #501: wake a LAPSED membership, or the convert leaves the member
			// invisible. `inactive` is not a soft label — per `schema.ts` it hides
			// the row from the roster, the sign-up sheet, the season grid and every
			// role picker — so reuse-without-touching-status returned `{ ok: true }`,
			// stamped the guest `joined`, and produced a member nobody could see.
			// Worse, step 3 below re-points the guest's slots onto it, so a returning
			// visitor who had claimed a role left that slot owned by a membership the
			// picker cannot display.
			//
			// An admin converting someone is asserting they are a member now, so
			// reactivating is the right answer — but never a SILENT one: Person dedup
			// can match the wrong human (#561), and the notice these flags drive is
			// the admin's chance to notice.
			//
			// `membership_status` is only (active, inactive) — see `schema.ts` — so
			// "not active" is `inactive` and nothing else. Do NOT widen this to a
			// status the enum cannot hold; `guest-convert-privilege.guard.test.ts`
			// fails on the widening rather than letting this record a wrong prior
			// state.
			if (existingMembership.status !== "active") {
				reactivatedFrom = "inactive";
				// The WAKE-UP IS A PRIVILEGE GRANT, and that is the half #501 missed.
				// `members.status === 'active'` is the write-authorization gate itself
				// — `requireMembership` sends a non-active membership to
				// `requireReadWriteImpersonation`, which refuses an ordinary caller —
				// and `applySetMemberStatus` never cleared `club_role` on the way out.
				// So a membership that lapsed while it said `admin` came back as a
				// full club admin, from a guest card that shows no role, behind a
				// toast whose only extra sentence was "(was inactive)". Dedup can land
				// on the wrong human (#561), so the person handed that access is not
				// even reliably the person the admin was looking at.
				//
				// Restoring VISIBILITY is what the convert asserts; restoring
				// AUTHORITY is a separate decision an admin must make deliberately,
				// and `ClubRoleControl` on the member page makes it one click.
				//
				// Only on the wake-up path. Reuse of an ALREADY-ACTIVE admin is
				// ordinary dedup of a sitting admin and is left completely alone —
				// demoting there would be a privilege regression convert has no
				// business performing.
				//
				// No `assertKeepsAnActiveAdmin` here (contrast `applySetMemberStatus`
				// / `applySetMemberRole`): the row being demoted is INACTIVE at this
				// instant, so it is not in the active-admin count, and demoting it in
				// the same statement that activates it cannot lower a count it was
				// never part of. A club already at zero active admins stays at zero —
				// which is where this convert found it.
				if (existingMembership.clubRole !== "member") {
					demotedFrom = existingMembership.clubRole;
				}
				await tx
					.update(members)
					.set({
						status: "active",
						...(demotedFrom ? { clubRole: "member" as const } : {}),
					})
					.where(eq(members.id, membershipId));
				// Effective-admin's OTHER source (#202), and the half the demotion
				// above cannot reach: any open `officer_terms` row makes a membership
				// a full admin whatever `club_role` says, and deactivation closes a
				// term no more than it clears a role. So a lapsed row can carry one,
				// and #501 shipped a wake-up that handed back through the term exactly
				// the access the statement above had just removed — with
				// `CONVERT_DEMOTED_MESSAGE` telling the admin otherwise (#805).
				//
				// Ended here, in the same transaction, through the exact inverse of
				// the seam `guards.ts` grants from, so the revocation and the grant
				// cannot read different sets of terms.
				//
				// ## Why this is not convert vacating a live office
				//
				// The office was already vacant everywhere THE GATE AND THE AGENDA
				// look. Both of those readers drop an inactive holder:
				// `currentOfficersForClub` skips `status === "inactive"`, so the
				// printed agenda's officer grid has been showing the position as Open,
				// and `loadOfficerSeats` filters on `status = 'active'`, so the COT
				// seats behind DCP goal 9 never listed them. The club has been running
				// without this officer for as long as the membership has been lapsed.
				// What the wake-up silently did was REINSTATE them — to the agenda and
				// to the gate — on a membership Person dedup chose, and dedup can land
				// on the wrong human (#561).
				//
				// It is NOT every reader, and the difference is visible. Three are
				// status-unaware and DO change here: `currentOfficersByMember` backs
				// the roster (`club.ts:40`) and the member profile (`club.ts:136`),
				// which is why a lapsed President has been rendering as President
				// there; and `getOnboardingChecklist` asks only whether the club has
				// ANY open term, so a club whose only officer is this lapsed one had
				// its "Assign officer roles" row COMPLETE before the convert and
				// INCOMPLETE after. That is the honest cost of this write, and it is
				// the correct direction on all three: the roster stops naming a
				// non-member as an officer, and the checklist stops counting one.
				//
				// Only on the wake-up path, and that is the whole scope of the
				// governance claim: reuse of an ALREADY-ACTIVE membership never
				// reaches this branch, so a sitting President deduped by a convert
				// keeps their office untouched. Vacating one THERE would be the
				// VP-Membership-button-as-governance-write this deliberately is not.
				//
				// ## Why nothing has to reverse it
				//
				// `applyUndoGuestConversion` refuses outright for a membership
				// carrying ANY `officer_terms` row, open or closed. A membership this
				// branch writes to HAD an open term a moment ago, and terms are closed
				// rather than deleted (#100), so the row is still there to be counted:
				// every conversion this close touches was already un-undoable before
				// it, and still is. There is therefore no half-reversed state to
				// record against — `guest-convert-privilege.integration.test.ts` pins
				// that coupling. The remedy is the member edit form's office
				// checkboxes, which `CONVERT_OFFICER_TERM_CLOSED_MESSAGE` names.
				closedOfficerPositions = await closeOpenOfficerTerms(tx, membershipId);
			}
		} else {
			// #617: refuse rather than silently duplicate a human.
			//
			// The Person dedup above matches on email, then on a phone whose name
			// agrees. It deliberately never matches on NAME alone — ADR-0008 makes
			// dedupe a later explicit action, and over-matching would be the
			// household fusion #488 closed. The consequence is that a roster row
			// carrying NO email and NO phone can never be matched, and until #616
			// the public self-add minted exactly that: name only. So converting a
			// guest who had also self-added produced a second Person and a second
			// membership — two identical names in the roster, the season grid and
			// every picker, with the human's history split across both.
			//
			// The check sits HERE, at the membership insert, not at the Person
			// insert where #617 first proposed it. When it was written, a guest whose
			// email deduped onto a Person from ANOTHER club skipped the Person-creating
			// path and could still add a duplicate name here; #759 club-scoped the
			// dedup, so that route is closed, but the race branch below still
			// reaches this insert with a Person it did not create. What must be
			// unique is a name within a club, so the guard belongs where the
			// club-scoped row is written.
			//
			// Refuse, do not auto-merge: under-matching is visible and reversible,
			// over-matching is neither, and the admin has a merge tool. Inactive
			// members count — they still occupy the name and still appear in the
			// VPE roster manager.
			const clubMembers = await tx
				.select({ id: members.id, name: members.name })
				.from(members)
				.where(eq(members.clubId, input.clubId));
			if (clubMembers.some((m) => namesAgree(m.name, name))) {
				throw new Error(CONVERT_NAME_CLASH_MESSAGE);
			}
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
				createdMembership = true;
			} else {
				// The conflict branch: a concurrent convert won and created this row.
				// It is not ours, so `createdMembership` stays false and an undo will
				// detach the guest without deleting a membership another conversion
				// is the author of.
				//
				// Since #759 the dedup above matches only a Person this club ALREADY
				// holds, which takes the reuse branch, and since #1124 a convert that
				// adopts the guest's own Person does so under the club's write lock and
				// the Person's row lock, so no second convert can be creating a
				// membership for it. Nothing ordinary reaches here any more — it would
				// take the matched roster row being deleted and re-added between the
				// dedup and the locked SELECT. Kept because the unique
				// index is still the guarantee and a raw violation would poison the
				// transaction; its integration test went with the route to it.
				//
				// It also never reactivates or demotes, and that is structural
				// rather than an omission (#501). This branch lives in the `else` of
				// `if (existingMembership)`, so the only row it can ever observe is
				// one a CONCURRENT convert just committed — and the insert above
				// hardcodes `status: "active"` and the default `clubRole: "member"`.
				// A membership that was already lapsed is found by the first select
				// and takes the reuse branch instead. `reactivatedFrom` and
				// `demotedFrom` therefore stay undefined here by construction; do
				// not "fix" this into the reactivating path.
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
		//
		// `returning` the ids is what makes step 5's record replayable. An undo
		// cannot re-derive this set later: by then the slots sit on the membership
		// beside any the member has been assigned SINCE, and moving those to a
		// guest would invent history rather than reverse it (#618). Same reason
		// `applyLinkGuestToMember` records its own `slotIds`.
		const movedSlots = await tx
			.update(roleSlots)
			.set({ assignedMemberId: membershipId, assignedGuestId: null })
			.where(eq(roleSlots.assignedGuestId, input.guestId))
			.returning({ id: roleSlots.id });

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
			// `slotIds`, `createdMembership` and `createdPerson` are what make this
			// conversion reversible (#618). A record without them predates undo and
			// is refused rather than half-replayed — see `applyUndoGuestConversion`.
			//
			// `reactivatedFrom` and `demotedFrom` are written only when there was
			// something to record, so each key's PRESENCE is the claim — which is
			// also what lets records written before #501 read as "reactivated
			// nothing", correctly, rather than as unreplayable. They are the audit
			// signal the issue asks for too: without them this row is
			// indistinguishable from a fresh join, and the demotion in particular
			// is a permission change with no `member_edit` of its own to explain
			// it.
			//
			// `closedOfficerPositions` is recorded for the reason `demotedFrom` is
			// and no other: it is a permission change with no `member_edit` of its
			// own to explain it, and without the key this row is indistinguishable
			// from a convert that ended nobody's office (#805). Written only when
			// something was closed, so its PRESENCE is the claim and records
			// predating this read correctly as "closed nothing".
			//
			// NOT a replay record. `readConversionRecord` does not parse it and
			// undo never reaches it — undo refuses any membership carrying an
			// officer term, which is every membership this key can appear on.
			// `officer_terms` keeps its own history with the real dates; a second
			// copy here would only be a staler one.
			detail: {
				name,
				fromGuestId: input.guestId,
				personId,
				slotIds: movedSlots.map((s) => s.id),
				createdMembership,
				createdPerson,
				...(reactivatedFrom ? { reactivatedFrom } : {}),
				...(demotedFrom ? { demotedFrom } : {}),
				...(closedOfficerPositions.length > 0
					? { closedOfficerPositions }
					: {}),
			},
		});

		return {
			ok: true as const,
			membershipId,
			personId,
			reactivated: reactivatedFrom !== undefined,
			...(demotedFrom ? { demotedFrom } : {}),
			closedOfficerPositions,
			// One release only — see the field's docblock. Delete this line and
			// the field together in the next release that touches this file.
			retainedOfficerPositions: [],
		};
	});

	// Did the address this convert wrote leave someone unable to sign in (#759)?
	// Reported, never refused — the member edit form's policy, and the CSV
	// importer's. Asked AFTER the transaction commits, not inside it:
	// `rosterConflictFor` reads the module-level `db`, so in flight it runs on a
	// different pooled connection, cannot see the membership just inserted, and
	// answers `no_vouching_row` — which the narrowing below discards, leaving the
	// conflict silently unreported on exactly the path it exists for.
	//
	// Only an address this convert WROTE is checked; any other obstacle
	// predates it. Narrowed to `shared_address`: the other arm is a property of
	// the subject itself.
	const probe = written as { personId: string; email: string } | null;
	if (probe) {
		// The convert has COMMITTED by now. A failure here must not surface as a
		// failed convert: the admin would retry, and the retry refuses because the
		// guest has already joined. Losing the notice is the lesser harm.
		try {
			const obstacle = await rosterConflictFor(probe.personId, probe.email);
			if (obstacle === "shared_address") {
				return { ...result, rosterConflict: obstacle };
			}
		} catch (err) {
			console.error("convert: shared-address check failed after commit", err);
		}
	}
	return result;
}

export interface LinkGuestInput {
	clubId: string;
	guestId: string;
	memberId: string;
	actorMemberId: string | null;
}

export interface LinkGuestResult {
	ok: true;
	/** Slots re-pointed from the guest to the member — also recorded in the log. */
	slotIds: string[];
}

/**
 * Link an EXISTING guest to an EXISTING roster member (#635) — a retroactive
 * convert for a human who became a member without going through
 * `applyConvertGuestToMember`.
 *
 * This is convert's steps 3-5 and nothing else: no Person is deduped or created,
 * no membership is created. Both rows already exist; what is missing is the
 * relationship between them.
 *
 * ## Why it exists
 *
 * The public self-add (#616) minted a `members` row with no session and no
 * awareness of the guest pipeline, so anyone already tracked as a guest ended up
 * with two rows and nothing joining them. They show in the member picker AND the
 * guest chips on one sheet. #616 closed that path and #617 stopped convert from
 * MAKING new duplicates — but #617 also refuses these rows, so before this they
 * had no path at all.
 *
 * ## Why ALL slots, not just upcoming
 *
 * `loadRoleRecency` groups PAST meetings by `roleSlots.assignedMemberId` to
 * decide whether a member has "Never done this role". Everything the human did
 * while assigned as a guest is invisible to their member row until those slots
 * move. Re-pointing only upcoming slots would clear the duplicate chip and leave
 * the fairness signal the VPE assigns roles from still wrong — a cosmetic fix.
 * It is also the harder query, needing a join to `meetings` and a date filter.
 */
export async function applyLinkGuestToMember(
	input: LinkGuestInput,
): Promise<LinkGuestResult> {
	return db.transaction(async (tx) => {
		// The lock protocol (ADR-0031): the club write lock, then the Persons (the
		// guest's, and the member's, whose Person the guest is about to take), then
		// the guest row. Read without a lock, locked in id order, read again.
		await lockClubForWrite(tx, input.clubId);
		const [peek] = await tx
			.select({ personId: guests.personId })
			.from(guests)
			.where(and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)))
			.limit(1);
		if (!peek) throw new Error("Guest not found in this club.");
		const [member] = await tx
			.select({ id: members.id, personId: members.personId })
			.from(members)
			.where(
				and(eq(members.id, input.memberId), eq(members.clubId, input.clubId)),
			)
			.limit(1);
		if (!member) throw new Error(LINK_MEMBER_NOT_IN_CLUB_MESSAGE);
		// The guest's own Person is the one a link may delete (nothing else names
		// it afterwards), so it is locked FOR UPDATE EARLY unless it holds a
		// membership, by an unlocked read that may be stale (`holdsMembership`): the
		// delete takes FOR UPDATE itself once the Person is a candidate. The
		// member's Person is never deleted, and is locked FOR NO KEY UPDATE so a
		// claim for that member is not blocked while the link waits for a slot.
		await lockPersonsInOrder(tx, [
			...((await holdsMembership(tx, peek.personId))
				? noKeyUpdate(peek.personId)
				: forUpdate(peek.personId)),
			...noKeyUpdate(member.personId),
		]);

		// Lock the guest row and re-read `stage` under it, for the reason
		// `applyConvertGuestToMember` documents: read outside the transaction it is
		// a stale snapshot, and two concurrent links would both pass the check.
		const [guest] = await tx
			.select()
			.from(guests)
			.where(and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)))
			.limit(1)
			.for("update");
		if (!guest) throw new Error("Guest not found in this club.");
		if ((guest.personId ?? null) !== (peek.personId ?? null)) {
			throw new Error(RECORD_CHANGED_MESSAGE);
		}
		// A STRANDED guest (joined, pointer null — #618) is deliberately allowed
		// through: their membership was removed from the roster, and pointing them
		// at a member is the recovery. Only a live link is refused.
		if (guest.stage === "joined" && guest.convertedMembershipId) {
			throw new Error(LINK_ALREADY_JOINED_MESSAGE);
		}
		// The member is re-read under the Person locks: a merge that moved their
		// membership to another Person while this waited would otherwise point the
		// guest at a Person that no longer holds it.
		const [memberNow] = await tx
			.select({ personId: members.personId })
			.from(members)
			.where(eq(members.id, input.memberId))
			.limit(1);
		if (memberNow?.personId !== member.personId) {
			throw new Error(RECORD_CHANGED_MESSAGE);
		}

		// `returning` is what makes this reversible. `role_slots` has a CHECK
		// constraint keeping the two assignee columns mutually exclusive, so this
		// UPDATE DESTROYS the record of which slots were the guest's. Capturing the
		// ids here is the only cheap way `applyUnlinkGuestFromMember` can put them
		// back; without it the link is permanently one-way.
		const repointed = await tx
			.update(roleSlots)
			.set({ assignedMemberId: input.memberId, assignedGuestId: null })
			.where(eq(roleSlots.assignedGuestId, input.guestId))
			.returning({ id: roleSlots.id });
		const slotIds = repointed.map((s) => s.id);

		// A linked guest IS the member's Person, as a converted one is (#1124,
		// ADR-0031, L5 of #1155): without this the next undo or unlink finds a
		// guest Person unrelated to the human it just joined to. The guest's own
		// Person, now named by nobody, is taken back when nothing else references
		// it, so a link leaves no stranded identity behind.
		//
		// The guest's own email and phone live on that Person (#1125) and go with it
		// when it is deleted, so they are read first and written into this link's
		// activity record, which is what lets an unlink put them back on the Person
		// it mints. Only a guest's OWN contact (`guestOwnContact`), and never a
		// Person the guest already shared with the member.
		await clearRecordedGuestContact(tx, input.clubId, input.guestId);
		const ownContact =
			guest.personId && guest.personId !== member.personId
				? await guestOwnContact(tx, guest.personId)
				: { email: null, phone: null };
		await tx
			.update(guests)
			.set({
				stage: "joined",
				convertedMembershipId: input.memberId,
				personId: member.personId,
				updatedAt: new Date(),
			})
			.where(eq(guests.id, input.guestId));
		if (guest.personId) {
			await deleteGuestPersonIfUnreferenced(tx, guest.personId);
		}

		// `member_merge` rather than a new enum value: the action already exists
		// (`schema.ts`), so this needs no migration, and `detail.fromGuestId` is
		// what tells a guest link apart from a member↔member merge — including for
		// `activity-format.ts`, which branches on it to avoid reading "merged a
		// duplicate member" for something that was not that.
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: input.actorMemberId,
			action: "member_merge",
			targetType: "member",
			targetId: input.memberId,
			detail: {
				fromGuestId: input.guestId,
				guestName: guest.name,
				slotIds,
				// Read back ONLY by `applyUnlinkGuestFromMember`. The activity feed maps
				// a fixed set of keys out of `detail` and never returns it whole
				// (`loadActivity`), so this is not visible to the club's members;
				// `guest-contact-on-person.integration.test.ts` pins that.
				...(ownContact.email || ownContact.phone
					? { guestContact: ownContact }
					: {}),
			},
		});

		return { ok: true as const, slotIds };
	});
}

export interface UnlinkGuestInput {
	clubId: string;
	guestId: string;
	actorMemberId: string | null;
}

/**
 * Reverse `applyLinkGuestToMember` (#635).
 *
 * Restores exactly the slots the link re-pointed, read back from the
 * `member_merge` activity row it wrote. Reading an audit log to reverse an
 * action is unusual; it is done here because the CHECK constraint on
 * `role_slots` means the guest association is not recoverable from the slots
 * themselves, and a dedicated column or table would be a heavier answer to a
 * question the log already stores.
 *
 * Deliberately narrow: it restores the recorded slots and nothing else. A slot
 * the member was assigned to AFTER the link is not the guest's and is left
 * alone, which is why the recorded id list — not "every slot this member holds"
 * — is the thing replayed.
 */
export async function applyUnlinkGuestFromMember(
	input: UnlinkGuestInput,
): Promise<{ ok: true; slotIds: string[] }> {
	return db.transaction(async (tx) => {
		// The lock protocol (ADR-0031): the club write lock, then the Persons (the
		// guest's, and the linked member's), then the guest row. See `applyUndo…`.
		await lockClubForWrite(tx, input.clubId);
		const [peek] = await tx
			.select({
				personId: guests.personId,
				convertedMembershipId: guests.convertedMembershipId,
			})
			.from(guests)
			.where(and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)))
			.limit(1);
		if (!peek) throw new Error("Guest not found in this club.");
		const [peekMember] = peek.convertedMembershipId
			? await tx
					.select({ personId: members.personId })
					.from(members)
					.where(eq(members.id, peek.convertedMembershipId))
					.limit(1)
			: [];
		// NO KEY UPDATE, not `FOR UPDATE`: no Person is deleted here, and a speaker
		// claim holds the slot or the membership and then key-shares the Person.
		await lockPersonsInOrder(
			tx,
			noKeyUpdate(peek.personId, peekMember?.personId),
		);

		const [guest] = await tx
			.select()
			.from(guests)
			.where(and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)))
			.limit(1)
			.for("update");
		if (!guest) throw new Error("Guest not found in this club.");
		if (!guest.convertedMembershipId) {
			throw new Error(UNLINK_NOT_LINKED_MESSAGE);
		}
		if (
			(guest.personId ?? null) !== (peek.personId ?? null) ||
			guest.convertedMembershipId !== peek.convertedMembershipId
		) {
			throw new Error(RECORD_CHANGED_MESSAGE);
		}

		// The most recent link for this guest. Ordered newest-first and tie-broken
		// on id for the same reason `findGuestByContact` is: a bare `limit(1)` over
		// two rows written in the same transaction is a Postgres coin flip.
		const [entry] = await tx
			.select({ detail: activityLog.detail })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, input.clubId),
					eq(activityLog.action, "member_merge"),
					sql`${activityLog.detail}->>'fromGuestId' = ${input.guestId}`,
					// The record must point at the membership the guest currently
					// points at. Without this, a guest that was linked, unlinked, and
					// later CONVERTED for real would replay the stale link — restoring
					// slots to a guest whose real membership stays behind.
					eq(activityLog.targetId, guest.convertedMembershipId),
				),
			)
			.orderBy(desc(activityLog.createdAt), desc(activityLog.id))
			.limit(1);

		// No record means the pointer was set by something other than a link —
		// a real `applyConvertGuestToMember`, which also created a Person and a
		// membership. Undoing THAT is #618 and is not this function's job, so
		// refuse rather than half-reverse it.
		const recorded = (entry?.detail as { slotIds?: unknown } | null)?.slotIds;
		const slotIds = Array.isArray(recorded)
			? recorded.filter((s): s is string => typeof s === "string")
			: [];
		if (!entry) throw new Error(UNLINK_NOT_LINKED_MESSAGE);

		// Empty is legitimate: a guest who held no slots when linked. Guard anyway,
		// because drizzle compiles `inArray(col, [])` to `false` and the UPDATE
		// would be a silent no-op that reads identical to success.
		if (slotIds.length > 0) {
			await tx
				.update(roleSlots)
				.set({ assignedMemberId: null, assignedGuestId: input.guestId })
				.where(inArray(roleSlots.id, slotIds));
		}

		await tx
			.update(guests)
			.set({
				stage: "following_up",
				convertedMembershipId: null,
				updatedAt: new Date(),
			})
			.where(eq(guests.id, input.guestId));
		// The member is still a member, so a guest still naming their Person is
		// pointed at a fresh name-only one. The pristine rule alone is not enough
		// here: the member's roster rows can be merged afterwards, and a collapse
		// deletes the absorbed membership and its records, which would leave the
		// Person looking untouched (`separateGuestFromMemberPerson`).
		// The contact the guest had BEFORE the link, recorded by it, goes back onto
		// the Person minted here (#1125).
		const recordedContact = (
			entry.detail as { guestContact?: { email?: unknown; phone?: unknown } }
		).guestContact;
		await clearRecordedGuestContact(tx, input.clubId, input.guestId);
		await separateGuestFromMemberPerson(tx, input.guestId, {
			email:
				typeof recordedContact?.email === "string"
					? recordedContact.email
					: null,
			phone:
				typeof recordedContact?.phone === "string"
					? recordedContact.phone
					: null,
		});

		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: input.actorMemberId,
			action: "member_merge",
			targetType: "member",
			targetId: guest.convertedMembershipId,
			detail: {
				unlinkedGuestId: input.guestId,
				guestName: guest.name,
				slotIds,
			},
		});

		return { ok: true as const, slotIds };
	});
}

export interface UndoConversionInput {
	clubId: string;
	guestId: string;
	actorMemberId: string | null;
}

export interface UndoConversionResult {
	ok: true;
	/** Slots returned to the guest — exactly the set the conversion moved. */
	slotIds: string[];
	/** False when convert REUSED a membership; that row is left standing. */
	membershipDeleted: boolean;
}

/** The replayable half of a conversion's activity record (#618). */
type ConversionRecord = {
	personId: string;
	slotIds: string[];
	createdMembership: boolean;
	createdPerson: boolean;
	/**
	 * The membership's status before convert reactivated it (#501).
	 * `membership_status` is only (active, inactive), so `inactive` is the sole
	 * reachable value — do NOT widen this to a status the enum cannot hold.
	 * Absent on a fresh membership, on reuse of an already-active one, and on
	 * every record written before #501 shipped.
	 */
	reactivatedFrom?: "inactive";
	/**
	 * The `club_role` the wake-up wrote back down to `member` (#501 review).
	 * `club_role` is only (admin, member) and `member` is the floor written to,
	 * so `admin` is the sole reachable value. Absent whenever `reactivatedFrom`
	 * is — the demotion only ever rides the wake-up — and also on a wake-up of a
	 * row that was an ordinary member already.
	 */
	demotedFrom?: "admin";
};

/**
 * A conversion's activity detail, or `null` when it cannot be replayed.
 *
 * Every field is checked for its TYPE rather than its truthiness, because the
 * dangerous shape here is the older record that carries `personId` and nothing
 * else: read loosely, `createdMembership` would default to `false` and the undo
 * would silently leave a membership standing that it was supposed to remove, or
 * — with the default the other way — delete a roster row this conversion never
 * created. An absent `slotIds` is likewise not an empty one. A guest who held no
 * slots is a real and ordinary case, so emptiness cannot mean "no record"; only
 * the key being missing can.
 *
 * `reactivatedFrom` and `demotedFrom` are the two fields that may be ABSENT,
 * and that optionality is deliberate (#501). This function is also what
 * `loadGuestPipeline` reads to decide whether the board OFFERS Undo at all, so
 * requiring either key would have silently taken the Undo button off every
 * conversion recorded before #501 shipped. Absent means "convert changed
 * nothing there", which is true of all of them.
 *
 * ABSENT and MALFORMED are not the same claim, and the first draft of #501
 * conflated them (`d.reactivatedFrom === "inactive" ? … : undefined`). A
 * record that SAYS it reactivated but says it in a value the enum cannot hold
 * is corrupt, and reading it as "reactivated nothing" downgrades a corrupt
 * claim into a confident one: the undo would run, report success, and leave a
 * membership permanently `active` that the record was trying to tell us had
 * lapsed. The same shape, one field over, would leave an admin's permissions
 * on. So a PRESENT key must parse or the whole record is refused — the admin
 * gets `UNDO_NO_RECORD_MESSAGE` and the roster-removal fallback, which is the
 * honest outcome for a record nobody can replay. Absence keeps meaning
 * absence, which is what keeps pre-#501 records undoable.
 */
function readConversionRecord(detail: unknown): ConversionRecord | null {
	if (!detail || typeof detail !== "object") return null;
	const d = detail as Record<string, unknown>;
	if (typeof d.personId !== "string") return null;
	if (!Array.isArray(d.slotIds)) return null;
	if (typeof d.createdMembership !== "boolean") return null;
	if (typeof d.createdPerson !== "boolean") return null;
	// Parse first, then reject PRESENT-BUT-UNPARSED. Splitting it this way is
	// what keeps "absent" and "malformed" from collapsing into each other: the
	// ternary is the parse, and the line under it is the only thing that can
	// tell an omitted key from a value the enum cannot hold.
	const reactivatedFrom =
		d.reactivatedFrom === "inactive" ? ("inactive" as const) : undefined;
	if (d.reactivatedFrom !== undefined && reactivatedFrom === undefined) {
		return null;
	}
	const demotedFrom =
		d.demotedFrom === "admin" ? ("admin" as const) : undefined;
	if (d.demotedFrom !== undefined && demotedFrom === undefined) return null;
	return {
		personId: d.personId,
		slotIds: d.slotIds.filter((s): s is string => typeof s === "string"),
		createdMembership: d.createdMembership,
		createdPerson: d.createdPerson,
		reactivatedFrom,
		demotedFrom,
	};
}

/**
 * Undo a convert-to-member (#618): the reverse of `applyConvertGuestToMember`.
 *
 * Convert is otherwise a one-way door. Its button is the only filled control on
 * every non-joined card, immediately beside the outline stage buttons, with a
 * `window.confirm` as the sole guard — so one mis-tap on a phone during a
 * meeting stamped a `members` row plus a `people` row and there was no way back
 * without database access.
 *
 * ## Why it replays a RECORD instead of re-deriving
 *
 * The same reason `applyUnlinkGuestFromMember` does, and the stakes are higher
 * here because this one can delete a roster row. Two things are unknowable after
 * the fact:
 *
 *   - WHICH slots the conversion moved. By now they sit on the membership beside
 *     any the member has been assigned since, and handing those to a guest would
 *     invent history rather than reverse it.
 *   - WHETHER the conversion created the membership and the Person, or deduped
 *     onto rows that already existed. Deleting a membership convert merely
 *     REUSED destroys roster data the conversion never owned.
 *   - WHETHER the conversion WOKE that reused membership out of a lapse (#501).
 *     A REUSED row is deliberately left standing, so without this the member
 *     would stay permanently `active` after a convert-then-undo and undo would
 *     stop being convert's reverse. Restored only when `reactivatedFrom` is
 *     present, which is why that key is optional: every record written before
 *     #501 correctly says "reactivated nothing".
 *   - WHETHER that wake-up wrote an elevated `club_role` back down to `member`.
 *     Same argument one column over: the row survives the undo, so a demotion
 *     nothing put back would make convert-then-undo a silent permission change.
 *     It grants nothing on the way back — the same statement returns the row to
 *     `inactive`, which `requireMembership` refuses whatever the role says.
 *
 * So convert records all four, and a conversion older than that record is refused
 * (`UNDO_NO_RECORD_MESSAGE`) rather than half-reversed. That refusal is not a
 * dead end: removing the member from the roster still works, and #632 made the
 * guest card recover its controls when it does.
 *
 * ## What refuses it
 *
 * The membership must be untouched since. A signed-in account (`people.user_id`,
 * the same gate `applyMemberRemove` uses), dues rows, and any role slot the
 * member holds BEYOND the ones the conversion moved all block it — each is
 * something a delete would destroy, and the merge tool is the right instrument
 * once any is true.
 *
 * Speeches and Pathways enrolments are checked ONLY when the conversion created
 * the membership. They hang off `people`, not `members`, so removing a membership
 * never destroys them — but on a Person that had no membership here they can
 * only have been earned afterwards, which makes them evidence the human really
 * did start participating as a member. When convert deduped onto a membership
 * that already existed, the same rows are somebody's pre-existing history and say
 * nothing about this conversion.
 *
 * Since #1124 the check is keyed on `createdMembership`, not `createdPerson`:
 * a convert that adopts the guest's own Person records `createdPerson: false`,
 * which would switch the check off for it. A Person convert adopts is pristine
 * (`pristineGuestPerson`: nothing on or around it shows a past), so whatever it
 * owns afterwards was earned afterwards; a Person convert mints is new for the same reason. Where
 * convert reused a membership of this club the check does not run, as before.
 *
 * The guest's Person is deliberately LEFT BEHIND when the membership goes, as a
 * created one always was. It is global (ADR-0008), the guest row still points at
 * it, deleting it could cascade further than this undo's remit, and the Person
 * is the guest's, not the conversion's. The guest keeps naming it too: after an
 * undo of a convert that created the membership a re-convert will not adopt it
 * (the undo's removal record makes it not pristine) and gives the guest a fresh
 * Person, and a later re-convert deletes it only if no removal names it.
 *
 * Whenever the membership is deleted, created Person or not, the
 * `member_remove` names its Person in `detail.personId`, the release record
 * `applyMemberRemove` also writes and the CSV importer reads (#855). Without it
 * the Person is held by no club and named by no removal, so a roster CSV
 * carrying the Person's email skips the row on every import, in this club too
 * (#875). The undo leaves the Person's contact exactly as convert set it, so
 * that CSV row still matches the Person; clearing it would make the import
 * create a second Person for the same human. An undo that keeps a reused
 * membership releases nothing and names nobody.
 */
export async function applyUndoGuestConversion(
	input: UndoConversionInput,
): Promise<UndoConversionResult> {
	return db.transaction(async (tx) => {
		// The lock protocol (ADR-0031): the club write lock, then the Persons, then
		// the guest row, then (this path's own order, unchanged) the membership.
		// Two Persons can be involved: the guest's, and the one the membership
		// CURRENTLY names, which is not the Person in the activity record after a
		// merge has deleted that one (L1 of #1155). Both are read without a lock,
		// locked in id order, and read again under the locks; either moving
		// refuses the undo with nothing written.
		await lockClubForWrite(tx, input.clubId);
		const [peek] = await tx
			.select({
				personId: guests.personId,
				convertedMembershipId: guests.convertedMembershipId,
			})
			.from(guests)
			.where(and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)))
			.limit(1);
		if (!peek) throw new Error("Guest not found in this club.");
		const [peekMember] = peek.convertedMembershipId
			? await tx
					.select({ personId: members.personId })
					.from(members)
					.where(eq(members.id, peek.convertedMembershipId))
					.limit(1)
			: [];
		// NO KEY UPDATE, not `FOR UPDATE`: no Person is deleted here, and a speaker
		// claim holds the slot or the membership and then key-shares the Person.
		await lockPersonsInOrder(
			tx,
			noKeyUpdate(peek.personId, peekMember?.personId),
		);

		const [guest] = await tx
			.select()
			.from(guests)
			.where(and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)))
			.limit(1)
			.for("update");
		if (!guest) throw new Error("Guest not found in this club.");
		// A STRANDED guest lands here too, and refusing is right: its membership
		// is already gone, so there is nothing to unwind, and #632 gave that row
		// its ordinary stage and delete controls back.
		if (!guest.convertedMembershipId) {
			throw new Error(UNDO_NOT_CONVERTED_MESSAGE);
		}
		const membershipId = guest.convertedMembershipId;
		if (
			(guest.personId ?? null) !== (peek.personId ?? null) ||
			membershipId !== peek.convertedMembershipId
		) {
			throw new Error(RECORD_CHANGED_MESSAGE);
		}

		// Newest first and tie-broken on id, for the reason `findGuestByContact`
		// documents. Scoped to the membership the guest currently points at, so a
		// guest converted, undone, and converted again cannot replay the older run.
		const [entry] = await tx
			.select({ detail: activityLog.detail })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, input.clubId),
					eq(activityLog.action, "member_add"),
					sql`${activityLog.detail}->>'fromGuestId' = ${input.guestId}`,
					eq(activityLog.targetId, membershipId),
				),
			)
			.orderBy(desc(activityLog.createdAt), desc(activityLog.id))
			.limit(1);
		const record = readConversionRecord(entry?.detail ?? null);
		if (!record) throw new Error(UNDO_NO_RECORD_MESSAGE);

		// Lock the MEMBERSHIP too, not just the guest. Every guard below reads
		// something hanging off this row, and a concurrent write would otherwise
		// commit between the read and the delete — a role claimed for this member
		// mid-undo would pass the "no extra roles" check and then be silently
		// unassigned by the FK's `set null` on the way out. A slot insert takes a
		// key-share lock on the member row it references, so taking it FOR UPDATE
		// here is what actually serialises the two. Same reasoning as convert's
		// lock on the guest row: read outside the lock, a check is a stale
		// snapshot.
		const [membership] = await tx
			.select({ id: members.id, personId: members.personId })
			.from(members)
			.where(eq(members.id, membershipId))
			.limit(1)
			.for("update");
		if (!membership || membership.personId !== peekMember?.personId) {
			throw new Error(RECORD_CHANGED_MESSAGE);
		}
		// The Person the membership names NOW. The record's `personId` is who it
		// named when convert ran, and a merge since may have deleted that Person: an
		// account check read off a deleted row finds no account and lets the undo
		// delete the membership of somebody who has signed in.
		const memberPersonId = membership.personId;

		const [person] = await tx
			.select({ userId: people.userId })
			.from(people)
			.where(eq(people.id, memberPersonId))
			.limit(1);
		if (person?.userId) throw new Error(UNDO_MEMBER_HAS_ACCOUNT_MESSAGE);

		// Slots the member holds that this conversion did NOT move. `notInArray`
		// is avoided: drizzle compiles an empty list to a constant, and the two
		// constants differ by operator, so an empty `slotIds` would silently
		// invert this check rather than widen it.
		const held = await tx
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(
				and(
					eq(roleSlots.assignedMemberId, membershipId),
					eq(meetings.clubId, input.clubId),
				),
			);
		const moved = new Set(record.slotIds);
		if (held.some((s) => !moved.has(s.id))) {
			throw new Error(UNDO_MEMBER_HAS_HISTORY_MESSAGE("roles"));
		}

		const [dues] = await tx
			.select({ n: count() })
			.from(memberDues)
			.where(eq(memberDues.membershipId, membershipId));
		if (Number(dues?.n ?? 0) > 0) {
			throw new Error(UNDO_MEMBER_HAS_HISTORY_MESSAGE("dues records"));
		}

		// ANY term, open or CLOSED — and the closed half is load-bearing since
		// #805. Convert's wake-up ends the open terms a lapsed membership was
		// carrying, and `officer_terms` rows are closed rather than deleted
		// (#100), so a membership convert wrote to that way still carries a row
		// here. That is what makes the close safe to write with nothing to
		// reverse it: every conversion it touches was already refused by this
		// check before the close existed, and still is, so an undo can never
		// half-reverse one. Narrowing this to OPEN terms would quietly break that
		// — `guest-convert-privilege.integration.test.ts` fails you first.
		const [terms] = await tx
			.select({ n: count() })
			.from(officerTerms)
			.where(eq(officerTerms.membershipId, membershipId));
		if (Number(terms?.n ?? 0) > 0) {
			throw new Error(UNDO_MEMBER_HAS_HISTORY_MESSAGE("an officer term"));
		}

		if (record.createdMembership) {
			const [spoken] = await tx
				.select({ n: count() })
				.from(speeches)
				.where(eq(speeches.personId, memberPersonId));
			if (Number(spoken?.n ?? 0) > 0) {
				throw new Error(UNDO_MEMBER_HAS_HISTORY_MESSAGE("speeches"));
			}
			const [enrolled] = await tx
				.select({ n: count() })
				.from(pathEnrollments)
				.where(eq(pathEnrollments.personId, memberPersonId));
			if (Number(enrolled?.n ?? 0) > 0) {
				throw new Error(
					UNDO_MEMBER_HAS_HISTORY_MESSAGE("a Pathways enrolment"),
				);
			}
		}

		// Empty is legitimate — a guest who held no slots when converted — and the
		// guard is still required, because drizzle compiles `inArray(col, [])` to
		// `false` and the UPDATE would be a no-op that reads exactly like success.
		if (record.slotIds.length > 0) {
			await tx
				.update(roleSlots)
				.set({ assignedMemberId: null, assignedGuestId: input.guestId })
				// Still held by THIS membership. A recorded slot that has since been
				// reassigned to somebody else belongs to them now, and handing it to
				// the guest would take a role off a third party who has no part in
				// this undo. The guard above only proves the member holds nothing
				// EXTRA; it says nothing about a recorded slot having moved away.
				.where(
					and(
						inArray(roleSlots.id, record.slotIds),
						eq(roleSlots.assignedMemberId, membershipId),
					),
				);
		}

		// Ordered after the slot move on purpose: `role_slots.assigned_member_id`
		// would otherwise be cleared by the membership's own cascade, and the
		// slots would return to OPEN instead of to the guest.
		if (record.createdMembership) {
			await tx.delete(members).where(eq(members.id, membershipId));
		} else if (record.reactivatedFrom || record.demotedFrom) {
			// Convert woke a lapsed membership (#501), so undo has to put the lapse
			// back or it stops being convert's reverse: the row is REUSED, not
			// created, so the delete above correctly leaves it standing — and
			// without this the member would be permanently `active` after a
			// convert-then-undo, which is precisely the state the admin used undo to
			// get out of.
			//
			// The `club_role` the wake-up wrote down is restored in the SAME
			// statement, for the same reason and with no privilege consequence: the
			// row is going back to `inactive` in this very `set`, and a non-active
			// membership is refused by `requireMembership` whatever its role says.
			// Restoring only the status would quietly make undo a demotion tool —
			// convert-then-undo would leave a former admin's row saying `member`
			// with nothing anywhere recording that convert is what changed it.
			//
			// An `else if` rather than a second `if`, because these are mutually
			// exclusive with `createdMembership` by construction: both keys are
			// only ever written on the REUSE branch, where `createdMembership` is
			// false. Stating that as structure keeps a malformed record from
			// writing to a row this transaction has already deleted.
			await tx
				.update(members)
				.set({
					...(record.reactivatedFrom ? { status: record.reactivatedFrom } : {}),
					...(record.demotedFrom ? { clubRole: record.demotedFrom } : {}),
				})
				.where(eq(members.id, membershipId));
		}

		await tx
			.update(guests)
			.set({
				stage: "following_up",
				convertedMembershipId: null,
				updatedAt: new Date(),
			})
			.where(eq(guests.id, input.guestId));

		// Undo does not touch the Person's contact, nor which Person the guest names.
		// Leaving the contact makes the undoing club's own roster CSV still find the
		// Person the convert minted (#875), instead of creating a second one for the
		// same human. After an undo of a convert that created the membership the Person
		// has a removal on record (and usually contact), so it is not pristine and the
		// next convert gives the guest a fresh Person. After an undo of a dedupe-hit
		// convert the guest's own Person was never touched by it, so it is pristine
		// only if it was before the convert (`pristineGuestPerson`).

		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: input.actorMemberId,
			action: "member_remove",
			targetType: "member",
			targetId: membershipId,
			// `membershipDeleted: false` used to be the whole story for a REUSED
			// row, and it left the log unable to explain the thing a human
			// actually sees: the member vanishes from the roster, the sign-up
			// sheet and every picker, and nothing anywhere says why. That is the
			// mirror of the bug #501 exists to fix — a status write with no
			// visible record — only pointing the other way, and it is worse here
			// because this write is the one that TAKES a member away.
			//
			// Recorded on this row rather than as a separate `member_edit`: one
			// action, one entry, and `applySetMemberStatus`'s `member_edit` would
			// claim an independent roster decision that nobody made. Each key is
			// present only when undo actually wrote that column, so absence keeps
			// meaning "this undo left it alone" — same discipline as the
			// conversion record these are replayed from.
			detail: {
				name: guest.name,
				undoneGuestId: input.guestId,
				slotIds: record.slotIds,
				membershipDeleted: record.createdMembership,
				...(record.createdMembership ? { personId: memberPersonId } : {}),
				...(record.createdMembership
					? {}
					: {
							...(record.reactivatedFrom
								? { statusRestoredTo: record.reactivatedFrom }
								: {}),
							...(record.demotedFrom
								? { clubRoleRestoredTo: record.demotedFrom }
								: {}),
						}),
			},
		});

		return {
			ok: true as const,
			slotIds: record.slotIds,
			membershipDeleted: record.createdMembership,
		};
	});
}

export interface LinkCandidate {
	id: string;
	name: string;
	/** Name agrees with the guest's — floated to the top of the dialog. */
	suggested: boolean;
	/**
	 * This member already holds a role at a meeting where the GUEST holds one,
	 * so linking would leave one human with two roles at that meeting.
	 */
	sharesMeeting: boolean;
}

/**
 * Every roster member in the club, annotated for the link dialog (#635).
 *
 * Returns the WHOLE roster rather than only name matches, because the dialog
 * needs the same two annotations for a member found by free search as for a
 * suggested one. Two endpoints would have meant the same-meeting warning silently
 * not appearing for anyone the admin searched for by hand — a warning that is
 * missing exactly when it is least expected is worse than none.
 *
 * `suggested` uses `namesAgree` rather than an exact compare, so "Bill Nakamura"
 * suggests for "William Nakamura". It is the same helper the Person dedup and
 * #617's clash check use, so what is suggested here and what refuses a convert
 * there cannot drift apart.
 */
export async function loadLinkCandidates(input: {
	clubId: string;
	guestId: string;
}): Promise<LinkCandidate[]> {
	const [guest] = await db
		.select({ name: guests.name })
		.from(guests)
		.where(and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)))
		.limit(1);
	if (!guest) return [];

	const roster = await db
		.select({ id: members.id, name: members.name })
		.from(members)
		.where(eq(members.clubId, input.clubId))
		.orderBy(asc(members.name));

	// Meetings where this guest holds a role. Empty is the common case for a
	// guest who has only ever visited, and short-circuits the collision query.
	const guestMeetings = await db
		.selectDistinct({ meetingId: roleSlots.meetingId })
		.from(roleSlots)
		.where(eq(roleSlots.assignedGuestId, input.guestId));
	const meetingIds = guestMeetings.map((m) => m.meetingId);

	// Guard the empty list explicitly: drizzle compiles `inArray(col, [])` to
	// `false`, so the query would return nothing and every candidate would read
	// `sharesMeeting: false` — the right answer by accident, via a query that
	// cannot fail. Skipping the round trip makes that the answer on purpose.
	const collidingMemberIds = new Set<string>();
	if (meetingIds.length > 0) {
		const rows = await db
			.selectDistinct({ memberId: roleSlots.assignedMemberId })
			.from(roleSlots)
			.where(
				and(
					inArray(roleSlots.meetingId, meetingIds),
					isNotNull(roleSlots.assignedMemberId),
				),
			);
		for (const r of rows) if (r.memberId) collidingMemberIds.add(r.memberId);
	}

	return roster.map((m) => ({
		id: m.id,
		name: m.name,
		suggested: namesAgree(m.name, guest.name),
		sharesMeeting: collidingMemberIds.has(m.id),
	}));
}

// ---------------------------------------------------------------------------
// Across clubs (#1127, ADR-0031): add, link, separate
// ---------------------------------------------------------------------------
//
// One human who visited two clubs is two Persons until an officer of BOTH says
// otherwise. Three actions, each gated on `requireClubRole(…, ["admin"])` for
// every club it names (which since #202 also passes an elected officer with an
// open term), except Separate, whose gate is this club alone (the undo of a
// wrong link must not need the other club).
//
// CLUBS STAY BLIND. Nothing below reads or returns another club's stage,
// visits, invites, notes or history counts. The only facts that cross are the
// ones the contract names: that a Person is held elsewhere (a boolean), the
// viewer's OWN other admin clubs, and the name, email and phone of a record in a
// club the viewer is admin of.
//
// LOCKS (ADR-0031, the read-then-lock rule). Every club holding a guest row or a
// membership on any Person involved is read WITHOUT a lock, locked in id order,
// then the Persons (`FOR UPDATE` where one is absorbed, else `FOR NO KEY UPDATE`)
// in id order, then the guest rows; then everything is read again, and a set that
// moved is refused with `RECORD_CHANGED_MESSAGE` and nothing written. "No other
// unconverted guest row on this Person in this club" is checked after the locks,
// in the transaction; the club lock is what makes it hold, in place of a unique
// index.

export const GUEST_NOW_MEMBER_MESSAGE = "This guest is now a member.";
export const GUEST_ADD_ALREADY_THERE_MESSAGE =
	"They're already a guest or a member there.";
export const GUEST_LINK_ALREADY_HERE_MESSAGE =
	"That person is already a guest or a member of this club.";
export const GUEST_SEPARATE_FIRST_MESSAGE =
	"Separate it from the other club first.";
export const GUEST_ALREADY_SEPARATE_MESSAGE = "Already separate.";
export const GUEST_LINK_STALE_MESSAGE =
	"These records changed. Review the link again.";
export const GUEST_LINK_SAME_PERSON_MESSAGE =
	"These are already the same person.";
export const GUEST_LINK_HAS_MEMBERSHIP_MESSAGE =
	"This person is a member of a club. A superadmin has to merge them.";
export const GUEST_LINK_SIGNED_IN_MESSAGE =
	"This person has signed in. A superadmin has to merge them.";
export const GUEST_LINK_HAS_HISTORY_MESSAGE =
	"This person has a history of their own (a past membership, speeches or Pathways progress). A superadmin has to merge them.";
export const GUEST_LINK_NOT_FOUND_MESSAGE =
	"That record is not in the other club.";
export const GUEST_CROSS_CLUB_SAME_CLUB_MESSAGE = "Pick a different club.";

/** The most candidates the picker returns. */
export const GUEST_LINK_CANDIDATE_LIMIT = 20;

type CrossClubTx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * Admin (or elected officer) of BOTH clubs, asked of the real gate twice, in one
 * order. Returns both memberships (`id` is null for an impersonating superadmin,
 * who holds none): the actor an audit row names, and the officer to credit with
 * adding a guest. A single-club admin naming a second club is refused here, before anything is read.
 */
async function requireAdminOfBothClubs(
	userId: string,
	clubId: string,
	otherClubId: string,
) {
	if (clubId === otherClubId)
		throw new Error(GUEST_CROSS_CLUB_SAME_CLUB_MESSAGE);
	const membership = await requireClubRole(userId, clubId, ["admin"]);
	const otherMembership = await requireClubRole(userId, otherClubId, ["admin"]);
	return { membership, otherMembership };
}

/** The same two checks, re-asked inside the transaction once the locks are held
 *  (#806): a seat revoked while this waited for a club lock must not still write. */
async function assertStillAdminOfBothClubs(
	tx: CrossClubTx,
	userId: string,
	clubId: string,
	otherClubId: string,
) {
	await assertStillClubAdmin(tx, userId, clubId);
	await assertStillClubAdmin(tx, userId, otherClubId);
}

/**
 * The clubs to lock for these Persons: every club holding a guest row or a
 * membership on any of them (`clubsHoldingPersons`), plus the clubs the action
 * names (a target club may hold neither yet), sorted.
 */
async function clubsToLock(
	tx: CrossClubTx,
	personIds: string[],
	named: string[],
): Promise<string[]> {
	const held = await clubsHoldingPersons(tx, personIds);
	return [...new Set([...held, ...named])].sort();
}

/**
 * Take the club locks, then re-read the set under them. A set that moved
 * (somebody attached or detached one of these Persons from a club that was not
 * locked) is refused with `RECORD_CHANGED_MESSAGE`, nothing written.
 */
async function lockClubsStable(
	tx: CrossClubTx,
	before: string[],
	personIds: string[],
	named: string[],
): Promise<void> {
	for (const id of before) await lockClubForWrite(tx, id);
	if (!sameIds(before, await clubsToLock(tx, personIds, named))) {
		throw new Error(RECORD_CHANGED_MESSAGE);
	}
}

function sameIds(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** A guest in `clubId`, as these actions read it. */
async function readGuestOf(
	conn: DbOrTx,
	clubId: string,
	guestId: string,
	lock = false,
) {
	const query = conn
		.select({
			id: guests.id,
			clubId: guests.clubId,
			name: guests.name,
			preferredName: guests.preferredName,
			stage: guests.stage,
			personId: guests.personId,
		})
		.from(guests)
		.where(and(eq(guests.id, guestId), eq(guests.clubId, clubId)))
		.limit(1);
	const [row] = lock ? await query.for("update") : await query;
	return row ?? null;
}

/**
 * **The one rule for "this Person is already HERE"**, as SQL: `personId` has, in
 * `clubId`, a guest row that is not converted, or an ACTIVE membership. A lapsed
 * membership does not count: it is history, and the person may be a guest again.
 * Add's and Link's refusal (`personIsHereAlready`) and the board's `addableTo`
 * (`loadGuestPipeline`) both read it, so what the menu offers and what the server
 * accepts cannot drift apart. Raw SQL with its own aliases, so it composes into a
 * select, a join or a `values` probe alike without a drizzle subquery dropping a
 * qualifier.
 */
function personHereSql(personId: SQL, clubId: SQL): SQL {
	return sql`(
		exists (select 1 from guests gh where gh.person_id = ${personId} and gh.club_id = ${clubId} and gh.stage <> 'joined')
		or exists (select 1 from members mh where mh.person_id = ${personId} and mh.club_id = ${clubId} and mh.status = 'active')
	)`;
}

/**
 * **The one rule for "another club holds this Person"**, as SQL: a club other than
 * `clubId` has a guest row (any stage) or a membership (any status) on `personId`.
 * Separate's "Already separate" refusal and the board's `sharedWithOtherClub` read
 * it. A boolean about the Person and nothing about that club.
 */
function personHeldElsewhereSql(personId: SQL, clubId: SQL): SQL {
	return sql`(
		exists (select 1 from guests ge where ge.person_id = ${personId} and ge.club_id <> ${clubId})
		or exists (select 1 from members me where me.person_id = ${personId} and me.club_id <> ${clubId})
	)`;
}

async function personIsHereAlready(
	conn: DbOrTx,
	personId: string,
	clubId: string,
): Promise<boolean> {
	const res = await conn.execute<{ here: boolean }>(
		sql`select ${personHereSql(sql`${personId}::uuid`, sql`${clubId}::uuid`)} as here`,
	);
	return Boolean(res.rows[0]?.here);
}

async function personIsHeldElsewhere(
	conn: DbOrTx,
	personId: string,
	clubId: string,
): Promise<boolean> {
	const res = await conn.execute<{ held: boolean }>(
		sql`select ${personHeldElsewhereSql(sql`${personId}::uuid`, sql`${clubId}::uuid`)} as held`,
	);
	return Boolean(res.rows[0]?.held);
}

/**
 * After the Persons are locked, the clubs that hold them are read ONCE MORE. A
 * guest row or a membership naming a Person needs a key share on it, which the
 * lock now refuses, so this read is the authoritative one; the set read before
 * the locks (`lockClubsStable`) was only the one to lock by. A club that appeared
 * in between is a club this transaction holds no lock on, so nothing is written:
 * the writer retries, as for any busy club.
 */
async function assertClubSetHeld(
	tx: CrossClubTx,
	locked: string[],
	personIds: string[],
	named: string[],
): Promise<void> {
	if (!sameIds(locked, await clubsToLock(tx, personIds, named))) {
		throw new Error(CLUB_BUSY_MESSAGE);
	}
}

export interface AddGuestToClubInput {
	userId: string;
	fromClubId: string;
	guestId: string;
	toClubId: string;
}

/**
 * Add this club's guest to another club the officer also runs: the other club
 * gets a `prospect` visitor row on the SAME Person, with the name and goes-by name
 * copied, and no attendance. This club's row is untouched.
 *
 * Refused for a converted guest, for a Person that already has an unconverted
 * guest row or an active membership in the other club, and for anybody who is
 * not an admin of both clubs. Two sessions adding the same Person to the same
 * club both hold that club's write lock in turn, so the second sees the first's
 * row and is refused: exactly one row.
 */
export async function applyAddGuestToClub(
	input: AddGuestToClubInput,
): Promise<{ ok: true }> {
	const { userId, fromClubId, guestId, toClubId } = input;
	const { otherMembership: destination } = await requireAdminOfBothClubs(
		userId,
		fromClubId,
		toClubId,
	);
	return db.transaction(async (tx) => {
		const peek = await readGuestOf(tx, fromClubId, guestId);
		if (!peek) throw new Error(GUEST_NOT_IN_CLUB_MESSAGE);
		const named = [fromClubId, toClubId];
		const before = await clubsToLock(tx, [peek.personId], named);
		await lockClubsStable(tx, before, [peek.personId], named);
		await lockPersonsInOrder(tx, noKeyUpdate(peek.personId));
		await assertClubSetHeld(tx, before, [peek.personId], named);
		const guest = await readGuestOf(tx, fromClubId, guestId, true);
		if (!guest || guest.personId !== peek.personId) {
			throw new Error(RECORD_CHANGED_MESSAGE);
		}
		await assertStillAdminOfBothClubs(tx, userId, fromClubId, toClubId);

		if (guest.stage === "joined") throw new Error(GUEST_NOW_MEMBER_MESSAGE);
		if (await personIsHereAlready(tx, guest.personId, toClubId)) {
			throw new Error(GUEST_ADD_ALREADY_THERE_MESSAGE);
		}
		await createGuestRecord(tx, {
			clubId: toClubId,
			personId: guest.personId,
			name: guest.name,
			preferredName: guest.preferredName,
			stage: "prospect",
			kind: "visitor",
			// The officer who added them, so the destination club's officers can see
			// who did (null for an impersonating superadmin, who holds no seat).
			introducedByMemberId: destination.id,
		});
		return { ok: true as const };
	});
}

export type GuestLinkOtherKind = "guest" | "member";

export interface GuestLinkInput {
	userId: string;
	clubId: string;
	guestId: string;
	otherClubId: string;
	otherId: string;
	otherKind: GuestLinkOtherKind;
}

export type { GuestLinkPreview };

interface LinkSides {
	guest: NonNullable<Awaited<ReturnType<typeof readGuestOf>>>;
	other: {
		kind: GuestLinkOtherKind;
		id: string;
		personId: string;
		/** Set for a guest, unset for a member. */
		stage: GuestStage | null;
	};
}

/** Both records, in their own clubs. A missing one is "not in that club". */
async function readLinkSides(
	conn: DbOrTx,
	input: Omit<GuestLinkInput, "userId">,
	lock = false,
): Promise<LinkSides> {
	const guest = await readGuestOf(conn, input.clubId, input.guestId);
	if (!guest) throw new Error(GUEST_NOT_IN_CLUB_MESSAGE);
	if (input.otherKind === "guest") {
		const other = await readGuestOf(conn, input.otherClubId, input.otherId);
		if (!other) throw new Error(GUEST_LINK_NOT_FOUND_MESSAGE);
		if (lock) {
			// Both guest rows, in id order, as the protocol's third step.
			await conn
				.select({ id: guests.id })
				.from(guests)
				.where(inArray(guests.id, [guest.id, other.id]))
				.orderBy(guests.id)
				.for("update");
		}
		return {
			guest,
			other: {
				kind: "guest",
				id: other.id,
				personId: other.personId,
				stage: other.stage,
			},
		};
	}
	const [member] = await conn
		.select({ id: members.id, personId: members.personId })
		.from(members)
		.where(
			and(
				eq(members.id, input.otherId),
				eq(members.clubId, input.otherClubId),
				eq(members.status, "active"),
			),
		)
		.limit(1);
	if (!member) throw new Error(GUEST_LINK_NOT_FOUND_MESSAGE);
	if (lock) {
		await conn
			.select({ id: guests.id })
			.from(guests)
			.where(eq(guests.id, guest.id))
			.for("update");
	}
	return {
		guest,
		other: {
			kind: "member",
			id: member.id,
			personId: member.personId,
			stage: null,
		},
	};
}

/**
 * Why this link may not be made, or nothing. The same checks run for the preview
 * (so the confirm step never opens on a link that will refuse) and, under the
 * locks, for the link itself. In this order, the first that applies:
 *
 * - either record is a converted guest (never the source of a link);
 * - both already share a Person;
 * - this guest's Person holds ANY membership, or is bound to a sign-in: those
 *   are the superadmin's `mergePeople`;
 * - this guest's Person has a guest row in any club but this one;
 * - the other Person already has an unconverted guest row or an active
 *   membership in THIS club (the link would leave two records of one human here).
 */
async function linkRefusal(
	conn: DbOrTx,
	clubId: string,
	sides: LinkSides,
): Promise<string | null> {
	if (sides.guest.stage === "joined" || sides.other.stage === "joined") {
		return GUEST_NOW_MEMBER_MESSAGE;
	}
	if (sides.guest.personId === sides.other.personId) {
		return GUEST_LINK_SAME_PERSON_MESSAGE;
	}
	const [held] = await conn
		.select({ id: members.id })
		.from(members)
		.where(eq(members.personId, sides.guest.personId))
		.limit(1);
	if (held) return GUEST_LINK_HAS_MEMBERSHIP_MESSAGE;
	const [absorbed] = await conn
		.select({ userId: people.userId })
		.from(people)
		.where(eq(people.id, sides.guest.personId))
		.limit(1);
	if (!absorbed) return GUEST_LINK_NOT_FOUND_MESSAGE;
	if (absorbed.userId) return GUEST_LINK_SIGNED_IN_MESSAGE;
	const [elsewhere] = await conn
		.select({ id: guests.id })
		.from(guests)
		.where(
			and(eq(guests.personId, sides.guest.personId), ne(guests.clubId, clubId)),
		)
		.limit(1);
	if (elsewhere) return GUEST_SEPARATE_FIRST_MESSAGE;
	// The merge moves the absorbed Person's speeches and enrolments onto the keeper
	// (deleting the keeper's own enrolment on a path both hold), adopts its Customer
	// ID, Base Camp ID and join date, and nulls a charter-helper row naming it, which
	// can be in a club this officer does not run; Separate gives none of that back.
	// So only a PRISTINE guest Person is absorbed (`pristineGuestPerson`, the
	// definition convert adopts by): none of those, no `member_remove` naming it, no
	// guest row but this one. A former member's Person fails here and is the
	// superadmin's `mergePeople`.
	const [pristine] = await conn
		.select({ id: people.id })
		.from(people)
		.where(
			and(
				eq(people.id, sides.guest.personId),
				pristineGuestPerson(sides.guest.id),
			),
		)
		.limit(1);
	if (!pristine) return GUEST_LINK_HAS_HISTORY_MESSAGE;
	if (await personIsHereAlready(conn, sides.other.personId, clubId)) {
		return GUEST_LINK_ALREADY_HERE_MESSAGE;
	}
	return null;
}

/** The keeper Person as the merge would leave it: the preview's four values. */
async function linkProjection(
	conn: DbOrTx,
	sides: LinkSides,
): Promise<GuestLinkPreview> {
	const rows = await conn
		.select({
			id: people.id,
			name: people.name,
			preferredName: people.preferredName,
			email: people.email,
			phone: people.phone,
		})
		.from(people)
		.where(inArray(people.id, [sides.guest.personId, sides.other.personId]));
	const absorbed = rows.find((r) => r.id === sides.guest.personId);
	const keeper = rows.find((r) => r.id === sides.other.personId);
	if (!absorbed || !keeper) throw new Error(GUEST_LINK_NOT_FOUND_MESSAGE);
	return guestLinkResult(
		keeper,
		absorbed,
		await isGuestOnlyPerson(conn, keeper.id),
	);
}

/**
 * The confirm step of a link: the Person the two records would become, as
 * name, goes-by name, email and phone, and nothing else. NOT `getMergePreview`,
 * whose decoration lists every membership's club and global history counts.
 */
export async function previewGuestLink(
	input: GuestLinkInput,
): Promise<GuestLinkPreview> {
	await requireAdminOfBothClubs(input.userId, input.clubId, input.otherClubId);
	const sides = await readLinkSides(db, input);
	const refusal = await linkRefusal(db, input.clubId, sides);
	if (refusal) throw new Error(refusal);
	const p = await linkProjection(db, sides);
	return {
		name: p.name,
		preferredName: p.preferredName,
		email: p.email,
		phone: p.phone,
	};
}

/**
 * Say that this club's guest and a guest or member of another club the officer
 * runs are the same human. The OTHER record's Person is kept and this guest's is
 * absorbed (`mergePeople`, `mode: "guest-link"`, in this transaction): every
 * guest row of the absorbed Person re-points to the keeper, and the absorbed
 * Person is deleted. Each club's own `guests.name` is unchanged.
 *
 * `expected` is what the officer was shown; it is recomputed under the locks and
 * the link is refused if it differs, so the officer confirms what is written.
 */
export async function applyLinkGuestAcrossClubs(
	input: GuestLinkInput & { expected: GuestLinkPreview },
): Promise<{ ok: true }> {
	const { userId, clubId, otherClubId } = input;
	const { membership: actor } = await requireAdminOfBothClubs(
		userId,
		clubId,
		otherClubId,
	);
	return db.transaction(async (tx) => {
		const peek = await readLinkSides(tx, input);
		const persons = [peek.guest.personId, peek.other.personId];
		const named = [clubId, otherClubId];
		const before = await clubsToLock(tx, persons, named);
		await lockClubsStable(tx, before, persons, named);
		// The absorbed Person is deleted by the merge, so both are taken `FOR UPDATE`.
		await lockPersonsInOrder(tx, forUpdate(...persons));
		await assertClubSetHeld(tx, before, persons, named);
		const sides = await readLinkSides(tx, input, true);
		if (
			sides.guest.personId !== peek.guest.personId ||
			sides.other.personId !== peek.other.personId
		) {
			throw new Error(RECORD_CHANGED_MESSAGE);
		}
		await assertStillAdminOfBothClubs(tx, userId, clubId, otherClubId);

		const refusal = await linkRefusal(tx, clubId, sides);
		if (refusal) throw new Error(refusal);
		if (
			!sameGuestLinkPreview(await linkProjection(tx, sides), input.expected)
		) {
			throw new Error(GUEST_LINK_STALE_MESSAGE);
		}
		await mergePeople(
			{
				keeperPersonId: sides.other.personId,
				absorbedPersonId: sides.guest.personId,
				// An impersonating superadmin holds no seat to name as the actor, so the
				// audit row names them (`impersonated_by`), as every superadmin write does.
				actorUserId: actor.impersonatedBy ?? null,
			},
			tx,
			{
				mode: "guest-link",
				actorMemberId: actor.id,
				linkedGuest: { id: sides.guest.id, name: sides.guest.name },
			},
		);
		return { ok: true as const };
	});
}

export interface SeparateGuestInput {
	userId: string;
	clubId: string;
	guestId: string;
}

/**
 * The fresh Person a Separate gives a guest. With the contact its link recorded
 * (`recorded`) it is that, restored; otherwise the shared Person's email and phone
 * are copied ONLY when that Person is guest-only (`isGuestOnlyPerson`), so a
 * member's or a signed-in person's address is never copied under a guest's name.
 */
async function mintSeparatedPerson(
	tx: CrossClubTx,
	guest: { personId: string; name: string; preferredName: string | null },
	recorded:
		| NonNullable<ReturnType<typeof readGuestLinkRecord>>["contact"]
		| null,
): Promise<string> {
	let values: typeof people.$inferInsert;
	if (recorded) {
		values = {
			name: guest.name,
			preferredName: recorded.preferredName ?? guest.preferredName,
			email: recorded.email,
			phone: recorded.phone,
			preferredContact: recorded.preferredContact,
			contactPreferenceBy: recorded.contactPreferenceBy,
		};
	} else {
		const [shared] = await tx
			.select({ email: people.email, phone: people.phone })
			.from(people)
			.where(eq(people.id, guest.personId))
			.limit(1);
		const copy = await isGuestOnlyPerson(tx, guest.personId);
		values = {
			name: guest.name,
			preferredName: guest.preferredName,
			email: copy ? (shared?.email ?? null) : null,
			phone: copy ? (shared?.phone ?? null) : null,
		};
	}
	const [fresh] = await tx
		.insert(people)
		.values(values)
		.returning({ id: people.id });
	if (!fresh) throw new Error("Failed to create person.");
	return fresh.id;
}

/**
 * Undo a link, or a Person two clubs share for any reason: this guest gets a
 * fresh Person with its own name, and its row re-points to it. Admin of THIS club
 * only (maintainer decision: the undo of a wrong link must not need the other
 * club). The other clubs' rows keep the Person.
 *
 * Email and phone are copied to the fresh Person ONLY when the shared Person is
 * guest-only (`isGuestOnlyPerson`: nobody has signed in as them, no membership,
 * and never a member). A member's address is the roster's, and a signed-in
 * person's is theirs: neither is ever copied onto a guest's Person.
 */
export async function applySeparateGuest(
	input: SeparateGuestInput,
): Promise<{ ok: true }> {
	const { userId, clubId, guestId } = input;
	await requireClubRole(userId, clubId, ["admin"]);
	return db.transaction(async (tx) => {
		const peek = await readGuestOf(tx, clubId, guestId);
		if (!peek) throw new Error(GUEST_NOT_IN_CLUB_MESSAGE);
		const named = [clubId];
		const before = await clubsToLock(tx, [peek.personId], named);
		await lockClubsStable(tx, before, [peek.personId], named);
		await lockPersonsInOrder(tx, noKeyUpdate(peek.personId));
		await assertClubSetHeld(tx, before, [peek.personId], named);
		const guest = await readGuestOf(tx, clubId, guestId, true);
		if (!guest || guest.personId !== peek.personId) {
			throw new Error(RECORD_CHANGED_MESSAGE);
		}
		await assertStillClubAdmin(tx, userId, clubId);

		if (guest.stage === "joined") throw new Error(GUEST_NOW_MEMBER_MESSAGE);
		if (!(await personIsHeldElsewhere(tx, guest.personId, clubId))) {
			throw new Error(GUEST_ALREADY_SEPARATE_MESSAGE);
		}
		// The undo of a link gives this guest back what THIS guest had (the contact
		// the link recorded of its Person before it was absorbed), and never the
		// merged Person's: that may carry another club's guest's email and phone.
		// Without a record (an Add, or a Person two clubs came to share otherwise) the
		// shared Person's contact is copied only when it is guest-only.
		const [entry] = await tx
			.select({ detail: activityLog.detail })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, clubId),
					eq(activityLog.action, "member_merge"),
					sql`${activityLog.detail}->>'linkedGuestId' = ${guest.id}`,
					sql`${activityLog.detail}->>'keeperPersonId' = ${guest.personId}`,
				),
			)
			.orderBy(desc(activityLog.createdAt), desc(activityLog.id))
			.limit(1);
		const recorded = readGuestLinkRecord(entry?.detail)?.contact ?? null;
		const fresh = await mintSeparatedPerson(tx, guest, recorded);
		await tx
			.update(guests)
			.set({ personId: fresh, updatedAt: new Date() })
			.where(eq(guests.id, guest.id));
		return { ok: true as const };
	});
}

/**
 * The clubs OTHER than `exceptClubId` where this user is an admin or an elected
 * officer. Each candidate (a club they hold an active membership in) goes through
 * `requireClubRole` itself, so "admin" has exactly one definition; a refusal for a
 * reason of standing (no permission, not a member, archived) drops the club, and
 * anything else, a database error among them, propagates rather than reading as
 * "not an admin".
 */
export async function loadOtherAdminClubs(
	userId: string,
	exceptClubId: string,
): Promise<{ clubId: string; name: string }[]> {
	const candidates = await db
		.selectDistinct({ clubId: members.clubId, name: clubs.name })
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.innerJoin(clubs, eq(clubs.id, members.clubId))
		.where(
			and(
				eq(people.userId, userId),
				eq(members.status, "active"),
				ne(members.clubId, exceptClubId),
			),
		)
		.orderBy(asc(clubs.name), asc(members.clubId));
	const standing = new Set([
		NO_PERMISSION_MESSAGE,
		NOT_A_MEMBER_MESSAGE,
		CLUB_ARCHIVED_MESSAGE,
	]);
	const out: { clubId: string; name: string }[] = [];
	for (const c of candidates) {
		try {
			await requireClubRole(userId, c.clubId, ["admin"]);
			out.push(c);
		} catch (err) {
			if (!(err instanceof Error && standing.has(err.message))) throw err;
		}
	}
	return out;
}

export interface GuestLinkCandidate {
	kind: GuestLinkOtherKind;
	id: string;
	name: string;
	email: string | null;
	phone: string | null;
}

/** A `%` or `_` or `\` typed into the search box means itself. */
function likeContains(q: string): string {
	return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}

/**
 * The picker behind "Same person as…": up to 20 unconverted guests and active
 * members of `otherClubId`, by name, name/email/phone only. A case-insensitive
 * substring of `q` on the name or email filters them; an empty `q` is the first 20.
 */
export async function listGuestLinkCandidates(input: {
	userId: string;
	clubId: string;
	otherClubId: string;
	q: string;
}): Promise<GuestLinkCandidate[]> {
	await requireAdminOfBothClubs(input.userId, input.clubId, input.otherClubId);
	const q = input.q.trim();
	const pattern = q ? likeContains(q) : null;
	const [guestRows, memberRows] = await Promise.all([
		db
			.select({
				id: guests.id,
				name: guests.name,
				email: people.email,
				phone: people.phone,
			})
			.from(guests)
			.innerJoin(people, eq(people.id, guests.personId))
			.where(
				and(
					eq(guests.clubId, input.otherClubId),
					ne(guests.stage, "joined"),
					pattern
						? or(ilike(guests.name, pattern), ilike(people.email, pattern))
						: undefined,
				),
			)
			.orderBy(asc(guests.name), asc(guests.id))
			.limit(GUEST_LINK_CANDIDATE_LIMIT),
		db
			.select({
				id: members.id,
				name: members.name,
				email: people.email,
				phone: people.phone,
			})
			.from(members)
			.innerJoin(people, eq(people.id, members.personId))
			.where(
				and(
					eq(members.clubId, input.otherClubId),
					eq(members.status, "active"),
					pattern
						? or(ilike(members.name, pattern), ilike(people.email, pattern))
						: undefined,
				),
			)
			.orderBy(asc(members.name), asc(members.id))
			.limit(GUEST_LINK_CANDIDATE_LIMIT),
	]);
	const all: GuestLinkCandidate[] = [
		...guestRows.map((r) => ({ kind: "guest" as const, ...r })),
		...memberRows.map((r) => ({ kind: "member" as const, ...r })),
	];
	all.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	return all.slice(0, GUEST_LINK_CANDIDATE_LIMIT);
}
