// The signed-in user's own cross-club views: speech history and upcoming
// commitments (#437).
//
// Both used to resolve the user by taking whatever single roster member a
// `where(eq(people.userId, …))` join returned first. `people.user_id` is not
// unique (ADR-0008 / #329 — duplicates predate dedupe-on-write and the merge is
// a manual superadmin step), so that pick was arbitrary AND single-club, while
// both callers documented themselves as covering every club the user belongs
// to. A two-club member saw one club's data, and which one could change between
// requests. Resolving through `userMemberIds` fixes both halves at once.
//
// Lives in a `*-logic.ts` (not a createServerFn module) so it is integration-
// testable against a test db and never reaches the client bundle — see
// CLAUDE.md "Data layer". The createServerFn wrappers stay in `club.ts`
// (`listMySpeeches`) and `meetings.ts` (`listMyCommitments`).
import { and, asc, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "#/db";
import {
	clubs,
	meetings,
	members,
	pathwaysProjects,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import { userMemberIds } from "./person-identity-logic";

export interface SpeechLogRow {
	slotId: string;
	scheduledAt: Date;
	roleName: string;
	speechTitle: string | null;
	projectName: string | null;
	pathwayPath: string | null;
	projectLevel: string | null;
	evaluatorName: string | null;
	status: "open" | "claimed" | "confirmed";
}

/**
 * Speaker-slot history for a set of roster members (most recent first), with
 * the evaluator resolved.
 *
 * Takes member IDs rather than one ID because the same human can hold a
 * membership in several clubs; `clubId` narrows to one club's meetings when the
 * caller is a club-scoped surface, and is null for the cross-club personal log.
 * Empty input short-circuits — an `inArray` over an empty list is not valid SQL
 * in every dialect and there is nothing to ask for anyway.
 */
export async function loadSpeechLog(
	memberIds: string[],
	clubId: string | null,
	limit: number,
): Promise<SpeechLogRow[]> {
	if (memberIds.length === 0) return [];

	const evaluatorSlot = alias(roleSlots, "evaluator_slot");
	const evaluatorMember = alias(members, "evaluator_member");

	return (
		db
			.select({
				slotId: roleSlots.id,
				scheduledAt: meetings.scheduledAt,
				roleName: roleDefinitions.name,
				speechTitle: speeches.title,
				projectName: speeches.projectName,
				pathwayPath: speeches.pathwayPath,
				projectLevel: speeches.projectLevel,
				evaluatorName: evaluatorMember.name,
				status: roleSlots.status,
			})
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.leftJoin(speeches, eq(speeches.id, roleSlots.speechId))
			.leftJoin(evaluatorSlot, eq(evaluatorSlot.evaluatesSlotId, roleSlots.id))
			.leftJoin(
				evaluatorMember,
				eq(evaluatorMember.id, evaluatorSlot.assignedMemberId),
			)
			.where(
				and(
					inArray(roleSlots.assignedMemberId, memberIds),
					eq(roleDefinitions.isSpeakerRole, true),
					clubId ? eq(meetings.clubId, clubId) : undefined,
				),
			)
			// `roleSlots.id` breaks ties: two meetings sharing a `scheduled_at` (two
			// clubs on one night, or a duplicated/rescheduled meeting) otherwise made
			// the `limit` window's MEMBERSHIP arbitrary — a row could enter or leave
			// the dashboard between loader runs. That is the same nondeterminism
			// class #437 exists to remove.
			.orderBy(desc(meetings.scheduledAt), desc(roleSlots.id))
			.limit(limit)
	);
}

/**
 * The signed-in user's recent speech history across EVERY club they belong to.
 * Backs the dashboard speech log. No linked membership ⇒ empty log.
 */
export async function loadMySpeechLog(
	userId: string,
	limit: number,
): Promise<SpeechLogRow[]> {
	return loadSpeechLog(await userMemberIds(userId), null, limit);
}

/**
 * The signed-in user's upcoming claimed roles across EVERY club they belong to,
 * soonest first. Cancelled meetings are excluded; past ones fall off by date.
 *
 * Soft-archived clubs are excluded (#560). Each row carries `clubName` plus the
 * meeting's date, theme, location and speech title, which is the same payload the
 * PUBLIC sibling `listMemberCommitments` was gated for in #544 — this authed twin
 * kept serving it on `/dashboard` and `/me`, so a member of one live and one
 * archived club saw the taken-down club's name and agenda details with no tooling.
 * `loadMySpeechLog` beside it joins no `clubs` row and carries no club identity, so
 * it is deliberately left alone.
 */
export async function loadMyCommitments(userId: string) {
	const memberIds = await userMemberIds(userId);
	if (memberIds.length === 0) return [];

	// The member holding THIS row may be the evaluator, not the speaker — the
	// resource they need is the project of the speech they are EVALUATING, not
	// their own (which is usually absent). `evaluatesSlotId` points at the
	// speaker's slot; these aliases walk that self-join back to a project name,
	// entirely on the one statement below (no per-row resolution — see the
	// query-count guard in `my-commitments-query.integration.test.ts`).
	const speakerSlot = alias(roleSlots, "speaker_slot");
	const evaluatedSpeech = alias(speeches, "evaluated_speech");
	const evaluatedProject = alias(pathwaysProjects, "evaluated_project");
	const ownProject = alias(pathwaysProjects, "own_project");

	return (
		db
			.select({
				slotId: roleSlots.id,
				status: roleSlots.status,
				meetingId: meetings.id,
				scheduledAt: meetings.scheduledAt,
				lengthMinutes: meetings.lengthMinutes,
				theme: meetings.theme,
				location: meetings.location,
				clubName: clubs.name,
				timezone: clubs.timezone,
				roleName: roleDefinitions.name,
				isSpeakerRole: roleDefinitions.isSpeakerRole,
				// Who the evaluation resource is FOR. The card shows it only to a
				// speaker or an evaluator: every other row is a functionary (Timer,
				// Ah-Counter, Grammarian…), which is most of an agenda, and none of
				// them fills in an evaluation form. Both columns come off tables this
				// statement ALREADY joins — no new join, so `loadMyCommitments` stays
				// one statement and `my-commitments-query.integration.test.ts` still
				// holds. `evaluatesSlotId` is the identity of the evaluator arm (a
				// club may name the role anything); `category` catches an evaluator
				// slot not yet pointed at a speaker.
				evaluatesSlotId: roleSlots.evaluatesSlotId,
				roleCategory: roleDefinitions.category,
				speechTitle: speeches.title,
				// The evaluator's target: this slot evaluates `speakerSlot`, whose
				// speech carries the project. `projectId` (catalog) wins over the
				// free-text `projectName`, which predates the catalog.
				evaluatedProjectName: sql<string | null>`
					coalesce(${evaluatedProject.name}, ${evaluatedSpeech.projectName})
				`,
				ownProjectName: sql<string | null>`
					coalesce(${ownProject.name}, ${speeches.projectName})
				`,
			})
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.innerJoin(clubs, eq(clubs.id, meetings.clubId))
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.leftJoin(speeches, eq(speeches.id, roleSlots.speechId))
			.leftJoin(ownProject, eq(ownProject.id, speeches.projectId))
			.leftJoin(speakerSlot, eq(speakerSlot.id, roleSlots.evaluatesSlotId))
			.leftJoin(evaluatedSpeech, eq(evaluatedSpeech.id, speakerSlot.speechId))
			.leftJoin(
				evaluatedProject,
				eq(evaluatedProject.id, evaluatedSpeech.projectId),
			)
			.where(
				and(
					inArray(roleSlots.assignedMemberId, memberIds),
					gte(meetings.scheduledAt, new Date()),
					ne(meetings.status, "cancelled"),
					isNull(clubs.archivedAt),
				),
			)
			// Tiebreaker as above — a tie reordering an unlabelled list is how a
			// wrong Release click happens.
			.orderBy(asc(meetings.scheduledAt), asc(roleSlots.id))
	);
}
