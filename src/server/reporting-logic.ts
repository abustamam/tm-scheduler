// VP Education reporting DB logic, split out from the `createServerFn` wrappers
// in `reporting.ts` (which the server-modules guard forbids from exporting
// db-touching functions). Directly integration-testable by mocking `#/db`.
//
// Every query here runs over EXISTING tables (ADR-0005 "no new tables"): the
// speaker queue, overdue list, and per-member Pathways surface are all derived
// from `role_slots` joined to `meetings` / `role_definitions` / `members` /
// `speeches`. No schema changes.
import {
	and,
	asc,
	desc,
	eq,
	inArray,
	isNotNull,
	lt,
	max,
	ne,
	sql,
} from "drizzle-orm";
import { db } from "#/db";
import {
	meetingAttendance,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import {
	ATTENDANCE_LAPSE,
	type AttendanceLapseRow,
	scoreAttendanceLapse,
} from "#/lib/attendance-lapse";

/** A slot only counts as "held" once it's claimed or confirmed. */
const HELD_SLOT_STATUSES = ["claimed", "confirmed"] as const;

/** Default "overdue" window: no role of any kind in this many days. */
export const DEFAULT_OVERDUE_DAYS = 60;

type ClubRole = (typeof members.$inferSelect)["clubRole"];

export interface SpeakerRotationRow {
	memberId: string;
	name: string;
	clubRole: ClubRole;
	/** Speaker slots held in past, non-cancelled meetings. */
	timesSpoken: number;
	/** Most recent past speaker slot's meeting date, or null if never spoken. */
	lastSpokenAt: Date | null;
	joinedAt: Date | null;
	// Issue #9 — the member's latest known Pathways path/project (from the most
	// recent speaker slot that has a speech attached; null when unknown). The
	// full Base Camp progress lives on the member detail page this row links to.
	latestPathwayPath: string | null;
	latestProjectName: string | null;
	latestProjectLevel: string | null;
}

export interface OverdueMemberRow {
	memberId: string;
	name: string;
	clubRole: ClubRole;
	joinedAt: Date | null;
	/** Most recent past role (any category) meeting date, or null if never. */
	lastAnyRoleAt: Date | null;
	/** Whole days since the last role; null when the member has never held one. */
	daysSinceLastRole: number | null;
	isOverdue: boolean;
}

/**
 * Speaker queue / rotation for a club: every active member ranked by how
 * recently they held a **speaker** role, never-spoken members first.
 *
 * The speaker filter (`is_speaker_role = true`) and the past/non-cancelled
 * meeting filter live inside a pre-aggregated subquery that members LEFT JOIN
 * onto. This is the fix for the bug the spike flagged: putting those predicates
 * directly in a chained LEFT JOIN's ON clause silently pulls in non-speaker
 * slots. Aggregating first, then left-joining, keeps them as true filters.
 */
export async function loadSpeakerRotation(
	clubId: string,
): Promise<SpeakerRotationRow[]> {
	const now = new Date();

	const speakerStats = db
		.select({
			memberId: roleSlots.assignedMemberId,
			timesSpoken: sql<number>`count(${roleSlots.id})::int`.as("times_spoken"),
			lastSpokenAt: max(meetings.scheduledAt).as("last_spoken_at"),
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			and(
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
				eq(roleDefinitions.isSpeakerRole, true),
			),
		)
		.innerJoin(
			meetings,
			and(
				eq(meetings.id, roleSlots.meetingId),
				lt(meetings.scheduledAt, now),
				ne(meetings.status, "cancelled"),
			),
		)
		.where(inArray(roleSlots.status, [...HELD_SLOT_STATUSES]))
		.groupBy(roleSlots.assignedMemberId)
		.as("speaker_stats");

	const rows = await db
		.select({
			memberId: members.id,
			name: members.name,
			clubRole: members.clubRole,
			joinedAt: members.joinedAt,
			timesSpoken: sql<number>`coalesce(${speakerStats.timesSpoken}, 0)`,
			lastSpokenAt: speakerStats.lastSpokenAt,
		})
		.from(members)
		.leftJoin(speakerStats, eq(speakerStats.memberId, members.id))
		.where(and(eq(members.clubId, clubId), eq(members.status, "active")))
		.orderBy(
			sql`${speakerStats.lastSpokenAt} asc nulls first`,
			asc(members.name),
		);

	const latest = await loadLatestSpeechByMember(clubId);

	return rows.map((r) => {
		const speech = latest.get(r.memberId);
		return {
			memberId: r.memberId,
			name: r.name,
			clubRole: r.clubRole,
			joinedAt: r.joinedAt,
			timesSpoken: Number(r.timesSpoken),
			lastSpokenAt: r.lastSpokenAt,
			latestPathwayPath: speech?.pathwayPath ?? null,
			latestProjectName: speech?.projectName ?? null,
			latestProjectLevel: speech?.projectLevel ?? null,
		};
	});
}

interface LatestSpeech {
	pathwayPath: string | null;
	projectName: string | null;
	projectLevel: string | null;
}

/**
 * Per member, the Pathways fields from their most recent speaker slot that has
 * a speech attached (across all non-cancelled meetings — past or upcoming — so
 * the surfaced path reflects what they're currently working on). Rows arrive
 * newest-first; the first seen per member wins.
 */
async function loadLatestSpeechByMember(
	clubId: string,
): Promise<Map<string, LatestSpeech>> {
	const rows = await db
		.select({
			memberId: roleSlots.assignedMemberId,
			pathwayPath: speeches.pathwayPath,
			projectName: speeches.projectName,
			projectLevel: speeches.projectLevel,
		})
		.from(roleSlots)
		.innerJoin(speeches, eq(speeches.id, roleSlots.speechId))
		.innerJoin(
			meetings,
			and(
				eq(meetings.id, roleSlots.meetingId),
				ne(meetings.status, "cancelled"),
			),
		)
		.innerJoin(members, eq(members.id, roleSlots.assignedMemberId))
		.where(
			and(
				eq(members.clubId, clubId),
				inArray(roleSlots.status, [...HELD_SLOT_STATUSES]),
			),
		)
		.orderBy(sql`${meetings.scheduledAt} desc`);

	const map = new Map<string, LatestSpeech>();
	for (const r of rows) {
		if (!r.memberId || map.has(r.memberId)) continue;
		map.set(r.memberId, {
			pathwayPath: r.pathwayPath,
			projectName: r.projectName,
			projectLevel: r.projectLevel,
		});
	}
	return map;
}

/**
 * Overdue members for a club: every active member, oldest-participation-first,
 * with an `isOverdue` flag for anyone who has held **no role of any kind**
 * (speaker or functionary) in the last `thresholdDays` days — or never. The
 * separate speaker-rotation view already answers "hasn't spoken recently", so
 * overdue is deliberately about total disengagement.
 */
export async function loadOverdueMembers(
	clubId: string,
	thresholdDays: number = DEFAULT_OVERDUE_DAYS,
): Promise<OverdueMemberRow[]> {
	const now = new Date();

	const roleStats = db
		.select({
			memberId: roleSlots.assignedMemberId,
			lastAnyRoleAt: max(meetings.scheduledAt).as("last_any_role_at"),
		})
		.from(roleSlots)
		.innerJoin(
			meetings,
			and(
				eq(meetings.id, roleSlots.meetingId),
				lt(meetings.scheduledAt, now),
				ne(meetings.status, "cancelled"),
			),
		)
		.where(inArray(roleSlots.status, [...HELD_SLOT_STATUSES]))
		.groupBy(roleSlots.assignedMemberId)
		.as("role_stats");

	const rows = await db
		.select({
			memberId: members.id,
			name: members.name,
			clubRole: members.clubRole,
			joinedAt: members.joinedAt,
			lastAnyRoleAt: roleStats.lastAnyRoleAt,
		})
		.from(members)
		.leftJoin(roleStats, eq(roleStats.memberId, members.id))
		.where(and(eq(members.clubId, clubId), eq(members.status, "active")))
		.orderBy(
			sql`${roleStats.lastAnyRoleAt} asc nulls first`,
			asc(members.name),
		);

	return rows.map((r) => {
		const daysSinceLastRole = r.lastAnyRoleAt
			? Math.floor((now.getTime() - r.lastAnyRoleAt.getTime()) / 86_400_000)
			: null;
		const isOverdue =
			daysSinceLastRole === null || daysSinceLastRole > thresholdDays;
		return {
			memberId: r.memberId,
			name: r.name,
			clubRole: r.clubRole,
			joinedAt: r.joinedAt,
			lastAnyRoleAt: r.lastAnyRoleAt,
			daysSinceLastRole,
			isOverdue,
		};
	});
}

/**
 * Attendance lapse for a club (#530) — who has stopped turning up.
 *
 * This complements `loadOverdueMembers` rather than duplicating it, and the
 * distinction is the point of the feature: "overdue for a role" cannot tell a
 * member who attends every week but never volunteers from one who has stopped
 * coming altogether. Both simply have no claimed role. Attendance is the only
 * signal that separates a nudge-to-volunteer from a retention risk.
 *
 * SQL owns the window; `scoreAttendanceLapse` (pure, client-safe) owns the
 * maths. A meeting joins the window when it is in the past, not cancelled, and
 * somebody actually took the register — that last clause is what stops a
 * meeting nobody recorded reading as a club-wide absence.
 *
 * "Past and not cancelled" deliberately matches `loadOverdueMembers`,
 * `loadSpeakerRotation` and `loadPastMeetings` rather than testing for
 * `status = 'completed'`. A club that takes attendance but never formally
 * closes meetings out would otherwise have a permanently empty window and a
 * feature that silently does nothing.
 */
export async function loadAttendanceLapse(
	clubId: string,
): Promise<AttendanceLapseRow[]> {
	const now = new Date();

	// DISTINCT over the join: a meeting qualifies once it has any MEMBER
	// attendance row, and the join would otherwise repeat it per attendee —
	// which at real club size (15-25 marked per meeting) would let one meeting
	// eat the whole LIMIT and collapse the window.
	//
	// `isNotNull(memberId)` is load-bearing, not tidiness. Guest attendance rows
	// carry a NULL member_id (ADR-0013), so a meeting where only VISITORS were
	// logged would otherwise satisfy this join, enter the window, and score
	// every member as not-present — a false "stopped attending" flag on the one
	// surface whose whole job is spotting people who quietly left.
	const windowMeetings = await db
		.selectDistinct({
			meetingId: meetings.id,
			scheduledAt: meetings.scheduledAt,
		})
		.from(meetings)
		.innerJoin(
			meetingAttendance,
			and(
				eq(meetingAttendance.meetingId, meetings.id),
				isNotNull(meetingAttendance.memberId),
			),
		)
		.where(
			and(
				eq(meetings.clubId, clubId),
				lt(meetings.scheduledAt, now),
				ne(meetings.status, "cancelled"),
			),
		)
		.orderBy(desc(meetings.scheduledAt))
		.limit(ATTENDANCE_LAPSE.windowMeetings);

	// No early return when the window is empty. Drizzle compiles an empty
	// `inArray` to `false`, so the mark query returns nothing either way and a
	// short-circuit guard would produce an identical result — making it
	// impossible to write a test that fails when the guard is deleted. One
	// cheap round-trip is worth more than an unfalsifiable branch.
	const [memberRows, markRows] = await Promise.all([
		db
			.select({
				memberId: members.id,
				name: members.name,
				joinedAt: members.joinedAt,
				createdAt: members.createdAt,
			})
			.from(members)
			.where(and(eq(members.clubId, clubId), eq(members.status, "active")))
			.orderBy(asc(members.name)),
		db
			.select({
				meetingId: meetingAttendance.meetingId,
				memberId: meetingAttendance.memberId,
				status: meetingAttendance.status,
			})
			.from(meetingAttendance)
			.where(
				inArray(
					meetingAttendance.meetingId,
					windowMeetings.map((m) => m.meetingId),
				),
			),
	]);

	// Holding a role at a meeting counts as being there. #218 deliberately
	// decoupled the two — claiming a slot never writes an attendance row — so a
	// member who RAN the meeting as Toastmaster has no record of presence and
	// would read as "never recorded present" while the Overdue-for-a-role panel
	// directly below correctly shows them as engaged. Two adjacent panels
	// contradicting each other, with this one wrong. An explicit attendance row
	// still wins: if somebody marked them absent, that is a human statement and
	// beats the inference.
	const roleRows = await db
		.select({
			meetingId: roleSlots.meetingId,
			memberId: roleSlots.assignedMemberId,
		})
		.from(roleSlots)
		.where(
			and(
				inArray(
					roleSlots.meetingId,
					windowMeetings.map((m) => m.meetingId),
				),
				inArray(roleSlots.status, [...HELD_SLOT_STATUSES]),
				isNotNull(roleSlots.assignedMemberId),
			),
		);

	// Guest attendance rows carry a null `member_id` and are dropped here —
	// a guest's presence is not a member's.
	const explicit = markRows.flatMap((r) =>
		r.memberId
			? [{ meetingId: r.meetingId, memberId: r.memberId, status: r.status }]
			: [],
	);
	const explicitKeys = new Set(
		explicit.map((m) => `${m.meetingId}:${m.memberId}`),
	);
	const fromRoles = roleRows.flatMap((r) =>
		r.memberId && !explicitKeys.has(`${r.meetingId}:${r.memberId}`)
			? [
					{
						meetingId: r.meetingId,
						memberId: r.memberId,
						status: "present" as const,
					},
				]
			: [],
	);

	return scoreAttendanceLapse({
		meetings: windowMeetings,
		// `joined_at` is populated ONLY by the Toastmasters CSV import — every
		// member added through the app has it NULL. Treating NULL as "has always
		// been here" flagged a brand-new member as having missed the whole window
		// on the day they were added. `created_at` is the same fallback the roster
		// and the member profile already display.
		members: memberRows.map((m) => ({
			memberId: m.memberId,
			name: m.name,
			joinedAt: m.joinedAt ?? m.createdAt,
		})),
		marks: [...explicit, ...fromRoles],
	});
}
