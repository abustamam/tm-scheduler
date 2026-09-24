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
	guests,
	meetings,
	members,
	pathwaysProjects,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import { userMemberIds } from "./person-identity-logic";

/**
 * One HELD evaluator of a speech (#681). Member or guest: an evaluator slot is
 * held by one or the other (`role_slots_single_assignee`), and a guest
 * evaluator used to vanish from the log because only `members` was joined.
 */
export interface SpeechLogEvaluator {
	name: string;
	isGuest: boolean;
}

export interface SpeechLogRow {
	slotId: string;
	scheduledAt: Date;
	roleName: string;
	speechTitle: string | null;
	projectName: string | null;
	pathwayPath: string | null;
	projectLevel: string | null;
	/** Held evaluators of this speech, member or guest, ordered by name. */
	evaluators: SpeechLogEvaluator[];
	/** True when at least one evaluator slot points at this speech, held or not. */
	hasEvaluatorSlot: boolean;
	status: "open" | "claimed" | "confirmed";
}

export interface SpeechLog {
	rows: SpeechLogRow[];
	/** More speeches exist beyond `limit`. Always false when `limit` is null. */
	truncated: boolean;
}

/**
 * The slot statuses that mean someone actually HOLDS the evaluator slot. An
 * `open` slot with a stale assignee is not an evaluator; it only proves the
 * speech HAS an evaluator slot (`hasEvaluatorSlot`), which is what lets an
 * upcoming speech say "Evaluator not yet assigned".
 */
const HELD_EVALUATOR_STATUSES: ReadonlySet<string> = new Set([
	"claimed",
	"confirmed",
]);

/**
 * Speaker-slot history for a set of roster members (most recent first), with
 * every held evaluator resolved, member or guest.
 *
 * Takes member IDs rather than one ID because the same human can hold a
 * membership in several clubs; `clubId` narrows to one club's meetings when the
 * caller is a club-scoped surface, and is null for the cross-club personal log.
 * Empty input short-circuits — an `inArray` over an empty list is not valid SQL
 * in every dialect and there is nothing to ask for anyway.
 *
 * `limit: null` means every speech. With a number, `limit + 1` rows are read so
 * `truncated` can tell the page whether a "Show all" link has anything to show.
 *
 * WHO MAY READ WHAT (#681). This payload names another member's evaluators —
 * members AND guests — so both callers authorize before calling:
 * `getMemberProfile` gates on `requireClubViewAccess` (the club's own members,
 * archive-gated in `grantView`), and `listMySpeeches` passes only the signed-in
 * user's own memberships. Neither is new exposure: a held evaluator is already
 * on the club's meeting page. What IS gated here is the archive state:
 * the cross-club log reaches no guard, so the `archived_at` predicate is inlined
 * below exactly as `loadMyCommitments` does (#560) — a taken-down club's
 * evaluator names, guest names included, must not keep surfacing on the
 * dashboard of a member who also belongs to a live club.
 *
 * Cancelled meetings are excluded: a cancelled speech was never given and is
 * not going to be.
 */
export async function loadSpeechLog(
	memberIds: string[],
	clubId: string | null,
	limit: number | null,
): Promise<SpeechLog> {
	if (memberIds.length === 0) return { rows: [], truncated: false };

	// Step 1: the SPEECHES, one row each. No evaluator join here: it is
	// one-to-many (a speech may have two evaluators), and joining it made the
	// `limit` count speech-evaluator PAIRS, so a doubly-evaluated speech appeared
	// twice and pushed a real speech out of the window.
	const query = db
		.select({
			slotId: roleSlots.id,
			scheduledAt: meetings.scheduledAt,
			roleName: roleDefinitions.name,
			speechTitle: speeches.title,
			projectName: speeches.projectName,
			pathwayPath: speeches.pathwayPath,
			projectLevel: speeches.projectLevel,
			status: roleSlots.status,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.innerJoin(clubs, eq(clubs.id, meetings.clubId))
		.leftJoin(speeches, eq(speeches.id, roleSlots.speechId))
		.where(
			and(
				inArray(roleSlots.assignedMemberId, memberIds),
				eq(roleDefinitions.isSpeakerRole, true),
				ne(meetings.status, "cancelled"),
				isNull(clubs.archivedAt),
				clubId ? eq(meetings.clubId, clubId) : undefined,
			),
		)
		// `roleSlots.id` breaks ties: two meetings sharing a `scheduled_at` (two
		// clubs on one night, or a duplicated/rescheduled meeting) otherwise made
		// the `limit` window's MEMBERSHIP arbitrary — a row could enter or leave
		// the dashboard between loader runs. That is the same nondeterminism
		// class #437 exists to remove.
		.orderBy(desc(meetings.scheduledAt), desc(roleSlots.id));

	const fetched = limit === null ? await query : await query.limit(limit + 1);
	const truncated = limit !== null && fetched.length > limit;
	const speechRows = truncated ? fetched.slice(0, limit) : fetched;
	if (speechRows.length === 0) return { rows: [], truncated: false };

	// Step 2: every evaluator slot pointing at those speeches. Two plain
	// `inArray` reads rather than a correlated `json_agg` subquery on purpose: a
	// hand-written correlated `sql` subquery in Drizzle has emitted an
	// unqualified, always-true WHERE here before. LEFT on both assignee tables,
	// since a slot holds a member OR a guest (or, open, neither).
	const evaluatorRows = await db
		.select({
			evaluatesSlotId: roleSlots.evaluatesSlotId,
			status: roleSlots.status,
			memberId: roleSlots.assignedMemberId,
			guestId: roleSlots.assignedGuestId,
			memberName: members.name,
			guestName: guests.name,
		})
		.from(roleSlots)
		.leftJoin(members, eq(members.id, roleSlots.assignedMemberId))
		.leftJoin(guests, eq(guests.id, roleSlots.assignedGuestId))
		.where(
			inArray(
				roleSlots.evaluatesSlotId,
				speechRows.map((r) => r.slotId),
			),
		);

	// Step 3: group in JS.
	const bySpeech = new Map<
		string,
		{ hasSlot: boolean; evaluators: Map<string, SpeechLogEvaluator> }
	>();
	for (const e of evaluatorRows) {
		if (!e.evaluatesSlotId) continue;
		let entry = bySpeech.get(e.evaluatesSlotId);
		if (!entry) {
			entry = { hasSlot: true, evaluators: new Map() };
			bySpeech.set(e.evaluatesSlotId, entry);
		}
		if (!HELD_EVALUATOR_STATUSES.has(e.status)) continue;
		const name = e.memberName ?? e.guestName;
		// Keyed by assignee id, prefixed by kind so a member id and a guest id can
		// never collide: one person holding two evaluator slots for one speech
		// appears once.
		const key = e.memberId
			? `m:${e.memberId}`
			: e.guestId
				? `g:${e.guestId}`
				: null;
		if (name === null || key === null) continue;
		entry.evaluators.set(key, {
			name,
			isGuest: e.memberName === null,
		});
	}

	return {
		rows: speechRows.map((r) => {
			const entry = bySpeech.get(r.slotId);
			return {
				...r,
				evaluators: entry
					? [...entry.evaluators.values()].sort((a, b) =>
							a.name.localeCompare(b.name),
						)
					: [],
				hasEvaluatorSlot: entry?.hasSlot ?? false,
			};
		}),
		truncated,
	};
}

/**
 * The signed-in user's speech history across EVERY club they belong to.
 * Backs the dashboard speech log. No linked membership ⇒ empty log.
 */
export async function loadMySpeechLog(
	userId: string,
	limit: number | null,
): Promise<SpeechLog> {
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
 * `loadMySpeechLog` beside it carries no club identity, but since #681 it carries
 * evaluator names (guests included), so it gates on the same predicate.
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
