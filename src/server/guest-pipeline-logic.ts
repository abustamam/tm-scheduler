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
	inArray,
	isNotNull,
	isNull,
	min,
	ne,
	sql,
} from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";
import { db } from "#/db";
import {
	activityLog,
	clubs,
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
import { isAtMeetingNow } from "#/lib/guest-book-window";
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
import type { OfficerPosition } from "#/lib/officers";
import { namesAgree } from "#/lib/person-name";
import {
	coalesceToE164,
	DEFAULT_COUNTRY_CODE,
	toStoredPhone,
} from "#/lib/phone";
import { normalizedEmail, rosterConflictFor } from "./account-link-logic";
import { logActivity } from "./activity";
import { loadClubDefaultCountryCode } from "./clubs-logic";
import { assertClubNotArchived } from "./guards";
import { closeOpenOfficerTerms } from "./officers-logic";

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
 * What `matchGuest` compares against. Wider than `GuestContactRow` by the two
 * columns the ORDERING needs, because the order is part of the answer (below)
 * and a caller that loaded rows in some other order would get a different one.
 */
export interface GuestMatchCandidate extends GuestContactRow {
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
export type GuestMatch =
	| { outcome: "matched"; via: "email" | "phone"; guest: GuestMatchCandidate }
	| { outcome: "new" }
	| {
			outcome: "ambiguous";
			reason: "phone_name_disagree" | "name_only";
			candidates: GuestMatchCandidate[];
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
export function matchGuest(
	candidates: GuestMatchCandidate[],
	input: GuestMatchInput,
	opts?: { excludeGuestId?: string; nameOnlyAmbiguity?: boolean },
): GuestMatch {
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
	opts?: { excludeGuestId?: string },
): Promise<GuestMatch> {
	const cols = {
		id: guests.id,
		name: guests.name,
		email: guests.email,
		phone: guests.phone,
		createdAt: guests.createdAt,
	};
	const scope = opts?.excludeGuestId
		? and(eq(guests.clubId, clubId), ne(guests.id, opts.excludeGuestId))
		: eq(guests.clubId, clubId);
	const order = [asc(guests.createdAt), asc(guests.id)] as const;

	const email = input.email?.trim() || null;
	const digits = normalizePhone(input.phone);

	const candidates: GuestMatchCandidate[] = [];
	if (email) {
		candidates.push(
			...(await conn
				.select(cols)
				.from(guests)
				.where(and(scope, sql`lower(${guests.email}) = ${email.toLowerCase()}`))
				.orderBy(...order)
				.limit(1)),
		);
	}
	if (digits) {
		candidates.push(
			...(await conn
				.select(cols)
				.from(guests)
				.where(
					and(
						scope,
						sql`regexp_replace(coalesce(${guests.phone}, ''), '[^0-9]', '', 'g') = ${digits}`,
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
	opts?: { excludeGuestId?: string },
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
): Promise<GuestMatchCandidate[]> {
	return conn
		.select({
			id: guests.id,
			name: guests.name,
			email: guests.email,
			phone: guests.phone,
			createdAt: guests.createdAt,
		})
		.from(guests)
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
				ne(meetings.status, "cancelled"),
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

	return db.transaction(async (tx) => {
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
			// Throttle the CREATE path only. Both statements run inside this
			// transaction, behind a lock on the club row — a count taken OUTSIDE
			// the transaction is not a cap at all: every concurrent request reads
			// the same pre-insert total and they all pass. That exact bypass was
			// proved on the voting guest cap (#510), where 200 concurrent calls
			// cleared a limit of 60. `FOR UPDATE` serialises signups per club, and
			// under READ COMMITTED the COUNT below takes a fresh snapshot once the
			// lock is granted, so it sees the rows the requests ahead committed.
			await tx.execute(
				sql`SELECT id FROM clubs WHERE id = ${input.clubId} FOR UPDATE`,
			);
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
	/**
	 * DISPLAY phone: E.164 where it can be derived, otherwise the stored value
	 * verbatim (`coalesceToE164`) — what the card's WhatsApp link reads.
	 *
	 * Never bind the EDIT DIALOG to this; bind it to `phoneRaw`.
	 */
	phone: string | null;
	/**
	 * The `guests.phone` column byte-for-byte — what the edit dialog prefills.
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
	// Both club-level facts in ONE query. They live on the same `clubs` row, and
	// the timezone has to resolve before the visits subquery can be built, so a
	// `Promise.all` over two loaders bought concurrency for a round trip that did
	// not need to exist at all.
	const { timeZone: tz, countryCode: cc } =
		await loadClubPipelineSettings(clubId);
	const visits = guestVisits(clubId, tz).as("guest_visits");
	const [rows, visitRows, slotRows, linkRows, conversionRows] =
		await Promise.all([
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
		]);

	const visitsByGuest = new Map(visitRows.map((v) => [v.guestId, v]));
	const slotsByGuest = new Map(slotRows.map((s) => [s.guestId, s]));
	const reversible = new Set(linkRows.map((l) => l.guestId));
	const undoable = new Set(
		conversionRows
			.filter((c) => readConversionRecord(c.detail) !== null)
			.map((c) => c.guestId),
	);

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
			stage: r.stage,
			convertedMembershipId: r.convertedMembershipId,
			linkReversible: reversible.has(r.id),
			conversionUndoable: undoable.has(r.id),
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

	const clash = await findGuestForContact(
		db,
		input.clubId,
		{ name, email, phone },
		{ excludeGuestId: input.guestId },
	);
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
 * Convert-to-member (ADR-0018): promote a guest into a club Membership.
 *
 * Transactional: (1) dedup the Person by email→phone-with-name-agreement (link
 * an existing Person, else create one — see the step-1 comment for why a bare
 * phone match is not enough); (2) create the Membership for this club (`clubRole: member`,
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
	// The roster row this convert CREATED and the address it wrote there, for
	// the shared-address check after commit (see the end of this function).
	let written: { personId: string; email: string } | null = null;

	const result = await db.transaction(async (tx) => {
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
		//    (club-less), so both arms match only a Person THIS club already
		//    holds (#759) — an unscoped match reached across every club, and
		//    attaching a stranger's Person here denies them sign-in.
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
		//    action, and the superadmin merge tool
		//    exists to fuse two Persons after the fact. Under-matching is visible
		//    and reversible; over-matching is neither.
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
			// Matches the person-level address OR THIS CLUB's roster record for them
			// (#756). Migration 0076 nulled `people.email` for everyone who has never
			// signed in, so a person-level-only match stopped recognising essentially
			// the whole roster — and the miss is not quiet: converting a guest who is
			// already a member then mints a SECOND Person and a second roster row for
			// the same human, in the same club. Worse, the pair is invisible to
			// `listDuplicatePeople` unless it coalesces the same way, because one
			// row's `people.email` is NULL.
			//
			// BOTH halves match only a Person THIS club already holds (#759), and
			// that is the INNER join's doing. A club-scoped LEFT join (what this was)
			// scopes the `members.email` half and nothing else: `people.email` is
			// global, so the OR matched a Person in any club. Without it, a guest
			// typed with a stranger's address attached that stranger's Person to
			// this club, and a Person two clubs hold cannot bind an account by any
			// route (`rosterPermitsBind`): the convert denied them sign-in from a
			// club neither they nor their officers can see. A Person no club holds
			// is refused too — attaching one would make this club's roster row the
			// only vouching row for their account. A refused match falls through to
			// the fresh-Person arm below, which is safe here as it is not in the
			// importer: a guest carries no Customer ID to collide with.
			const candidates = await tx
				.selectDistinct({ id: people.id, createdAt: people.createdAt })
				.from(people)
				.innerJoin(
					members,
					and(
						eq(members.personId, people.id),
						eq(members.clubId, input.clubId),
					),
				)
				.where(
					sql`${normalizedEmail(people.email)} = ${email.toLowerCase()}
					    or ${normalizedEmail(members.email)} = ${email.toLowerCase()}`,
				)
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
					and(
						eq(members.personId, people.id),
						eq(members.clubId, input.clubId),
					),
				)
				.where(
					sql`regexp_replace(coalesce(${people.phone}, ''), '[^0-9]', '', 'g') = ${digits}`,
				)
				.orderBy(...order)
				.limit(PHONE_CANDIDATE_LIMIT);
			const match = candidates.find((p) => namesAgree(p.name, name));
			if (match) personId = match.id;
		}
		// Whether THIS conversion minted the row, as opposed to deduping onto one
		// that already existed. Recorded in step 5 because an undo must never
		// delete a Person or a membership it did not create (#618) — and nothing
		// readable after the fact distinguishes the two.
		let createdPerson = false;
		let createdMembership = false;
		if (!personId) {
			const [p] = await tx
				.insert(people)
				.values({ name, preferredName, email, phone })
				.returning({ id: people.id });
			if (!p) throw new Error("Failed to create person.");
			personId = p.id;
			createdPerson = true;
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
			// email deduped onto a Person from ANOTHER club skipped the fresh-Person
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
				createdMembership = true;
				if (email) written = { personId, email };
			} else {
				// The conflict branch: a concurrent convert won and created this row.
				// It is not ours, so `createdMembership` stays false and an undo will
				// detach the guest without deleting a membership another conversion
				// is the author of.
				//
				// Since #759 the dedup above matches only a Person this club ALREADY
				// holds, which takes the reuse branch; a fresh Person is invisible to
				// every other transaction. So nothing ordinary reaches here any more
				// — it would take the matched roster row being deleted and re-added
				// between the dedup and the locked SELECT. Kept because the unique
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
	// Only a roster row this convert CREATED is checked. Reuse writes no address,
	// so any obstacle there predates it, and a fresh Person is never linked.
	// Narrowed to `shared_address`: the other two arms are properties of the
	// subject's own memberships, and `multiple_clubs` is what the club-scoped
	// dedup above now prevents a convert from creating.
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
		// Lock the guest row first and re-read `stage` under it, for the reason
		// `applyConvertGuestToMember` documents: read outside the transaction it is
		// a stale snapshot, and two concurrent links would both pass the check.
		const [guest] = await tx
			.select()
			.from(guests)
			.where(and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)))
			.limit(1)
			.for("update");
		if (!guest) throw new Error("Guest not found in this club.");
		// A STRANDED guest (joined, pointer null — #618) is deliberately allowed
		// through: their membership was removed from the roster, and pointing them
		// at a member is the recovery. Only a live link is refused.
		if (guest.stage === "joined" && guest.convertedMembershipId) {
			throw new Error(LINK_ALREADY_JOINED_MESSAGE);
		}

		const [member] = await tx
			.select({ id: members.id })
			.from(members)
			.where(
				and(eq(members.id, input.memberId), eq(members.clubId, input.clubId)),
			)
			.limit(1);
		if (!member) throw new Error(LINK_MEMBER_NOT_IN_CLUB_MESSAGE);

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

		await tx
			.update(guests)
			.set({
				stage: "joined",
				convertedMembershipId: input.memberId,
				updatedAt: new Date(),
			})
			.where(eq(guests.id, input.guestId));

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
			detail: { fromGuestId: input.guestId, guestName: guest.name, slotIds },
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
 * the Person. They hang off `people`, not `members`, so removing a membership
 * never destroys them — but on a Person this conversion minted they can only
 * have been earned afterwards, which makes them evidence the human really did
 * start participating as a member. On a Person that was deduped onto, the same
 * rows are somebody's pre-existing history in another club and say nothing about
 * this conversion.
 *
 * The created Person is deliberately LEFT BEHIND when the membership goes. It is
 * global (ADR-0008), deleting it could cascade further than this undo's remit,
 * and an orphan Person is visible to the merge tool — which is the recoverable
 * direction this file keeps choosing.
 */
export async function applyUndoGuestConversion(
	input: UndoConversionInput,
): Promise<UndoConversionResult> {
	return db.transaction(async (tx) => {
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
		await tx
			.select({ id: members.id })
			.from(members)
			.where(eq(members.id, membershipId))
			.limit(1)
			.for("update");

		const [person] = await tx
			.select({ userId: people.userId })
			.from(people)
			.where(eq(people.id, record.personId))
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

		if (record.createdPerson) {
			const [spoken] = await tx
				.select({ n: count() })
				.from(speeches)
				.where(eq(speeches.personId, record.personId));
			if (Number(spoken?.n ?? 0) > 0) {
				throw new Error(UNDO_MEMBER_HAS_HISTORY_MESSAGE("speeches"));
			}
			const [enrolled] = await tx
				.select({ n: count() })
				.from(pathEnrollments)
				.where(eq(pathEnrollments.personId, record.personId));
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
