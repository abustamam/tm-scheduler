// VP-Membership guest-pipeline DB logic (#208 / ADR-0018), split out from the
// createServerFn wrappers in `guest-pipeline.ts` (a client-imported module the
// guard test forbids from exporting db-touching functions). Integration-testable
// by mocking `#/db`. See the header of `members-logic.ts` for the why.
import { and, asc, count, eq, min, ne, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	clubs,
	guests,
	meetingAttendance,
	meetings,
	members,
	people,
	roleSlots,
} from "#/db/schema";
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

/** Digits-only form of a phone number, so formatting variants dedupe/match. */
export function normalizePhone(phone: string | null | undefined): string {
	return (phone ?? "").replace(/\D/g, "");
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

/**
 * The club's current/nearest meeting for guest-book capture: a non-cancelled
 * meeting scheduled for TODAY in the club's timezone (even earlier today — the
 * guest is at it now), else the next upcoming scheduled meeting. Returns null
 * when neither exists (capture then records the guest with no attendance row).
 */
export async function resolveCurrentMeetingId(
	clubId: string,
): Promise<string | null> {
	const [club] = await db
		.select({ timezone: clubs.timezone })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	const timeZone = club?.timezone ?? "America/Chicago";

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
 * Dedup key is PHONE (normalized to digits) first, then EMAIL — a phone/email
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
	// derived from the normalized value so matching stays consistent.
	const cc = await loadClubDefaultCountryCode(input.clubId);
	const phone = toStoredPhone(input.phone, cc);
	const digits = normalizePhone(phone);

	const meetingId = await resolveCurrentMeetingId(input.clubId);

	return db.transaction(async (tx) => {
		// 1. Dedup, club-scoped: phone (digits) → email → none.
		let existing:
			| { id: string; email: string | null; phone: string | null }
			| undefined;
		if (digits) {
			[existing] = await tx
				.select({ id: guests.id, email: guests.email, phone: guests.phone })
				.from(guests)
				.where(
					and(
						eq(guests.clubId, input.clubId),
						sql`regexp_replace(coalesce(${guests.phone}, ''), '[^0-9]', '', 'g') = ${digits}`,
					),
				)
				.limit(1);
		}
		if (!existing && email) {
			[existing] = await tx
				.select({ id: guests.id, email: guests.email, phone: guests.phone })
				.from(guests)
				.where(
					and(
						eq(guests.clubId, input.clubId),
						sql`lower(${guests.email}) = ${email.toLowerCase()}`,
					),
				)
				.limit(1);
		}

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
	email: string | null;
	phone: string | null;
	stage: GuestStage;
	convertedMembershipId: string | null;
	/** Earliest attended meeting date (derived from attendance); null if none. */
	firstVisitAt: Date | null;
	/** Count of attendance rows (derived, never a stored counter). */
	visitCount: number;
	createdAt: Date;
}

/**
 * Every guest in a club with a DERIVED first-visit date and visit count computed
 * from `meeting_attendance` joined to `meetings` — never a stored counter (the
 * derived style of `role-recency-logic.ts`). Grouped/served for the pipeline
 * view; the caller buckets by `stage`.
 */
export async function loadGuestPipeline(
	clubId: string,
): Promise<PipelineGuestRow[]> {
	const rows = await db
		.select({
			id: guests.id,
			name: guests.name,
			email: guests.email,
			phone: guests.phone,
			stage: guests.stage,
			convertedMembershipId: guests.convertedMembershipId,
			createdAt: guests.createdAt,
			visitCount: count(meetingAttendance.id),
			firstVisitAt: min(meetings.scheduledAt),
		})
		.from(guests)
		.leftJoin(meetingAttendance, eq(meetingAttendance.guestId, guests.id))
		.leftJoin(meetings, eq(meetings.id, meetingAttendance.meetingId))
		.where(eq(guests.clubId, clubId))
		.groupBy(guests.id)
		.orderBy(asc(guests.name));

	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		email: r.email,
		phone: r.phone,
		stage: r.stage,
		convertedMembershipId: r.convertedMembershipId,
		visitCount: Number(r.visitCount),
		firstVisitAt: r.firstVisitAt ? new Date(r.firstVisitAt) : null,
		createdAt: r.createdAt,
	}));
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
 * Transactional: (1) dedup the Person by phone→email (link an existing Person,
 * else create one); (2) create the Membership for this club (`clubRole: member`,
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
	const [guest] = await db
		.select()
		.from(guests)
		.where(and(eq(guests.id, input.guestId), eq(guests.clubId, input.clubId)))
		.limit(1);
	if (!guest) throw new Error("Guest not found in this club.");
	if (guest.stage === "joined") {
		throw new Error("This guest has already been converted to a member.");
	}

	const name = guest.name.trim();
	const email = guest.email?.trim() || null;
	// Re-standardize to E.164 on the way into people/members (#295) — the guest
	// row may predate normalize-on-write; the digits form (dedup) follows it.
	const cc = await loadClubDefaultCountryCode(input.clubId);
	const phone = toStoredPhone(guest.phone, cc);
	const digits = normalizePhone(phone);

	return db.transaction(async (tx) => {
		// 1. Person dedup (phone → email → create). People are global (club-less).
		let personId: string | null = null;
		if (digits) {
			const [p] = await tx
				.select({ id: people.id })
				.from(people)
				.where(
					sql`regexp_replace(coalesce(${people.phone}, ''), '[^0-9]', '', 'g') = ${digits}`,
				)
				.limit(1);
			if (p) personId = p.id;
		}
		if (!personId && email) {
			const [p] = await tx
				.select({ id: people.id })
				.from(people)
				.where(sql`lower(${people.email}) = ${email.toLowerCase()}`)
				.limit(1);
			if (p) personId = p.id;
		}
		if (!personId) {
			const [p] = await tx
				.insert(people)
				.values({ name, email, phone })
				.returning({ id: people.id });
			if (!p) throw new Error("Failed to create person.");
			personId = p.id;
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
			const [m] = await tx
				.insert(members)
				.values({
					clubId: input.clubId,
					personId,
					name,
					email,
					phone,
					clubRole: "member",
					status: "active",
					joinedAt: new Date(),
				})
				.returning({ id: members.id });
			if (!m) throw new Error("Failed to create membership.");
			membershipId = m.id;
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
