// Meeting-minutes DB logic (ADR-0014 / #152), split out from `minutes.ts` (a
// createServerFn module the guard test forbids from exporting db-touching
// functions). Integration-testable by mocking `#/db`.
//
// Minutes are a record OVER the `meetings` row: attendance, Table Topics
// speakers, and awards. Every assignee is a member XOR a guest (mirroring
// `role_slots`), enforced by DB check constraints. All mutations here trust the
// caller's admin gate (the server fn calls `requireClubRole(..., ["admin"])`).
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "#/db";
import {
	guests,
	meetingAttendance,
	meetingAwards,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
	tableTopicsSpeakers,
} from "#/db/schema";

export type AttendanceStatus = "present" | "absent" | "excused";
export type AwardCategory =
	| "best_speaker"
	| "best_evaluator"
	| "best_table_topics";

/** The award categories, in display order. */
export const AWARD_CATEGORIES: AwardCategory[] = [
	"best_speaker",
	"best_evaluator",
	"best_table_topics",
];

/** Contact fields for a brand-new club guest (name required, contact optional). */
export type NewGuestInput = {
	name: string;
	email?: string | null;
	phone?: string | null;
};

export interface MinutesMemberRow {
	memberId: string;
	name: string;
	/**
	 * The saved attendance status, or `null` when nobody has recorded one yet —
	 * "unmarked" (#218). Unmarked is the absence of a record, NOT a synonym for
	 * absent: consumers (chips, PDF, exports) must treat it as "not recorded".
	 */
	status: AttendanceStatus | null;
	/**
	 * Holds a role slot on this meeting. Informational only — it does NOT imply
	 * presence and never pre-fills attendance (#218).
	 */
	hasRole: boolean;
}

export interface MinutesGuestRow {
	guestId: string;
	name: string;
	/** Pre-listed because they hold a role slot (vs explicitly added). */
	fromRole: boolean;
}

export interface MinutesTableTopicsRow {
	id: string;
	memberId: string | null;
	guestId: string | null;
	name: string;
	isGuest: boolean;
	topic: string | null;
	sortOrder: number;
}

export interface MinutesAwardRow {
	category: AwardCategory;
	memberId: string | null;
	guestId: string | null;
	/** Resolved winner name, or null when the award is unset. */
	name: string | null;
	isGuest: boolean;
}

export interface MinutesProgramRow {
	slotId: string;
	roleName: string;
	category: string;
	assigneeName: string | null;
	isGuest: boolean;
	speechTitle: string | null;
}

/** The member/guest ids eligible to win one award category (#170). */
export interface AwardEligible {
	memberIds: string[];
	guestIds: string[];
}

export interface MinutesData {
	meetingId: string;
	clubId: string;
	members: MinutesMemberRow[];
	guests: MinutesGuestRow[];
	tableTopicsSpeakers: MinutesTableTopicsRow[];
	awards: MinutesAwardRow[];
	/**
	 * Per-award eligible participants (#170): who actually took that role this
	 * meeting — Best Speaker → speaker-slot holders, Best Evaluator →
	 * evaluator-slot holders, Best Table Topics → the Table Topics speakers. The
	 * award pickers scope to these; empty sets mean "no in-app participants
	 * recorded" and the UI falls back to the full roster.
	 */
	awardEligible: Record<AwardCategory, AwardEligible>;
	counts: {
		present: number;
		absent: number;
		excused: number;
		/** Members with no saved attendance record (#218) — not recorded, not absent. */
		unmarked: number;
		guests: number;
	};
}

/** Resolve the club that owns a meeting (throws when the meeting is gone). */
export async function getMeetingClubId(meetingId: string): Promise<string> {
	const [row] = await db
		.select({ clubId: meetings.clubId })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!row) throw new Error("Meeting not found.");
	return row.clubId;
}

/** The meeting's lifecycle status — drives member read-only visibility. */
export async function getMeetingStatus(
	meetingId: string,
): Promise<"scheduled" | "cancelled" | "completed"> {
	const [row] = await db
		.select({ status: meetings.status })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!row) throw new Error("Meeting not found.");
	return row.status;
}

/**
 * Load a meeting's minutes: the active-member roster each with a presence
 * status (the saved attendance row, or `null` — "unmarked" — when none exists;
 * holding a role slot never infers presence, #218), the present guests
 * (explicitly added or pre-listed from a role slot), the ordered Table Topics
 * speakers, and the three awards. Members who went inactive after being
 * recorded still appear (the saved row is a snapshot).
 */
export async function loadMinutes(meetingId: string): Promise<MinutesData> {
	const clubId = await getMeetingClubId(meetingId);

	// Active roster (the editable attendance list).
	const activeMembers = await db
		.select({ id: members.id, name: members.name })
		.from(members)
		.where(and(eq(members.clubId, clubId), eq(members.status, "active")))
		.orderBy(asc(members.name));

	// Saved member attendance rows (a snapshot — may reference an inactive member).
	const savedMemberRows = await db
		.select({
			memberId: meetingAttendance.memberId,
			status: meetingAttendance.status,
			name: members.name,
		})
		.from(meetingAttendance)
		.innerJoin(members, eq(members.id, meetingAttendance.memberId))
		.where(
			and(
				eq(meetingAttendance.meetingId, meetingId),
				isNotNull(meetingAttendance.memberId),
			),
		);
	const savedByMember = new Map(
		savedMemberRows.map((r) => [r.memberId as string, r]),
	);

	// Role-slot holders on this meeting (member + guest), for the informational
	// `hasRole` flag, the pre-listed guests, and the award eligibility sets (via
	// the role's category — speaker/evaluator). Holding a slot never sets
	// attendance (#218).
	const slotRows = await db
		.select({
			memberId: roleSlots.assignedMemberId,
			guestId: roleSlots.assignedGuestId,
			guestName: guests.name,
			category: roleDefinitions.category,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.leftJoin(guests, eq(guests.id, roleSlots.assignedGuestId))
		.where(eq(roleSlots.meetingId, meetingId));
	const roleMemberIds = new Set(
		slotRows.map((r) => r.memberId).filter((x): x is string => x != null),
	);
	const roleGuests = new Map<string, string>();
	for (const r of slotRows) {
		if (r.guestId) roleGuests.set(r.guestId, r.guestName ?? "Guest");
	}

	// Build the member attendance list: active roster ∪ any snapshotted member.
	const memberRows = new Map<string, MinutesMemberRow>();
	for (const m of activeMembers) {
		const saved = savedByMember.get(m.id);
		memberRows.set(m.id, {
			memberId: m.id,
			name: m.name,
			// No saved record ⇒ unmarked (null). Never inferred from a role slot (#218).
			status: saved?.status ?? null,
			hasRole: roleMemberIds.has(m.id),
		});
	}
	for (const r of savedMemberRows) {
		const id = r.memberId as string;
		if (!memberRows.has(id)) {
			memberRows.set(id, {
				memberId: id,
				name: r.name,
				status: r.status,
				hasRole: roleMemberIds.has(id),
			});
		}
	}
	const memberList = [...memberRows.values()].sort((a, b) =>
		a.name.localeCompare(b.name),
	);

	// Present guests: saved attendance rows ∪ guests holding a role slot.
	const savedGuestRows = await db
		.select({ guestId: meetingAttendance.guestId, name: guests.name })
		.from(meetingAttendance)
		.innerJoin(guests, eq(guests.id, meetingAttendance.guestId))
		.where(
			and(
				eq(meetingAttendance.meetingId, meetingId),
				isNotNull(meetingAttendance.guestId),
			),
		);
	const guestRows = new Map<string, MinutesGuestRow>();
	for (const g of savedGuestRows) {
		guestRows.set(g.guestId as string, {
			guestId: g.guestId as string,
			name: g.name,
			fromRole: false,
		});
	}
	for (const [guestId, name] of roleGuests) {
		if (!guestRows.has(guestId)) {
			guestRows.set(guestId, { guestId, name, fromRole: true });
		}
	}
	const guestList = [...guestRows.values()].sort((a, b) =>
		a.name.localeCompare(b.name),
	);

	// Table Topics speakers (ordered) with resolved member/guest names.
	const ttMember = alias(members, "tt_member");
	const ttGuest = alias(guests, "tt_guest");
	const ttRows = await db
		.select({
			id: tableTopicsSpeakers.id,
			memberId: tableTopicsSpeakers.memberId,
			guestId: tableTopicsSpeakers.guestId,
			name: sql<string | null>`coalesce(${ttMember.name}, ${ttGuest.name})`,
			topic: tableTopicsSpeakers.topic,
			sortOrder: tableTopicsSpeakers.sortOrder,
		})
		.from(tableTopicsSpeakers)
		.leftJoin(ttMember, eq(ttMember.id, tableTopicsSpeakers.memberId))
		.leftJoin(ttGuest, eq(ttGuest.id, tableTopicsSpeakers.guestId))
		.where(eq(tableTopicsSpeakers.meetingId, meetingId))
		.orderBy(asc(tableTopicsSpeakers.sortOrder), asc(tableTopicsSpeakers.id));
	const ttList: MinutesTableTopicsRow[] = ttRows.map((r) => ({
		id: r.id,
		memberId: r.memberId,
		guestId: r.guestId,
		name: r.name ?? "Unknown",
		isGuest: r.guestId != null,
		topic: r.topic,
		sortOrder: r.sortOrder,
	}));

	// Awards — always return all three categories, unset ones with name: null.
	const awMember = alias(members, "aw_member");
	const awGuest = alias(guests, "aw_guest");
	const awRows = await db
		.select({
			category: meetingAwards.category,
			memberId: meetingAwards.memberId,
			guestId: meetingAwards.guestId,
			name: sql<string | null>`coalesce(${awMember.name}, ${awGuest.name})`,
		})
		.from(meetingAwards)
		.leftJoin(awMember, eq(awMember.id, meetingAwards.memberId))
		.leftJoin(awGuest, eq(awGuest.id, meetingAwards.guestId))
		.where(eq(meetingAwards.meetingId, meetingId));
	const awByCategory = new Map(awRows.map((r) => [r.category, r]));
	const awardList: MinutesAwardRow[] = AWARD_CATEGORIES.map((category) => {
		const row = awByCategory.get(category);
		return {
			category,
			memberId: row?.memberId ?? null,
			guestId: row?.guestId ?? null,
			name: row?.name ?? null,
			isGuest: row?.guestId != null,
		};
	});

	// Award eligibility (#170): speaker/evaluator sets come from role slots by
	// category; Table Topics from the recorded speakers. De-duped (a member may
	// hold two speaker slots) and insertion-ordered.
	const speakerMemberIds = new Set<string>();
	const speakerGuestIds = new Set<string>();
	const evaluatorMemberIds = new Set<string>();
	const evaluatorGuestIds = new Set<string>();
	for (const r of slotRows) {
		if (r.category === "speaker") {
			if (r.memberId) speakerMemberIds.add(r.memberId);
			if (r.guestId) speakerGuestIds.add(r.guestId);
		} else if (r.category === "evaluator") {
			if (r.memberId) evaluatorMemberIds.add(r.memberId);
			if (r.guestId) evaluatorGuestIds.add(r.guestId);
		}
	}
	const ttMemberIds = new Set<string>();
	const ttGuestIds = new Set<string>();
	for (const t of ttList) {
		if (t.memberId) ttMemberIds.add(t.memberId);
		if (t.guestId) ttGuestIds.add(t.guestId);
	}
	const awardEligible: Record<AwardCategory, AwardEligible> = {
		best_speaker: {
			memberIds: [...speakerMemberIds],
			guestIds: [...speakerGuestIds],
		},
		best_evaluator: {
			memberIds: [...evaluatorMemberIds],
			guestIds: [...evaluatorGuestIds],
		},
		best_table_topics: {
			memberIds: [...ttMemberIds],
			guestIds: [...ttGuestIds],
		},
	};

	let present = 0;
	let absent = 0;
	let excused = 0;
	let unmarked = 0;
	for (const m of memberList) {
		if (m.status === "present") present++;
		else if (m.status === "excused") excused++;
		else if (m.status === "absent") absent++;
		else unmarked++;
	}

	return {
		meetingId,
		clubId,
		members: memberList,
		guests: guestList,
		tableTopicsSpeakers: ttList,
		awards: awardList,
		awardEligible,
		counts: { present, absent, excused, unmarked, guests: guestList.length },
	};
}

/** The compact program (roles + speeches, summary-level) for the PDF. */
export async function loadMinutesProgram(
	meetingId: string,
): Promise<MinutesProgramRow[]> {
	const assignee = alias(members, "program_member");
	const guestAssignee = alias(guests, "program_guest");
	const rows = await db
		.select({
			slotId: roleSlots.id,
			roleName: roleDefinitions.name,
			category: roleDefinitions.category,
			assigneeName: sql<
				string | null
			>`coalesce(${assignee.name}, ${guestAssignee.name})`,
			guestId: guestAssignee.id,
			speechTitle: speeches.title,
			sortOrder: roleDefinitions.sortOrder,
			slotIndex: roleSlots.slotIndex,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.leftJoin(assignee, eq(assignee.id, roleSlots.assignedMemberId))
		.leftJoin(guestAssignee, eq(guestAssignee.id, roleSlots.assignedGuestId))
		.leftJoin(speeches, eq(speeches.id, roleSlots.speechId))
		.where(eq(roleSlots.meetingId, meetingId))
		.orderBy(asc(roleDefinitions.sortOrder), asc(roleSlots.slotIndex));
	return rows.map((r) => ({
		slotId: r.slotId,
		roleName: r.roleName,
		category: r.category,
		assigneeName: r.assigneeName,
		isGuest: r.guestId != null,
		speechTitle: r.speechTitle,
	}));
}

// ---------------------------------------------------------------------------
// Mutations. Each trusts the caller's admin gate; they only validate that the
// referenced member/guest is scoped to the meeting's club.
// ---------------------------------------------------------------------------

// Accepts either the main db client or a drizzle transaction (mirrors activity.ts).
type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * Resolve or create a guest scoped to `clubId` (mirrors guests-logic).
 *
 * `newGuestId` (optional, #176 slice 2) lets a caller supply the primary key for
 * the NEW guest row so an offline create can be replayed idempotently: the insert
 * uses that id with `onConflictDoNothing`, and a conflict (row already created by
 * a prior replay) returns the same id instead of throwing. It is threaded from
 * `addGuestPresent` only — it is deliberately kept OUT of the shared `input` so a
 * caller's own row id (e.g. a Table Topics speaker's id) can never leak into the
 * guest's id.
 */
async function resolveGuestId(
	tx: DbOrTx,
	clubId: string,
	input: { guestId?: string | null; newGuest?: NewGuestInput },
	newGuestId?: string,
): Promise<string> {
	if (input.newGuest) {
		const name = input.newGuest.name.trim();
		if (!name) throw new Error("A guest name is required.");
		const [created] = await tx
			.insert(guests)
			.values({
				...(newGuestId ? { id: newGuestId } : {}),
				clubId,
				name,
				email: input.newGuest.email?.trim() || null,
				phone: input.newGuest.phone?.trim() || null,
			})
			.onConflictDoNothing({ target: guests.id })
			.returning({ id: guests.id });
		if (created) return created.id;
		// Conflict on the client-supplied id → the guest already exists from a
		// prior replay; the create is idempotent, so return that same id.
		if (newGuestId) return newGuestId;
		throw new Error("Failed to create guest.");
	}
	if (input.guestId) {
		const [existing] = await tx
			.select({ id: guests.id })
			.from(guests)
			.where(and(eq(guests.id, input.guestId), eq(guests.clubId, clubId)))
			.limit(1);
		if (!existing) throw new Error("Guest not found in this club.");
		return existing.id;
	}
	throw new Error("Provide a guest to add.");
}

/** Validate a member belongs to the meeting's club. */
async function requireMemberInMeetingClub(memberId: string, clubId: string) {
	const [row] = await db
		.select({ id: members.id })
		.from(members)
		.where(and(eq(members.id, memberId), eq(members.clubId, clubId)))
		.limit(1);
	if (!row) throw new Error("Member not found in this club.");
}

/** Set (upsert) a member's presence for a meeting. */
export async function setMemberPresence(input: {
	meetingId: string;
	memberId: string;
	status: AttendanceStatus;
}): Promise<void> {
	const clubId = await getMeetingClubId(input.meetingId);
	await requireMemberInMeetingClub(input.memberId, clubId);
	await db
		.insert(meetingAttendance)
		.values({
			meetingId: input.meetingId,
			memberId: input.memberId,
			status: input.status,
		})
		.onConflictDoUpdate({
			target: [meetingAttendance.meetingId, meetingAttendance.memberId],
			set: { status: input.status, updatedAt: new Date() },
		});
}

/**
 * Add a present guest (existing club guest or a new one). Idempotent per guest.
 *
 * `id` (optional, #176 slice 2) is the client-supplied primary key for a NEW
 * guest row (the new-guest path only — ignored when an existing `guestId` is
 * passed). It makes a replayed offline create a stable no-op: the guest insert is
 * `onConflictDoNothing` and the attendance insert already is, so re-running the
 * whole op returns the same `guestId` without duplicating either row.
 */
export async function addGuestPresent(input: {
	meetingId: string;
	id?: string;
	guestId?: string | null;
	newGuest?: NewGuestInput;
}): Promise<{ guestId: string }> {
	const clubId = await getMeetingClubId(input.meetingId);
	return db.transaction(async (tx) => {
		const guestId = await resolveGuestId(tx, clubId, input, input.id);
		await tx
			.insert(meetingAttendance)
			.values({ meetingId: input.meetingId, guestId, status: "present" })
			.onConflictDoNothing({
				target: [meetingAttendance.meetingId, meetingAttendance.guestId],
			});
		return { guestId };
	});
}

/** Remove a present guest's attendance row (does not delete the club guest). */
export async function removeGuestPresent(input: {
	meetingId: string;
	guestId: string;
}): Promise<void> {
	await db
		.delete(meetingAttendance)
		.where(
			and(
				eq(meetingAttendance.meetingId, input.meetingId),
				eq(meetingAttendance.guestId, input.guestId),
			),
		);
}

/**
 * Append a Table Topics speaker (member or guest) with an optional topic.
 *
 * `id` (optional, #176 slice 2) is the client-supplied primary key for the new
 * `table_topics_speakers` row — the stable target that later `remove`/`move` ops
 * reference. The insert uses it with `onConflictDoNothing`, so replaying the same
 * offline create is a no-op that still returns the same id (no duplicate row, no
 * throw). Note: the id names the SPEAKER row only; a new inline guest is NOT given
 * this id (the queue mints/creates guests as their own op via `addGuestPresent`).
 */
export async function addTableTopicsSpeaker(input: {
	meetingId: string;
	id?: string;
	memberId?: string | null;
	guestId?: string | null;
	newGuest?: NewGuestInput;
	topic?: string | null;
}): Promise<{ id: string }> {
	const clubId = await getMeetingClubId(input.meetingId);
	return db.transaction(async (tx) => {
		let memberId: string | null = null;
		let guestId: string | null = null;
		if (input.memberId) {
			await requireMemberInMeetingClub(input.memberId, clubId);
			memberId = input.memberId;
		} else if (input.guestId || input.newGuest) {
			guestId = await resolveGuestId(tx, clubId, input);
		} else {
			throw new Error("Provide a member or guest speaker.");
		}
		const [{ next } = { next: 0 }] = await tx
			.select({
				next: sql<number>`coalesce(max(${tableTopicsSpeakers.sortOrder}) + 1, 0)`,
			})
			.from(tableTopicsSpeakers)
			.where(eq(tableTopicsSpeakers.meetingId, input.meetingId));
		const [created] = await tx
			.insert(tableTopicsSpeakers)
			.values({
				...(input.id ? { id: input.id } : {}),
				meetingId: input.meetingId,
				memberId,
				guestId,
				topic: input.topic?.trim() || null,
				sortOrder: next,
			})
			.onConflictDoNothing({ target: tableTopicsSpeakers.id })
			.returning({ id: tableTopicsSpeakers.id });
		if (created) return { id: created.id };
		// Conflict on the client-supplied id → the speaker row already exists from
		// a prior replay; the create is idempotent, so return that same id.
		if (input.id) return { id: input.id };
		throw new Error("Failed to add speaker.");
	});
}

/** Remove a Table Topics speaker by id (scoped to the meeting). */
export async function removeTableTopicsSpeaker(input: {
	meetingId: string;
	id: string;
}): Promise<void> {
	await db
		.delete(tableTopicsSpeakers)
		.where(
			and(
				eq(tableTopicsSpeakers.id, input.id),
				eq(tableTopicsSpeakers.meetingId, input.meetingId),
			),
		);
}

/** Move a Table Topics speaker up/down by swapping sortOrder with its neighbour. */
export async function moveTableTopicsSpeaker(input: {
	meetingId: string;
	id: string;
	direction: "up" | "down";
}): Promise<void> {
	await db.transaction(async (tx) => {
		const ordered = await tx
			.select({
				id: tableTopicsSpeakers.id,
				sortOrder: tableTopicsSpeakers.sortOrder,
			})
			.from(tableTopicsSpeakers)
			.where(eq(tableTopicsSpeakers.meetingId, input.meetingId))
			.orderBy(asc(tableTopicsSpeakers.sortOrder), asc(tableTopicsSpeakers.id));
		const idx = ordered.findIndex((r) => r.id === input.id);
		if (idx === -1) throw new Error("Speaker not found.");
		const swapIdx = input.direction === "up" ? idx - 1 : idx + 1;
		if (swapIdx < 0 || swapIdx >= ordered.length) return; // at the edge — no-op
		const a = ordered[idx];
		const b = ordered[swapIdx];
		// Normalize to positional order first so equal/duplicate sortOrders still swap.
		await tx
			.update(tableTopicsSpeakers)
			.set({ sortOrder: swapIdx })
			.where(eq(tableTopicsSpeakers.id, a.id));
		await tx
			.update(tableTopicsSpeakers)
			.set({ sortOrder: idx })
			.where(eq(tableTopicsSpeakers.id, b.id));
	});
}

/** Set (upsert) an award winner (member or guest) for a category. */
export async function setAward(input: {
	meetingId: string;
	category: AwardCategory;
	memberId?: string | null;
	guestId?: string | null;
	newGuest?: NewGuestInput;
}): Promise<void> {
	const clubId = await getMeetingClubId(input.meetingId);
	await db.transaction(async (tx) => {
		let memberId: string | null = null;
		let guestId: string | null = null;
		if (input.memberId) {
			await requireMemberInMeetingClub(input.memberId, clubId);
			memberId = input.memberId;
		} else if (input.guestId || input.newGuest) {
			guestId = await resolveGuestId(tx, clubId, input);
		} else {
			throw new Error("Provide a member or guest for the award.");
		}
		await tx
			.insert(meetingAwards)
			.values({
				meetingId: input.meetingId,
				category: input.category,
				memberId,
				guestId,
			})
			.onConflictDoUpdate({
				target: [meetingAwards.meetingId, meetingAwards.category],
				set: { memberId, guestId, updatedAt: new Date() },
			});
	});
}

/** Clear an award category for a meeting. */
export async function clearAward(input: {
	meetingId: string;
	category: AwardCategory;
}): Promise<void> {
	await db
		.delete(meetingAwards)
		.where(
			and(
				eq(meetingAwards.meetingId, input.meetingId),
				eq(meetingAwards.category, input.category),
			),
		);
}
