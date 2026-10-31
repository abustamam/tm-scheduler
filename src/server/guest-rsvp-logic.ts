// The db-touching half of the public guest RSVP (#1443), behind the
// createServerFn in `guest-rsvp.ts` (never imported by client routes, so `#/db`
// and `pg` stay out of the browser bundle).
import { and, asc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";
import { db } from "#/db";
import {
	clubs,
	guests,
	meetingAttendance,
	meetingGuestRsvps,
	meetings,
	members,
	roleSlots,
	tableTopicsSpeakers,
} from "#/db/schema";
import { firstNameOf } from "#/lib/person-name";
import { toStoredPhone } from "#/lib/phone";
import { CLUB_BUSY_MESSAGE, lockClubForWrite } from "./club-write-lock";
import { loadClubDefaultCountryCode } from "./clubs-logic";
import { assertClubNotArchived } from "./guards";
import { lockOpenClub, resolveOrCreateBookGuest } from "./guest-pipeline-logic";
import {
	MAX_DAYS_OUT,
	MIN_FILL_MS,
	RSVP_MEETING_REFUSED_MESSAGE,
} from "./guest-rsvp-schemas";
import { loadTmodMemberId } from "./meeting-authz-logic";
import { isDeadlock } from "./pg-errors";

export interface GuestRsvpInput {
	clubId: string;
	meetingId: string;
	clientKey: string;
	firstName: string;
	email: string | null;
	phone: string | null;
	website: string;
	/** How long the form was open, measured on the client. */
	fillMs: number;
}

export interface GuestRsvpConfirmation {
	rsvpId: string;
	clubName: string;
	scheduledAt: Date;
	timeZone: string;
	location: string | null;
	/** Present whenever the meeting has a join link, hybrid included (#1444).
	 *  The ONE non-member response that carries it (with the member RSVP
	 *  confirmation, #1442); the meeting detail payload strips it for a
	 *  non-member (`public-meeting-payload.ts`). */
	joinUrl: string | null;
	/** The Toastmaster's first name, when that slot is filled (D8). */
	toastmasterFirstName: string | null;
}

export type GuestRsvpResult =
	| { ok: true; confirmation: GuestRsvpConfirmation }
	/** A bot's answer: success-shaped, nothing written. */
	| { ok: true; confirmation: null };

/**
 * One public RSVP. The order is the contract: honeypot and fill-time first
 * (silent success, nothing read or written), then the archive and meeting
 * gates, then ONE transaction under the club write lock that looks the retry
 * key up before it resolves any identity.
 */
export async function submitGuestRsvpLogic(
	input: GuestRsvpInput,
	now: Date = new Date(),
): Promise<GuestRsvpResult> {
	if (input.website !== "") return { ok: true, confirmation: null };
	if (!Number.isFinite(input.fillMs) || input.fillMs < MIN_FILL_MS) {
		return { ok: true, confirmation: null };
	}

	await assertClubNotArchived(input.clubId);
	const firstName = input.firstName.trim();
	if (!firstName) throw new Error("Please enter your first name.");
	const email = input.email?.trim() || null;
	const countryCode = await loadClubDefaultCountryCode(input.clubId);
	const phone = toStoredPhone(input.phone, countryCode);

	try {
		return await db.transaction(async (tx) => {
			await lockClubForWrite(tx, input.clubId);
			// The in-transaction archive gate, on EVERY path: a retry that hits
			// its clientKey would otherwise never take the club row lock.
			await lockOpenClub(tx, input.clubId, "share");

			// The meeting row FOR SHARE: a cancel in flight is waited for and seen.
			const [meeting] = await tx
				.select({
					clubId: meetings.clubId,
					status: meetings.status,
					scheduledAt: meetings.scheduledAt,
					lengthMinutes: meetings.lengthMinutes,
					location: meetings.location,
					joinUrl: meetings.joinUrl,
				})
				.from(meetings)
				.where(
					and(
						eq(meetings.id, input.meetingId),
						eq(meetings.clubId, input.clubId),
					),
				)
				.limit(1)
				.for("share");
			if (!meeting) throw new Error("Meeting not found.");
			assertRsvpOpen(meeting, now);

			const [club] = await tx
				.select({
					name: clubs.name,
					timezone: clubs.timezone,
					defaultLocation: clubs.defaultLocation,
				})
				.from(clubs)
				.where(eq(clubs.id, input.clubId))
				.limit(1);
			if (!club) throw new Error("Club not found.");

			// Retry identity FIRST (eng review D3): a hit returns that row's guest
			// and creates nothing. The client never sends a guest id.
			const [hit] = await tx
				.select({ id: meetingGuestRsvps.id })
				.from(meetingGuestRsvps)
				.where(
					and(
						eq(meetingGuestRsvps.meetingId, input.meetingId),
						eq(meetingGuestRsvps.clientKey, input.clientKey),
					),
				)
				.limit(1);
			let rsvpId = hit?.id;

			if (!rsvpId) {
				const { guestId } = await resolveOrCreateBookGuest(tx, input.clubId, {
					name: firstName,
					email,
					phone,
				});
				const [inserted] = await tx
					.insert(meetingGuestRsvps)
					.values({
						clubId: input.clubId,
						meetingId: input.meetingId,
						guestId,
						clientKey: input.clientKey,
					})
					.onConflictDoNothing()
					.returning({ id: meetingGuestRsvps.id });
				if (inserted) {
					rsvpId = inserted.id;
				} else {
					// This guest already RSVP'd from another browser: same RSVP.
					const [existing] = await tx
						.select({ id: meetingGuestRsvps.id })
						.from(meetingGuestRsvps)
						.where(
							and(
								eq(meetingGuestRsvps.meetingId, input.meetingId),
								eq(meetingGuestRsvps.guestId, guestId),
							),
						)
						.limit(1);
					// Defensive: under the club write lock the conflicting row is
					// committed and visible, so this cannot be reached; no test.
					if (!existing) throw new Error(CLUB_BUSY_MESSAGE);
					rsvpId = existing.id;
				}
			}

			const tmodId = await loadTmodMemberId(input.meetingId, tx);
			let toastmasterFirstName: string | null = null;
			if (tmodId) {
				const [tmod] = await tx
					.select({ name: members.name })
					.from(members)
					.where(eq(members.id, tmodId))
					.limit(1);
				toastmasterFirstName = tmod ? firstNameOf(tmod.name) || null : null;
			}

			return {
				ok: true as const,
				confirmation: {
					rsvpId,
					clubName: club.name,
					scheduledAt: meeting.scheduledAt,
					timeZone: club.timezone,
					location: meeting.location ?? club.defaultLocation ?? null,
					// Any meeting with a join link, hybrid included (#1444).
					joinUrl: meeting.joinUrl ?? null,
					toastmasterFirstName,
				},
			};
		});
	} catch (err) {
		if (isDeadlock(err)) throw new Error(CLUB_BUSY_MESSAGE, { cause: err });
		throw err;
	}
}

/** A scheduled meeting that has not ended and is at most `MAX_DAYS_OUT` away. */
function assertRsvpOpen(
	meeting: {
		status: "scheduled" | "cancelled" | "completed";
		scheduledAt: Date;
		lengthMinutes: number;
	},
	now: Date,
): void {
	if (meeting.status !== "scheduled") {
		throw new Error(RSVP_MEETING_REFUSED_MESSAGE);
	}
	const endsAt = meeting.scheduledAt.getTime() + meeting.lengthMinutes * 60_000;
	const horizon = now.getTime() + MAX_DAYS_OUT * 24 * 60 * 60 * 1000;
	if (endsAt < now.getTime() || meeting.scheduledAt.getTime() > horizon) {
		throw new Error(RSVP_MEETING_REFUSED_MESSAGE);
	}
}

/** One RSVP'd guest as the officer's panel shows them. */
export interface MeetingGuestRsvp {
	guestId: string;
	name: string;
	/** Which visit this RSVP is for: past visits plus one. 1 is a first visit. */
	visitNumber: number;
}

/** How many guests have RSVP'd to a meeting. Public: a number, no names. */
export async function countMeetingGuestRsvps(
	meetingId: string,
): Promise<number> {
	const rows = await db
		.select({ id: meetingGuestRsvps.id })
		.from(meetingGuestRsvps)
		.where(eq(meetingGuestRsvps.meetingId, meetingId));
	return rows.length;
}

/**
 * The guests who RSVP'd to a meeting, by name, oldest RSVP first, each with
 * the visit this would be: the visits made at EARLIER meetings, plus one.
 * OFFICERS ONLY: the caller gates it; a guest's name is not for a public payload.
 *
 * "Earlier" is strictly before THIS meeting's start, this meeting excluded. The
 * pipeline's `loadGuestVisitSummaries` counts every visit up to today, so a guest
 * who holds a role at this very meeting, or who came to a later one, would read
 * as a returning guest on an RSVP for a meeting they had not yet attended. The
 * visit rule itself is `guestVisits`' (a present row, a held slot or a Table
 * Topics turn, at a non-cancelled meeting whose club-local date has arrived);
 * only the "before this meeting" bound is added here.
 */
export async function loadMeetingGuestRsvps(
	meetingId: string,
	clubId: string,
	timeZone: string,
): Promise<MeetingGuestRsvp[]> {
	const rows = await db
		.select({ guestId: guests.id, name: guests.name })
		.from(meetingGuestRsvps)
		.innerJoin(guests, eq(guests.id, meetingGuestRsvps.guestId))
		.where(eq(meetingGuestRsvps.meetingId, meetingId))
		.orderBy(asc(meetingGuestRsvps.createdAt));
	if (rows.length === 0) return [];

	const [thisMeeting] = await db
		.select({ scheduledAt: meetings.scheduledAt })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!thisMeeting) return [];

	const guestIds = rows.map((r) => r.guestId);
	const earlier = and(
		eq(meetings.clubId, clubId),
		ne(meetings.status, "cancelled"),
		lt(meetings.scheduledAt, thisMeeting.scheduledAt),
		sql`(${meetings.scheduledAt} at time zone ${timeZone}::text)::date <= (now() at time zone ${timeZone}::text)::date`,
	);
	// `union` (not `union all`): a guest with a row AND a slot at one meeting
	// is one visit.
	const visits = await union(
		db
			.select({ guestId: meetingAttendance.guestId, meetingId: meetings.id })
			.from(meetingAttendance)
			.innerJoin(meetings, eq(meetings.id, meetingAttendance.meetingId))
			.where(
				and(
					earlier,
					inArray(meetingAttendance.guestId, guestIds),
					eq(meetingAttendance.status, "present"),
				),
			),
		db
			.select({ guestId: roleSlots.assignedGuestId, meetingId: meetings.id })
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(and(earlier, inArray(roleSlots.assignedGuestId, guestIds))),
		db
			.select({
				guestId: tableTopicsSpeakers.guestId,
				meetingId: meetings.id,
			})
			.from(tableTopicsSpeakers)
			.innerJoin(meetings, eq(meetings.id, tableTopicsSpeakers.meetingId))
			.where(and(earlier, inArray(tableTopicsSpeakers.guestId, guestIds))),
	);
	const past = new Map<string, number>();
	for (const v of visits) {
		if (v.guestId) past.set(v.guestId, (past.get(v.guestId) ?? 0) + 1);
	}
	return rows.map((r) => ({
		guestId: r.guestId,
		name: r.name,
		visitNumber: (past.get(r.guestId) ?? 0) + 1,
	}));
}
