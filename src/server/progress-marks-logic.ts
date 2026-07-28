/**
 * Explicit project completion marks (#419) — the source of completion truth for
 * clubs with no Base Camp.
 *
 * Completion is MARKED, never derived from delivered speeches. Derivation is
 * wrong in both directions:
 *
 *  - Too low. "Evaluation and Feedback" takes three assignments — give a speech,
 *    evaluate another member's, then give the same speech again applying the
 *    feedback (#409). One delivery would complete a project that is two-thirds
 *    outstanding.
 *  - Too high. A member working ahead has delivered Level 2 speeches while
 *    Level 1 sits unapproved. No speech-derived rule can express that.
 *
 * A `-logic.ts` so `#/db` never leaks into the client bundle (server-modules
 * guard). Never imported by client code.
 */
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import {
	members,
	pathEnrollments,
	pathwaysPaths,
	pathwaysProjects,
	people,
	projectCompletionMarks,
} from "#/db/schema";
import { PATHWAYS_COURSE_CODES } from "#/lib/basecamp-progress";
import { requireClubRole } from "./guards";

/**
 * The live enrollment this project belongs to, for this person.
 *
 * Marks hang off an ENROLLMENT, not a person — so marking a project the member
 * isn't on the path for has nowhere to go, and is refused rather than silently
 * creating an enrollment they never declared. Archived enrollments are refused
 * for the same reason: resuming the path is a deliberate act (#417), not a side
 * effect of ticking a box.
 *
 * The course-code allowlist is re-checked here for the same reason as #417/#418:
 * `pathways_paths` is global and any club's sync can insert into it, so a
 * project on a non-path course must never become markable progress.
 */
export async function resolveMarkTarget(input: {
	personId: string;
	projectId: string;
}): Promise<{ enrollmentId: string }> {
	const [row] = await db
		.select({
			enrollmentId: pathEnrollments.id,
			courseCode: pathwaysPaths.courseCode,
		})
		.from(pathwaysProjects)
		.innerJoin(pathwaysPaths, eq(pathwaysPaths.id, pathwaysProjects.pathId))
		.innerJoin(
			pathEnrollments,
			and(
				eq(pathEnrollments.pathId, pathwaysPaths.id),
				eq(pathEnrollments.personId, input.personId),
			),
		)
		.where(eq(pathwaysProjects.id, input.projectId));

	if (!row || !PATHWAYS_COURSE_CODES.has(row.courseCode)) {
		throw new Error("That project isn't on a path you're enrolled in.");
	}
	return { enrollmentId: row.enrollmentId };
}

/**
 * Mark a project complete. Idempotent — re-marking refreshes nothing and throws
 * nothing, so a double-tap is harmless.
 *
 * `markedByMemberId` records who ticked it (the member themselves, or the admin
 * acting for them); null when the actor has no membership in that club, which a
 * superadmin acting under impersonation can be.
 */
export async function markProjectComplete(input: {
	enrollmentId: string;
	projectId: string;
	markedByMemberId: string | null;
}): Promise<void> {
	await db
		.insert(projectCompletionMarks)
		.values({
			enrollmentId: input.enrollmentId,
			projectId: input.projectId,
			markedByMemberId: input.markedByMemberId,
		})
		.onConflictDoNothing({
			target: [
				projectCompletionMarks.enrollmentId,
				projectCompletionMarks.projectId,
			],
		});
}

/**
 * Remove a mark. A hard delete, unlike leaving a path — a mark carries no
 * history of its own, so there is nothing to preserve, and an un-mark is
 * "I ticked the wrong box", which should leave no trace.
 *
 * Base Camp's own verdict is untouched: a project complete in `/detail` stays
 * complete after this. The two sources never overwrite each other.
 */
export async function unmarkProjectComplete(input: {
	enrollmentId: string;
	projectId: string;
}): Promise<void> {
	await db
		.delete(projectCompletionMarks)
		.where(
			and(
				eq(projectCompletionMarks.enrollmentId, input.enrollmentId),
				eq(projectCompletionMarks.projectId, input.projectId),
			),
		);
}

/** The signed-in user's own `people` row, or null when unlinked. */
export async function selfPersonId(userId: string): Promise<string | null> {
	const [p] = await db
		.select({ id: people.id })
		.from(people)
		.where(eq(people.userId, userId));
	return p?.id ?? null;
}

/** The signed-in user's membership id in a club, for mark attribution. */
export async function selfMemberIdInClub(
	userId: string,
	clubId: string,
): Promise<string | null> {
	const [m] = await db
		.select({ id: members.id })
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.where(and(eq(people.userId, userId), eq(members.clubId, clubId)));
	return m?.id ?? null;
}

/**
 * Who may write this member's progress marks, and whose record it lands on.
 *
 * Identical shape to enrollment authz (#417), deliberately: signed-in only,
 * self or a club admin acting for anyone on their roster, never across clubs.
 * A wrong tick on a personal educational record is invisible until it matters,
 * unlike a wrong role claim that the room self-corrects at the next meeting.
 *
 * Returns the acting member id too, so the mark records who made it.
 */
export async function resolveMarkAuthz(input: {
	userId: string;
	clubId: string;
	memberId: string;
}): Promise<{ personId: string; actorMemberId: string | null }> {
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

	const [self] = await db
		.select({ id: people.id })
		.from(people)
		.where(eq(people.userId, input.userId));
	if (self && self.id === member.personId) {
		return { personId: member.personId, actorMemberId: member.id };
	}

	// Not themselves — must be a club admin. Throws with its own message.
	await requireClubRole(input.userId, input.clubId, ["admin"]);
	return {
		personId: member.personId,
		actorMemberId: await selfMemberIdInClub(input.userId, input.clubId),
	};
}
