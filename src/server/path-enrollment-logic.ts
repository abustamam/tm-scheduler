/**
 * Manual path enrollment (#417) — declaring which Pathways path a member is on
 * WITHOUT a Base Camp sync.
 *
 * Until now `path_enrollments` was written only by `pathways-sync-logic.ts`, so
 * a member could have a path only if their club ran the browser extension.
 * ADR-0025 makes that the exception rather than the rule, which left most clubs
 * unable to record a path at all — and #418's project picker has to be scoped to
 * one, since the catalog is ~420 projects across 11 paths.
 *
 * No schema change was needed. `path_enrollments` is already unique on
 * (person_id, path_id) so several concurrent paths per person already work,
 * `archived_at` already models leaving one, and `upsertEnrollment` in the sync
 * is additive — on conflict it only stamps `last_synced_at`, never deletes. So a
 * manual enrollment survives a later sync untouched and the two converge on the
 * same row rather than fighting over it.
 *
 * A `-logic.ts` so `#/db` never leaks into the client bundle (server-modules
 * guard). Never imported by client code.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	members,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
} from "#/db/schema";
import { PATHWAYS_COURSE_CODES } from "#/lib/basecamp-progress";
import { requireClubRole } from "./guards";
import { resolveUserPersonId, userPersonIds } from "./person-identity-logic";

export interface EnrollablePath {
	id: string;
	courseCode: string;
	name: string;
	status: "current" | "legacy";
}

export interface MemberEnrollment {
	pathId: string;
	courseCode: string;
	name: string;
	status: "current" | "legacy";
	/** True when a Base Camp sync has confirmed this enrollment. */
	synced: boolean;
}

/**
 * The paths a member may declare.
 *
 * Reads `pathways_paths` — it has the ids, and for a synced club its rows are
 * the correct ones — but ENUMERATES only the 11 real course codes. That table is
 * global (no `clubId`) and `upsertPath` inserts into it from any club's sync
 * payload; it guards against one club *renaming* a shared entry but not against
 * creating one. Base Camp hosts plenty of non-path courses (Pathways Mentor
 * Program, Speechcraft, Basic Training), so without this filter one member
 * enrolled in the Mentor Program would make it selectable in every club on the
 * platform, permanently (#414).
 *
 * Legacy paths are included: a member part-way through one is a real person, and
 * omitting them would leave exactly those members unable to declare anything.
 */
export async function listEnrollablePaths(): Promise<EnrollablePath[]> {
	const rows = await db
		.select({
			id: pathwaysPaths.id,
			courseCode: pathwaysPaths.courseCode,
			name: pathwaysPaths.name,
			status: pathwaysPaths.status,
		})
		.from(pathwaysPaths)
		.where(inArray(pathwaysPaths.courseCode, [...PATHWAYS_COURSE_CODES]))
		.orderBy(asc(pathwaysPaths.sortOrder), asc(pathwaysPaths.courseCode));
	return rows;
}

/** A member's live (non-archived) enrollments, newest catalog order first. */
export async function listMemberEnrollments(
	personId: string,
): Promise<MemberEnrollment[]> {
	// `synced` is DERIVED, not stored — no schema change was needed for this
	// feature and none is introduced here. `path_level_progress` rows are written
	// only by `syncClubProgress`, so their presence is exactly "Base Camp has
	// spoken about this enrollment". `last_synced_at` cannot serve: it defaults
	// to now() on insert, so a manual enrollment carries a timestamp that looks
	// like a sync.
	const rows = await db
		.select({
			pathId: pathwaysPaths.id,
			courseCode: pathwaysPaths.courseCode,
			name: pathwaysPaths.name,
			status: pathwaysPaths.status,
			levelRows: sql<number>`count(${pathLevelProgress.id})`,
		})
		.from(pathEnrollments)
		.innerJoin(pathwaysPaths, eq(pathEnrollments.pathId, pathwaysPaths.id))
		.leftJoin(
			pathLevelProgress,
			eq(pathLevelProgress.enrollmentId, pathEnrollments.id),
		)
		.where(
			and(
				eq(pathEnrollments.personId, personId),
				isNull(pathEnrollments.archivedAt),
			),
		)
		.groupBy(
			pathwaysPaths.id,
			pathwaysPaths.courseCode,
			pathwaysPaths.name,
			pathwaysPaths.status,
			pathwaysPaths.sortOrder,
		)
		.orderBy(asc(pathwaysPaths.sortOrder), asc(pathwaysPaths.courseCode));

	return rows.map((r) => ({
		pathId: r.pathId,
		courseCode: r.courseCode,
		name: r.name,
		status: r.status,
		synced: Number(r.levelRows) > 0,
	}));
}

/**
 * The signed-in user's own `people` row.
 *
 * Enrollment is PERSON-level, not club-level — `path_enrollments` keys on
 * `person_id`, and a Toastmaster's path follows them across clubs. So managing
 * one's own paths needs no club context at all, which is why the self surface
 * takes no `clubId`. Only the admin-acting-for-someone-else surface does, and
 * only to prove the target is on that admin's roster.
 *
 * Null when the account has no linked person yet (signed in but never matched to
 * a roster row). Callers surface that rather than silently doing nothing.
 */
export async function selfPersonId(userId: string): Promise<string | null> {
	return resolveUserPersonId(userId);
}

/**
 * Who may write this member's enrollments, and which `people` row it lands on.
 *
 * SIGNED-IN ONLY, deliberately unlike role sign-up, which lets someone pick
 * their name on the public club page. A wrong role claim is cheap and
 * self-correcting — the room notices at the next meeting. A wrong Pathways
 * enrollment is a personal educational record nobody else looks at, so it stays
 * invisible until it matters. Same reasoning that already gates member email
 * and phone behind sign-in.
 *
 * Two ways through: the member themselves, or a club admin acting for anyone on
 * their roster (which includes members who have never signed in — otherwise a
 * club couldn't be bootstrapped). `clubRole` is only admin|member, with VP
 * Education and President mapping to admin, so the gate is `["admin"]`.
 *
 * Never crosses club boundaries: the member must be on THIS club's roster.
 */
export async function resolveEnrollmentAuthz(input: {
	userId: string;
	clubId: string;
	memberId: string;
}): Promise<{ personId: string }> {
	const [member] = await db
		.select({
			id: members.id,
			clubId: members.clubId,
			personId: members.personId,
		})
		.from(members)
		.where(eq(members.id, input.memberId));
	if (!member || member.clubId !== input.clubId) {
		throw new Error("Member not found in this club.");
	}

	// Compare against EVERY Person linked to this account, not one arbitrary
	// row: `people.user_id` is not unique, and matching only the first would
	// tell a member with a duplicate Person that their own roster row isn't
	// theirs — bouncing them into the admin gate on their own record.
	const mine = await userPersonIds(input.userId);
	if (mine.includes(member.personId)) return { personId: member.personId };

	// Not themselves — must be a club admin. Throws with its own message.
	await requireClubRole(input.userId, input.clubId, ["admin"]);
	return { personId: member.personId };
}

/**
 * Declare a path. Idempotent, and un-archives rather than duplicating if the
 * member previously left this path — the row is the same enrollment resuming,
 * and re-creating it would lose whatever `bcm_project_progress` hangs off it.
 *
 * On conflict it clears `archived_at` and touches nothing else, so re-declaring
 * a path a sync already created is a genuine no-op.
 */
export async function enrollInPath(
	personId: string,
	pathId: string,
): Promise<void> {
	await db
		.insert(pathEnrollments)
		.values({ personId, pathId })
		.onConflictDoUpdate({
			target: [pathEnrollments.personId, pathEnrollments.pathId],
			set: { archivedAt: null },
		});
}

/**
 * Leave a path. ARCHIVES rather than deletes, because `bcm_project_progress`
 * cascades from the enrollment — deleting would silently discard a member's
 * completion history for that path, which they'd want back if they resume.
 */
export async function archiveEnrollment(
	personId: string,
	pathId: string,
): Promise<void> {
	await db
		.update(pathEnrollments)
		.set({ archivedAt: new Date() })
		.where(
			and(
				eq(pathEnrollments.personId, personId),
				eq(pathEnrollments.pathId, pathId),
			),
		);
}
