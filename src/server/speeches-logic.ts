// Unscheduled-speech DB logic (ADR-0009 / #102), split out from `speeches.ts`
// (a createServerFn module the guard test forbids from exporting db-touching
// functions). Integration-testable by mocking `#/db` and passing an explicit
// connection.
//
// "Unscheduled" is DERIVED, not stored: a speech is unscheduled when it is not
// referenced by any speaker slot whose meeting is *not cancelled*. Releasing or
// reassigning a slot clears its `speech_id` (see slots-logic), so the speech
// becomes unscheduled again automatically; a cancelled meeting likewise drops
// its slots out of the "scheduled" set. `archived` is the only non-derivable
// state and hides an abandoned draft from the list by default.
import {
	and,
	asc,
	desc,
	eq,
	exists,
	gte,
	isNull,
	ne,
	notExists,
	sql,
} from "drizzle-orm";
import type { db } from "#/db";
import {
	meetings,
	members,
	people,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import { logActivity } from "./activity";

// Either the main db client or a drizzle transaction — so these helpers can run
// inside a caller's transaction and commit atomically with the slot change.
type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

export type UnscheduledSpeech = {
	id: string;
	personId: string;
	ownerName: string;
	title: string;
	introduction: string | null;
	pathwayPath: string | null;
	projectName: string | null;
	projectLevel: string | null;
	minMinutes: number | null;
	maxMinutes: number | null;
	archived: boolean;
	updatedAt: Date;
};

/**
 * List a Person's and/or a club's **unscheduled** speeches — those not
 * referenced by any active (non-cancelled) speaker slot. Derived by a NOT EXISTS
 * over `role_slots` joined to non-cancelled meetings (no stored status).
 *
 * Scope:
 *  - `personId` — restrict to one Person's speeches (the member-profile surface).
 *  - `clubId` — restrict to speeches owned by a Person who is a member of that
 *    club (the club-wide reschedule pool). A speech has no club of its own, so
 *    "a club's unscheduled speeches" = its members' unscheduled speeches.
 *  - `includeArchived` (default false) — archived drafts are hidden by default.
 *
 * Most-recently-updated first.
 */
export async function listUnscheduledSpeeches(
	conn: DbOrTx,
	filter: { clubId?: string; personId?: string; includeArchived?: boolean },
): Promise<UnscheduledSpeech[]> {
	// A speech is "scheduled" iff some slot references it whose meeting is not
	// cancelled. NOT EXISTS of that = unscheduled.
	const scheduled = conn
		.select({ one: sql`1` })
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(
			and(
				eq(roleSlots.speechId, speeches.id),
				ne(meetings.status, "cancelled"),
			),
		);

	const conditions = [notExists(scheduled)];
	if (!filter.includeArchived) {
		conditions.push(eq(speeches.archived, false));
	}
	if (filter.personId) {
		conditions.push(eq(speeches.personId, filter.personId));
	}
	if (filter.clubId) {
		// The owning Person must have a membership in this club.
		const inClub = conn
			.select({ one: sql`1` })
			.from(members)
			.where(
				and(
					eq(members.personId, speeches.personId),
					eq(members.clubId, filter.clubId),
				),
			);
		conditions.push(exists(inClub));
	}

	return conn
		.select({
			id: speeches.id,
			personId: speeches.personId,
			ownerName: people.name,
			title: speeches.title,
			introduction: speeches.introduction,
			pathwayPath: speeches.pathwayPath,
			projectName: speeches.projectName,
			projectLevel: speeches.projectLevel,
			minMinutes: speeches.minMinutes,
			maxMinutes: speeches.maxMinutes,
			archived: speeches.archived,
			updatedAt: speeches.updatedAt,
		})
		.from(speeches)
		.innerJoin(people, eq(people.id, speeches.personId))
		.where(and(...conditions))
		.orderBy(desc(speeches.updatedAt));
}

export type OpenSpeakerSlot = {
	slotId: string;
	meetingId: string;
	scheduledAt: Date;
	roleName: string;
};

/**
 * Open speaker slots a speech can be attached to (the reschedule targets): a
 * speaker-role slot with no assignee and no speech, on an upcoming, non-cancelled
 * meeting of the club. Earliest meeting first.
 */
export async function listOpenSpeakerSlots(
	conn: DbOrTx,
	clubId: string,
): Promise<OpenSpeakerSlot[]> {
	return conn
		.select({
			slotId: roleSlots.id,
			meetingId: meetings.id,
			scheduledAt: meetings.scheduledAt,
			roleName: roleDefinitions.name,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(
			and(
				eq(meetings.clubId, clubId),
				ne(meetings.status, "cancelled"),
				gte(meetings.scheduledAt, new Date()),
				eq(roleDefinitions.isSpeakerRole, true),
				isNull(roleSlots.assignedMemberId),
				isNull(roleSlots.speechId),
			),
		)
		.orderBy(asc(meetings.scheduledAt));
}

/**
 * Archive or unarchive a speech. Validates the speech is owned by a member of
 * `clubId` so a club surface can't toggle another club's speeches. Bumps
 * `updatedAt` so the row keeps its place in the recency ordering.
 */
export async function setSpeechArchived(
	conn: DbOrTx,
	args: { speechId: string; clubId: string; archived: boolean },
): Promise<void> {
	const [speech] = await conn
		.select({ personId: speeches.personId })
		.from(speeches)
		.where(eq(speeches.id, args.speechId))
		.limit(1);
	if (!speech) throw new Error("Speech not found.");

	const [membership] = await conn
		.select({ id: members.id })
		.from(members)
		.where(
			and(
				eq(members.personId, speech.personId),
				eq(members.clubId, args.clubId),
			),
		)
		.limit(1);
	if (!membership) {
		throw new Error("That speech isn't owned by a member of this club.");
	}

	await conn
		.update(speeches)
		.set({ archived: args.archived, updatedAt: new Date() })
		.where(eq(speeches.id, args.speechId));
}

/**
 * The reschedule flow: attach an existing (unscheduled) Person-owned speech to
 * an open speaker slot. Points the slot at the speech and assigns the slot to
 * the speech owner's active membership in the slot's club (open → claimed).
 *
 * Honors the one-active-slot-per-speech invariant (ADR-0009): any slot still
 * referencing this speech (e.g. a slot on a cancelled meeting) is unlinked
 * first, so the move never trips the `role_slots_speech_unique` index. The
 * speech row itself is never destroyed.
 *
 * The caller should wrap this in a transaction (as the server fn does) so the
 * unlink + relink + activity log commit atomically.
 */
export async function attachSpeechToOpenSlot(
	conn: DbOrTx,
	args: { speechId: string; slotId: string; actorMemberId: string | null },
): Promise<{ clubId: string; assignedMemberId: string }> {
	const [speech] = await conn
		.select({ id: speeches.id, personId: speeches.personId })
		.from(speeches)
		.where(eq(speeches.id, args.speechId))
		.limit(1);
	if (!speech) throw new Error("Speech not found.");

	const [slot] = await conn
		.select({
			id: roleSlots.id,
			status: roleSlots.status,
			assignedMemberId: roleSlots.assignedMemberId,
			speechId: roleSlots.speechId,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
			clubId: meetings.clubId,
			meetingStatus: meetings.status,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(eq(roleSlots.id, args.slotId))
		.limit(1);
	if (!slot) throw new Error("Speaker slot not found.");
	if (!slot.isSpeakerRole) {
		throw new Error("Only a speaker slot can host a speech.");
	}
	if (slot.meetingStatus === "cancelled") {
		throw new Error("That meeting is cancelled.");
	}
	if (slot.speechId) {
		throw new Error("That slot already has a speech attached.");
	}
	if (slot.assignedMemberId) {
		throw new Error("That speaker slot is already taken.");
	}

	// The speech is Person-owned; the slot needs a membership to assign it to.
	const [membership] = await conn
		.select({ id: members.id })
		.from(members)
		.where(
			and(
				eq(members.personId, speech.personId),
				eq(members.clubId, slot.clubId),
				eq(members.status, "active"),
			),
		)
		.limit(1);
	if (!membership) {
		throw new Error("The speaker isn't an active member of this club.");
	}

	// Invariant guard: unlink any slot still pointing at this speech before we
	// relink, so setting the new slot's speech_id can't violate the unique index.
	await conn
		.update(roleSlots)
		.set({ speechId: null })
		.where(eq(roleSlots.speechId, args.speechId));

	await conn
		.update(roleSlots)
		.set({
			assignedMemberId: membership.id,
			status: "claimed",
			claimedAt: new Date(),
			speechId: args.speechId,
		})
		.where(eq(roleSlots.id, args.slotId));

	await logActivity(conn, {
		clubId: slot.clubId,
		actorMemberId: args.actorMemberId,
		action: "claim",
		targetType: "slot",
		targetId: args.slotId,
		detail: { memberId: membership.id, speechId: args.speechId },
	});

	return { clubId: slot.clubId, assignedMemberId: membership.id };
}
