// VP Education reporting DB logic, split out from the `createServerFn` wrappers
// in `reporting.ts` (which the server-modules guard forbids from exporting
// db-touching functions). Directly integration-testable by mocking `#/db`.
//
// Every query here runs over EXISTING tables (ADR-0005 "no new tables"): the
// speaker queue, overdue list, and per-member Pathways surface are all derived
// from `role_slots` joined to `meetings` / `role_definitions` / `members` /
// `speeches`. No schema changes.
import { and, asc, eq, inArray, lt, max, ne, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";

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
