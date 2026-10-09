// mergePeople — the cross-club, IRREVERSIBLE Person merge (Task 6).
// Fuses two `people` rows (a human that ended up as two Persons — different
// clubs, a duplicate import, a self-claim that missed the match) into one.
// Re-points the PERSON-scoped FKs (members / speeches / path_enrollments, and
// the guest rows' `guests.person_id`, #1124) from the absorbed Person onto the
// keeper, funnelling every SHARED-club
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
	guests,
	members,
	pathEnrollments,
	pathLevelProgress,
	people,
	speeches,
} from "#/db/schema";
import { absorbedEnrollmentMoves, earliestDate } from "#/lib/person-identity";
import { lockClubForWrite } from "./club-write-lock";
import { RECORD_CHANGED_MESSAGE } from "./guests-logic";
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

/**
 * The merged Person's stored contact preference and who set it (#1093, #1110).
 * A side whose member chose it wins over an officer-set or unset side,
 * whichever row is linked or the keeper, even a deliberate "No preference".
 * Otherwise (neither or both member-set) the earlier order decides: the linked
 * row's value, else keeper ?? absorbed, carrying that SUPPLIER's own source
 * (never the other row's stamp). The STORED value moves as-is; readers resolve it
 * (`effectivePreferredContact`).
 */
export function mergedPreferredContact(
	keeper: Pick<
		PersonRow,
		"userId" | "preferredContact" | "contactPreferenceBy"
	>,
	absorbed: Pick<
		PersonRow,
		"userId" | "preferredContact" | "contactPreferenceBy"
	>,
): {
	preferredContact: PersonRow["preferredContact"];
	contactPreferenceBy: PersonRow["contactPreferenceBy"];
} {
	const keeperMember = keeper.contactPreferenceBy === "member";
	const absorbedMember = absorbed.contactPreferenceBy === "member";
	if (keeperMember !== absorbedMember) {
		const winner = keeperMember ? keeper : absorbed;
		return {
			preferredContact: winner.preferredContact,
			contactPreferenceBy: "member",
		};
	}
	let supplier = keeper;
	if (absorbed.userId && !keeper.userId) supplier = absorbed;
	else if (keeper.userId && !absorbed.userId) supplier = keeper;
	else if (keeper.preferredContact === null) supplier = absorbed;
	const preferredContact = supplier.preferredContact;
	// The source is the SUPPLIER's own stamp, never the other row's: pairing a
	// value from one row with the other's stamp would claim an officer set a
	// null nobody chose. (Both member-set: the supplier's stamp is 'member'.)
	return {
		preferredContact,
		contactPreferenceBy: supplier.contactPreferenceBy,
	};
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
		/** absorbed guest rows re-pointed to the keeper, in any club (#1124). */
		guests: number;
	};
}

/**
 * Every club that holds any of `personIds`, as a member or as a guest, sorted:
 * the set `mergePeople` locks before it locks a Person. Read twice, once before
 * the locks and once under them.
 */
async function clubsHoldingPersons(
	tx: Tx,
	personIds: string[],
): Promise<string[]> {
	const asMember = await tx
		.selectDistinct({ clubId: members.clubId })
		.from(members)
		.where(inArray(members.personId, personIds));
	const asGuest = await tx
		.selectDistinct({ clubId: guests.clubId })
		.from(guests)
		.where(inArray(guests.personId, personIds));
	return [...new Set([...asMember, ...asGuest].map((r) => r.clubId))].sort();
}

export async function mergePeople(
	input: MergePeopleInput,
): Promise<MergePeopleResult> {
	const parsed = mergePeopleSchema.parse(input);
	return db.transaction(async (tx) => {
		// The lock protocol (ADR-0031): every affected club's write lock, in id
		// order; then both Persons `FOR UPDATE`, in id order (the absorbed one is
		// deleted, so the strong mode is right here). The guest rows are not locked
		// up front; see below.
		// #1124 reversed this function's old order (Persons first, club locks
		// after), because a convert, a guest-book capture and #1127's link all take
		// the club's write lock BEFORE they touch a Person, and a merge that held a
		// Person while it waited for a club lock closed a cycle with them.
		//
		// The clubs are only known by reading memberships and guest rows, so they
		// are READ without a lock, locked in order, and read again under the locks
		// (the read-then-lock rule). A set that moved in between means somebody
		// attached or detached one of these Persons from a club we did not lock;
		// the merge is refused with nothing written.
		//
		// `applyMemberEdit` and `confirmEmailChange` lock a Person and no club, so
		// the Persons locked here after the clubs close no cycle through them.
		const personIds = [parsed.keeperPersonId, parsed.absorbedPersonId];
		const clubsBefore = await clubsHoldingPersons(tx, personIds);
		for (const clubId of clubsBefore) await lockClubForWrite(tx, clubId);

		const rows = await tx
			.select()
			.from(people)
			.where(inArray(people.id, personIds))
			.orderBy(people.id)
			.for("update");
		const keeper = rows.find((p) => p.id === parsed.keeperPersonId);
		const absorbed = rows.find((p) => p.id === parsed.absorbedPersonId);
		if (!keeper || !absorbed) throw new Error("Person not found.");

		const clubsAfter = await clubsHoldingPersons(tx, personIds);
		if (
			clubsAfter.length !== clubsBefore.length ||
			clubsAfter.some((id, i) => id !== clubsBefore[i])
		) {
			throw new Error(RECORD_CHANGED_MESSAGE);
		}

		// The absorbed Person's guest rows as they stand NOW, before any collapse
		// below re-points a converted guest's Person along with its membership. The
		// count and the audit are taken from this set so they agree with the
		// preview, which counts the same rows before anything moves.
		//
		// READ, not locked. The guest rows used to be locked here `FOR NO KEY
		// UPDATE` as the protocol's third step, which cycled with
		// `applyUpdateGuestProfile` on the KEEPER side: the editor holds the
		// introducer's membership `FOR SHARE` and then updates the guest row, while
		// the collapse below updates the keeper's membership holding that guest row.
		// That side is closed. The ABSORBED side is as on main: when the guest's
		// introducer is the absorbed membership, the editor holds it `FOR SHARE`
		// while the collapse deletes it, and that cycle is still there. The set
		// cannot change in the meantime: both Persons are locked `FOR UPDATE`, so no
		// guest row can be inserted naming either, and the re-point below locks each
		// row it moves at the moment it moves it.
		const guestsToMove = await tx
			.select({ id: guests.id, clubId: guests.clubId })
			.from(guests)
			.where(eq(guests.personId, absorbed.id));

		const block = checkMergeBlocks(keeper, absorbed);
		if (block) throw new Error(block);

		// 1. Memberships: collapse in shared clubs, else plain re-point. Every
		//    club the absorbed Person belonged to is "affected" (gets an audit row).
		// Ordered by club, as the locks above were taken.
		const absorbedMemberships = await tx
			.select({ id: members.id, clubId: members.clubId })
			.from(members)
			.where(eq(members.personId, absorbed.id))
			.orderBy(members.clubId);
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

		// 1b. Guest rows (#1124): a Person delete that forgot them fails on the
		//     RESTRICT key, so they move to the keeper here, before step 4. They are
		//     the guest RECORDS and stay per club; only whose they are changes.
		//     Every club whose guest record moved is "affected" too, so a merge of
		//     guest-only Persons is attributable to the clubs it touched.
		await tx
			.update(guests)
			.set({ personId: keeper.id })
			.where(eq(guests.personId, absorbed.id));
		for (const g of guestsToMove) affectedClubIds.add(g.clubId);

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
		//      `guests.person_id` is RESTRICT instead, so a missed re-point is a
		//      loud FK failure and not a silent loss.
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
				// A recorded "goes by" name is scarce (someone had to type it) and
				// the merge is irreversible, so adopt the absorbed's rather than
				// lose it (#486).
				preferredName: keeper.preferredName ?? absorbed.preferredName,
				customerId: keeper.customerId ?? absorbed.customerId,
				basecampUserId: keeper.basecampUserId ?? absorbed.basecampUserId,
				userId: keeper.userId ?? absorbed.userId,
				// How they want to be reached (#1093, #1110). A side the MEMBER chose
				// wins outright, even a deliberate "no preference"; otherwise the
				// linked row, then keeper ?? absorbed, with the supplier's own source.
				...mergedPreferredContact(keeper, absorbed),
				originalJoinDate: earliestDate(
					keeper.originalJoinDate,
					absorbed.originalJoinDate,
				),
			})
			.where(eq(people.id, keeper.id));

		// 6. Audit: one member_merge row per affected club, attributed to the
		//    superadmin who ran the merge (impersonated_by; actor_member_id is null
		//    — the superadmin holds no membership in the club). An affected club is
		//    one the absorbed Person held a membership in OR a guest record in
		//    (#1124). A merge where the absorbed Person had neither writes NO audit
		//    row: activity_log.club_id is NOT NULL, so there is no club to attribute
		//    it to — and a Person no club names has nothing a club could miss.
		const movedCounts = {
			memberships: repointed,
			collapsed,
			speeches: spMoved.length,
			enrollments: enMoved,
			guests: guestsToMove.length,
		};
		for (const clubId of affectedClubIds) {
			await tx.insert(activityLog).values({
				clubId,
				actorMemberId: null,
				impersonatedBy: parsed.actorUserId ?? null,
				action: "member_merge",
				// targetId is a Person id (not a membership id) — label the id-space
				// as "person" so consumers don't mis-resolve it as a membership (#330).
				targetType: "person",
				targetId: keeper.id,
				detail: {
					keeperPersonId: keeper.id,
					absorbedPersonId: absorbed.id,
					keeperName: keeper.name,
					absorbedName: absorbed.name,
					movedCounts,
				},
			});
		}
		return { ok: true, movedCounts };
	});
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
		const keepAbsorbed = absorbedEnrollmentMoves(
			{ approved: aScore, lastSyncedAt: abs.lastSyncedAt },
			{ approved: kScore, lastSyncedAt: k.lastSyncedAt },
		);
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
