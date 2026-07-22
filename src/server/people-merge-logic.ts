// mergePeople — the cross-club, IRREVERSIBLE Person merge (Task 6).
// Fuses two `people` rows (a human that ended up as two Persons — different
// clubs, a duplicate import, a self-claim that missed the match) into one.
// Re-points the three PERSON-scoped FKs (members / speeches / path_enrollments)
// from the absorbed Person onto the keeper, funnelling every SHARED-club
// membership through `collapseMemberships` (so membership FKs never drift),
// keeps the more-progressed enrollment on a Pathways-path collision, deletes
// the absorbed Person, and writes one `member_merge` audit row per affected
// club. HARD-BLOCKS when the two carry conflicting non-null identity anchors
// (`user_id` / `customer_id` / `basecamp_user_id`) — those mean two genuinely
// different humans, and fusing them would be a silent data-integrity loss.
//
// Split out from any createServerFn wrapper so it stays directly integration-
// testable and its `#/db` import never leaks into the client bundle (the
// server-modules.guard.test.ts rule; see `members-logic.ts`). The read/dedupe
// helpers (`findBestPersonByEmail`, `historyCounts`) stay in `people-logic.ts`;
// this module owns the write path. `checkMergeBlocks` is exported for the
// future preview server-fn (which shows the admin what a merge would do).
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import {
	activityLog,
	members,
	pathEnrollments,
	pathLevelProgress,
	people,
	speeches,
} from "#/db/schema";
import { collapseMemberships } from "./membership-collapse-logic";

// A transaction handle (or the base db) — both expose the query builder we use.
type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const mergePeopleSchema = z.object({
	keeperPersonId: z.string().uuid(),
	absorbedPersonId: z.string().uuid(),
	// The platform superadmin performing the merge (attributed on the audit row
	// via `impersonated_by`). Null/omitted for a system-initiated merge.
	actorUserId: z.string().nullable().optional(),
});
export type MergePeopleInput = z.infer<typeof mergePeopleSchema>;

type PersonRow = typeof people.$inferSelect;

/**
 * A hard "these are probably different humans / can't fuse" reason, or null when
 * the merge is safe to proceed. Conflicting anchors block: a differing non-null
 * `user_id` (two separate sign-in accounts), `customer_id` (two distinct
 * Toastmasters members), or `basecamp_user_id` (two Base Camp identities). A
 * null on either side is not a conflict — it is adopted from the other.
 */
export function checkMergeBlocks(
	keeper: PersonRow,
	absorbed: PersonRow,
): string | null {
	if (keeper.id === absorbed.id) return "Pick two different people.";
	const conflict = (a: string | null, b: string | null) =>
		a != null && b != null && a !== b;
	if (conflict(keeper.userId, absorbed.userId))
		return "Both people have separate sign-in accounts — resolve the accounts first.";
	if (conflict(keeper.customerId, absorbed.customerId))
		return "Both people have different Toastmasters Customer IDs — they are different members.";
	if (conflict(keeper.basecampUserId, absorbed.basecampUserId))
		return "Both people have different Base Camp accounts — they are different members.";
	return null;
}

export interface MergePeopleResult {
	ok: true;
	movedCounts: {
		/** absorbed memberships re-pointed to the keeper (no keeper row in that club). */
		memberships: number;
		/** absorbed memberships collapsed into a keeper membership of the same club. */
		collapsed: number;
		speeches: number;
		enrollments: number;
	};
}

export async function mergePeople(
	input: MergePeopleInput,
): Promise<MergePeopleResult> {
	const parsed = mergePeopleSchema.parse(input);
	return db.transaction(async (tx) => {
		const rows = await tx
			.select()
			.from(people)
			.where(
				inArray(people.id, [parsed.keeperPersonId, parsed.absorbedPersonId]),
			);
		const keeper = rows.find((p) => p.id === parsed.keeperPersonId);
		const absorbed = rows.find((p) => p.id === parsed.absorbedPersonId);
		if (!keeper || !absorbed) throw new Error("Person not found.");

		const block = checkMergeBlocks(keeper, absorbed);
		if (block) throw new Error(block);

		// 1. Memberships: collapse in shared clubs, else plain re-point. Every
		//    club the absorbed Person belonged to is "affected" (gets an audit row).
		const absorbedMemberships = await tx
			.select({ id: members.id, clubId: members.clubId })
			.from(members)
			.where(eq(members.personId, absorbed.id));
		const keeperMemberships = await tx
			.select({ id: members.id, clubId: members.clubId })
			.from(members)
			.where(eq(members.personId, keeper.id));
		const keeperByClub = new Map(
			keeperMemberships.map((m) => [m.clubId, m.id]),
		);
		const affectedClubIds = new Set<string>();
		let collapsed = 0;
		let repointed = 0;
		for (const abs of absorbedMemberships) {
			affectedClubIds.add(abs.clubId);
			const keeperMembershipId = keeperByClub.get(abs.clubId);
			if (keeperMembershipId) {
				// Both Persons are members of this club — fuse the two memberships so
				// the club never ends up with two rows for one human.
				await collapseMemberships(tx, abs.clubId, keeperMembershipId, abs.id);
				collapsed++;
			} else {
				await tx
					.update(members)
					.set({ personId: keeper.id })
					.where(eq(members.id, abs.id));
				repointed++;
			}
		}

		// 2. Speeches (person-scoped, no unique) → keeper.
		const spMoved = await tx
			.update(speeches)
			.set({ personId: keeper.id })
			.where(eq(speeches.personId, absorbed.id))
			.returning({ id: speeches.id });

		// 3. Path enrollments: keep the more-progressed one on a (person, path)
		//    collision (the unique index forbids two enrollments in one path).
		const enMoved = await mergeEnrollments(tx, keeper.id, absorbed.id);

		// 4. Delete the absorbed Person. Ordering is load-bearing on BOTH sides:
		//    - AFTER the step 1–3 re-points: `members.person_id`, `speeches.person_id`
		//      and `path_enrollments.person_id` are all `ON DELETE CASCADE` on
		//      `people`, so deleting the absorbed row any earlier would cascade-WIPE
		//      its real memberships/speeches/enrollments before they're re-pointed.
		//    - BEFORE the keeper reconcile below: adopting the absorbed's
		//      `customer_id` / `basecamp_user_id` (both non-deferrable UNIQUE) would
		//      collide with the still-live absorbed row if it hadn't been deleted yet.
		await tx.delete(people).where(eq(people.id, absorbed.id));

		// 5. Reconcile the keeper as the canonical Person: keeper wins, but adopt
		//    any anchor the keeper is missing from the absorbed (checkMergeBlocks
		//    guaranteed the non-null ones don't conflict). Earliest join wins.
		await tx
			.update(people)
			.set({
				email: keeper.email ?? absorbed.email,
				phone: keeper.phone ?? absorbed.phone,
				customerId: keeper.customerId ?? absorbed.customerId,
				basecampUserId: keeper.basecampUserId ?? absorbed.basecampUserId,
				userId: keeper.userId ?? absorbed.userId,
				originalJoinDate: earliestDate(
					keeper.originalJoinDate,
					absorbed.originalJoinDate,
				),
			})
			.where(eq(people.id, keeper.id));

		// 6. Audit: one member_merge row per affected club, attributed to the
		//    superadmin who ran the merge (impersonated_by; actor_member_id is null
		//    — the superadmin holds no membership in the club). A merge where NEITHER
		//    person has a membership writes NO audit row: activity_log.club_id is NOT
		//    NULL, so there is no club to attribute the merge to — intentional/OK.
		const movedCounts = {
			memberships: repointed,
			collapsed,
			speeches: spMoved.length,
			enrollments: enMoved,
		};
		for (const clubId of affectedClubIds) {
			await tx.insert(activityLog).values({
				clubId,
				actorMemberId: null,
				impersonatedBy: parsed.actorUserId ?? null,
				action: "member_merge",
				targetType: "member",
				targetId: keeper.id,
				detail: {
					keeperPersonId: keeper.id,
					absorbedPersonId: absorbed.id,
					movedCounts,
				},
			});
		}
		return { ok: true, movedCounts };
	});
}

/** Earliest of two nullable dates; a null is treated as "unknown" (loses). */
function earliestDate(a: Date | null, b: Date | null): Date | null {
	if (!a) return b;
	if (!b) return a;
	return a < b ? a : b;
}

/**
 * Re-point the absorbed Person's Pathways enrollments onto the keeper. On a
 * shared path (the keeper is already enrolled) the unique `(person_id, path_id)`
 * index forbids two rows, so keep the MORE-PROGRESSED enrollment — more approved
 * levels wins, ties broken by the more recent sync — and drop the other.
 * Returns the number of enrollments that now belong to the keeper via the move.
 */
async function mergeEnrollments(
	tx: Tx,
	keeperId: string,
	absorbedId: string,
): Promise<number> {
	const keeperEnr = await tx
		.select()
		.from(pathEnrollments)
		.where(eq(pathEnrollments.personId, keeperId));
	const absEnr = await tx
		.select()
		.from(pathEnrollments)
		.where(eq(pathEnrollments.personId, absorbedId));
	const keeperByPath = new Map(keeperEnr.map((e) => [e.pathId, e]));
	let moved = 0;
	for (const abs of absEnr) {
		const k = keeperByPath.get(abs.pathId);
		if (!k) {
			await tx
				.update(pathEnrollments)
				.set({ personId: keeperId })
				.where(eq(pathEnrollments.id, abs.id));
			moved++;
			continue;
		}
		const [aScore, kScore] = [
			await approvedLevels(tx, abs.id),
			await approvedLevels(tx, k.id),
		];
		const keepAbsorbed =
			aScore > kScore ||
			(aScore === kScore && abs.lastSyncedAt > k.lastSyncedAt);
		if (keepAbsorbed) {
			// Delete the keeper's losing enrollment FIRST, then re-point the
			// absorbed one — otherwise the re-point collides on the unique
			// `(person_id, path_id)` index (both would briefly be keeper+this path).
			await tx.delete(pathEnrollments).where(eq(pathEnrollments.id, k.id));
			await tx
				.update(pathEnrollments)
				.set({ personId: keeperId })
				.where(eq(pathEnrollments.id, abs.id));
			moved++;
		} else {
			await tx.delete(pathEnrollments).where(eq(pathEnrollments.id, abs.id));
		}
	}
	return moved;
}

/** Count of approved (completed) levels for one enrollment — the progress score. */
async function approvedLevels(tx: Tx, enrollmentId: string): Promise<number> {
	const [r] = await tx
		.select({ n: sql<number>`count(*)::int` })
		.from(pathLevelProgress)
		.where(
			and(
				eq(pathLevelProgress.enrollmentId, enrollmentId),
				eq(pathLevelProgress.approved, true),
			),
		);
	return r?.n ?? 0;
}
