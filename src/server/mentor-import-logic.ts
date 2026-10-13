/**
 * The mentor-pair step of the Easy-Speak import (#1053): a step of its own, run
 * after the history is applied, that turns the bundle's mentoring chart into
 * #939 mentorships.
 *
 * Its OWN module, not part of `history-import-logic.ts`, on purpose: pairings
 * are visible only to the mentee, the mentor and admins (#939), and
 * `history-import-logic.ts` is also imported by `mcp/tools/get-import-report.ts`,
 * which officers can reach. Keeping the `mentorships` table out of that file means
 * no officer-reachable module can read or write a pairing. This module may be
 * imported ONLY by `history-import.ts` (`mentorship-not-public.guard.test.ts`).
 *
 * It has no session of its own: `history-import.ts` runs `requireSuperadmin`
 * before it calls in.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "#/db";
import { importRefs, members, mentorships } from "#/db/schema";
import type { EasySpeakBundleV1 } from "#/lib/easy-speak-bundle";
import { personKeyOf } from "#/lib/easy-speak-import-plan";
import { logActivity } from "./activity";
import { lockClubForWrite } from "./club-write-lock";
import {
	assertClubNotArchivedTx,
	loadStoredBundle,
	putRef,
	SOURCE,
	type Tx,
	takeImportLock,
} from "./history-import-logic";

export const MENTORS_NOT_APPLIED_MESSAGE =
	"Apply the import before importing its mentor pairs: they are matched to the people it resolved.";

type EsPerson = EasySpeakBundleV1["mentors"][number]["mentee"];

/**
 * Why one bundle pair was not written. Only its own pair is blocked (AC2).
 * `*_unresolved`: the import's apply never matched that person (no `person`
 * ref: a guest, someone it skipped, or someone absent from every imported
 * meeting). `*_not_member`: the person resolved to a membership that is not
 * ACTIVE in this club now (lapsed, removed, or a stale ref).
 */
export type MentorPairSkipReason =
	| "mentee_unresolved"
	| "mentor_unresolved"
	| "mentee_not_member"
	| "mentor_not_member"
	| "neither_unresolved"
	| "neither_not_member"
	/** One side unresolved, the other not an active member. */
	| "neither_member"
	| "same_person";

export interface MentorPairSkip {
	mentee: EsPerson;
	mentor: EsPerson;
	reason: MentorPairSkipReason;
}

/**
 * What the mentor step did. `imported + alreadyImported + alreadyPaired +
 * skipped.length` equals `pairs`; `pairs + noMentor` equals `total`.
 */
export interface MentorImportResult {
	/** Rows in the bundle's mentoring chart. */
	total: number;
	/** Rows naming a mentor: the pairs the step is meant to write. */
	pairs: number;
	/** Rows with no mentor: nothing to pair (the member is only asking for one). */
	noMentor: number;
	/** Pairs this run created. */
	imported: number;
	/**
	 * Already imported: by an earlier run (a pairing a human has since ended or
	 * deleted stays that way), or by an earlier row of THIS run naming the same
	 * pair under the same Easy-Speak keys (a duplicate row).
	 */
	alreadyImported: number;
	/**
	 * The two already had an ACTIVE pairing that this pair's own row did not make:
	 * one an admin made by hand, or one an earlier row of this run made for the
	 * same two members under a different Easy-Speak key (the same human listed by
	 * id in one row and by name in another). It is left as it is and remembered.
	 */
	alreadyPaired: number;
	/** Each pair that was not written, with who and why. */
	skipped: MentorPairSkip[];
	/**
	 * What "Wants Mentee?" did (#1204). The flag means the row's member is open to
	 * taking on a mentee: `members.willing_to_mentor` (#939).
	 */
	willing: WillingResult;
}

/** Why a "Wants Mentee?" row did not set anyone's flag. */
export type WillingSkipReason = "unresolved" | "not_member";

export interface WillingSkip {
	person: EsPerson;
	reason: WillingSkipReason;
}

/**
 * What "Wants Mentee?" did, counted per ROW except `skipped`, which lists each
 * PERSON once. Every row with `wantsMentee` lands in exactly one of `set`,
 * `alreadyWilling` and `previouslyImported`, or its person is listed in
 * `skipped`. So `set + alreadyWilling + previouslyImported + skipped.length`
 * equals the number of `wantsMentee` rows minus the extra rows of people listed
 * more than once in `skipped`. A member on two rows is counted twice: the first
 * row sets the flag (or finds it on), the second finds the member already
 * remembered and counts as `previouslyImported`. The step only ever sets the
 * flag to true, never to false.
 */
export interface WillingResult {
	/** Rows whose member's `willing_to_mentor` this run turned on. */
	set: number;
	/**
	 * Rows whose member was already willing (they set it themselves, or an admin
	 * did). Remembered like `set`, so a later opt-out is not undone.
	 */
	alreadyWilling: number;
	/**
	 * Rows whose member this import already handled: by an earlier run (so a member
	 * who has since turned the flag off is not turned back on), or by an earlier
	 * row of THIS run. Not written, not audited.
	 */
	previouslyImported: number;
	/** People who are not an active member now, each listed once. */
	skipped: WillingSkip[];
}

/** Where one side of a pair stands against the club's people. */
type Side =
	| { state: "active"; id: string }
	| { state: "unresolved" }
	| { state: "not_member" };

/** The reason for a pair with at least one side that is not an active member. */
function skipReasonFor(
	mentee: Side["state"],
	mentor: Side["state"],
): MentorPairSkipReason {
	if (mentee !== "active" && mentor !== "active") {
		if (mentee !== mentor) return "neither_member";
		return mentee === "unresolved"
			? "neither_unresolved"
			: "neither_not_member";
	}
	if (mentee === "unresolved") return "mentee_unresolved";
	if (mentee === "not_member") return "mentee_not_member";
	return mentor === "unresolved" ? "mentor_unresolved" : "mentor_not_member";
}

/**
 * Lock both members' rows `FOR SHARE`, as `createMentorship` does
 * (`assertPairable` in `mentorship-logic.ts`, which is not exported), and return
 * which of them are ACTIVE once locked. The snapshot read at the top of the run
 * can be stale by now: an admin may have lapsed or removed one of them in the
 * meantime, and the share lock keeps them from doing so before our insert lands.
 */
async function lockedActiveIds(
	tx: Tx,
	clubId: string,
	ids: string[],
): Promise<Set<string>> {
	const rows = await tx
		.select({ id: members.id, status: members.status })
		.from(members)
		.where(and(eq(members.clubId, clubId), inArray(members.id, ids)))
		.for("share");
	return new Set(rows.filter((r) => r.status === "active").map((r) => r.id));
}

/**
 * "Wants Mentee?": the row's member is open to taking on a mentee. Only ever
 * turns the flag ON. The column cannot tell a member who turned it off in
 * GavelUp from one who never set it, so every member the step handles is
 * remembered (`import_refs` kind `willing_to_mentor`, `sourceId` and `targetId`
 * both the MEMBER id, so a later bundle with different Easy-Speak ids cannot
 * re-set it either) and is never touched again. The ref is written in this
 * transaction, whether the step set the flag or found it already on.
 */
async function importWillingFlags(
	tx: Tx,
	ctx: {
		clubId: string;
		importId: string;
		superadminUserId: string;
		rows: EasySpeakBundleV1["mentors"];
		sideOf: (who: EsPerson) => Side;
		/** Member ids already remembered; grows as this run remembers more. */
		done: Set<string>;
		result: WillingResult;
	},
): Promise<void> {
	const { result } = ctx;
	const seenSkipped = new Set<string>();
	// A person who is not an active member, listed once however many rows name them.
	const skip = (who: EsPerson, reason: WillingSkipReason) => {
		const key = personKeyOf(who);
		if (seenSkipped.has(key)) return;
		seenSkipped.add(key);
		result.skipped.push({ person: who, reason });
	};
	for (const row of ctx.rows) {
		if (!row.wantsMentee) continue;
		const who = row.mentee;
		const side = ctx.sideOf(who);
		if (side.state !== "active") {
			skip(who, side.state === "unresolved" ? "unresolved" : "not_member");
			continue;
		}
		if (ctx.done.has(side.id)) {
			result.previouslyImported++;
			continue;
		}
		// Lock the row and trust only what the lock shows: an admin may have
		// lapsed the member since the snapshot. NO KEY UPDATE, not UPDATE: it
		// still excludes a concurrent edit of the row but not the KEY SHARE an
		// admin's status-edit audit insert takes on the actor member (a deadlock).
		const [current] = await tx
			.select({
				status: members.status,
				willing: members.willingToMentor,
			})
			.from(members)
			.where(and(eq(members.clubId, ctx.clubId), eq(members.id, side.id)))
			.for("no key update");
		if (!current || current.status !== "active") {
			skip(who, "not_member");
			continue;
		}
		await putRef(tx, ctx.clubId, "willing_to_mentor", side.id, side.id);
		ctx.done.add(side.id);
		if (current.willing) {
			result.alreadyWilling++;
			continue;
		}
		// The predicates are in the statement too, not only in the read above.
		await tx
			.update(members)
			.set({ willingToMentor: true })
			.where(
				and(
					eq(members.id, side.id),
					eq(members.clubId, ctx.clubId),
					eq(members.status, "active"),
				),
			);
		result.set++;
		await logActivity(tx, {
			clubId: ctx.clubId,
			actorMemberId: null,
			impersonatedBy: ctx.superadminUserId,
			action: "member_edit",
			targetType: "member",
			targetId: side.id,
			detail: {
				willingToMentor: true,
				importId: ctx.importId,
			},
		});
	}
}

/**
 * Import the stored bundle's mentor pairs as #939 mentorships. The caller has
 * proved the superadmin.
 *
 * - Each row with a mentor becomes one ACTIVE pairing with no focus. Both people
 *   must resolve through the `person` refs the import's apply wrote to members
 *   still ACTIVE in the club (a mentorship may only join active members); a pair
 *   with a person who does not is skipped and LISTED, and its neighbours still
 *   land.
 * - Idempotent through `import_refs` kind `mentor_pair`, checked BEFORE the
 *   membership check so a re-run after a lapse or merge still reports an
 *   imported pair as imported: a second run adds nothing, and a pairing someone
 *   ended or deleted since is not brought back. Two people who already have an
 *   active pairing keep it, and it is remembered.
 * - Each pairing written is audited like `createMentorship`'s (a `member_edit`),
 *   beside the step's one `history_imported` summary.
 * - A row with "Wants Mentee?" turns the row's member's `willing_to_mentor` on
 *   (#1204), audited as a `member_edit` per member changed; never off. Each
 *   member handled is remembered (`import_refs` kind `willing_to_mentor`, keyed
 *   on the member), so a re-run does not turn the flag back on for one who
 *   turned it off since.
 * - One transaction under the club write lock and the apply's own per-club lock.
 */
export async function importMentorPairs(input: {
	clubId: string;
	importId: string;
	/** The superadmin the change is attributed to. */
	superadminUserId: string;
}): Promise<MentorImportResult> {
	const stored = await loadStoredBundle(input.clubId, input.importId);
	if (!stored.appliedAt) throw new Error(MENTORS_NOT_APPLIED_MESSAGE);
	const rows = stored.bundle.mentors;

	return db.transaction(async (tx) => {
		await takeImportLock(tx, input.clubId);
		await lockClubForWrite(tx, input.clubId);
		await assertClubNotArchivedTx(tx, input.clubId);

		const refs = await tx
			.select({
				kind: importRefs.kind,
				sourceId: importRefs.sourceId,
				targetId: importRefs.targetId,
			})
			.from(importRefs)
			.where(
				and(
					eq(importRefs.clubId, input.clubId),
					eq(importRefs.source, SOURCE),
					inArray(importRefs.kind, [
						"person",
						"mentor_pair",
						"willing_to_mentor",
					]),
				),
			);
		const personRefs = new Map<string, string>();
		const imported = new Set<string>();
		// Member ids whose "Wants Mentee?" an earlier run (or row) already handled.
		const willingDone = new Set<string>();
		for (const ref of refs) {
			if (ref.kind === "person") personRefs.set(ref.sourceId, ref.targetId);
			else if (ref.kind === "willing_to_mentor") willingDone.add(ref.sourceId);
			else imported.add(ref.sourceId);
		}
		const live = new Set(
			(
				await tx
					.select({ id: members.id })
					.from(members)
					.where(
						and(eq(members.clubId, input.clubId), eq(members.status, "active")),
					)
			).map((m) => m.id),
		);
		// The active pairings the club already has, any focus: the partial unique
		// indexes would refuse a duplicate with no focus, and a pairing an admin
		// made by hand with a focus is the same pairing to this import.
		const active = new Map<string, string>();
		for (const row of await tx
			.select({
				id: mentorships.id,
				mentor: mentorships.mentorMemberId,
				mentee: mentorships.menteeMemberId,
			})
			.from(mentorships)
			.where(
				and(eq(mentorships.clubId, input.clubId), isNull(mentorships.endedAt)),
			)) {
			active.set(`${row.mentor}:${row.mentee}`, row.id);
		}

		const sideOf = (who: EsPerson): Side => {
			const id = personRefs.get(personKeyOf(who));
			if (id === undefined) return { state: "unresolved" };
			return live.has(id) ? { state: "active", id } : { state: "not_member" };
		};

		const result: MentorImportResult = {
			total: rows.length,
			pairs: 0,
			noMentor: 0,
			imported: 0,
			alreadyImported: 0,
			alreadyPaired: 0,
			skipped: [],
			willing: {
				set: 0,
				alreadyWilling: 0,
				previouslyImported: 0,
				skipped: [],
			},
		};
		for (const row of rows) {
			const mentor = row.mentor;
			if (!mentor) {
				result.noMentor++;
				continue;
			}
			result.pairs++;
			const skip = (reason: MentorPairSkipReason) =>
				result.skipped.push({ mentee: row.mentee, mentor, reason });

			// The ref first: a pair this import already wrote is reported as
			// imported even if one of them has since lapsed or been merged away.
			const sourceId = `${personKeyOf(row.mentee)}>${personKeyOf(mentor)}`;
			if (imported.has(sourceId)) {
				result.alreadyImported++;
				continue;
			}
			const mentee = sideOf(row.mentee);
			const mentorSide = sideOf(mentor);
			if (mentee.state !== "active" || mentorSide.state !== "active") {
				skip(skipReasonFor(mentee.state, mentorSide.state));
				continue;
			}
			const menteeId = mentee.id;
			const mentorId = mentorSide.id;
			if (menteeId === mentorId) {
				skip("same_person");
				continue;
			}
			// Like createMentorship: lock both rows, then trust only what the lock
			// shows. A member lapsed since the snapshot above is skipped.
			const stillActive = await lockedActiveIds(tx, input.clubId, [
				mentorId,
				menteeId,
			]);
			const menteeNow = stillActive.has(menteeId);
			const mentorNow = stillActive.has(mentorId);
			if (!menteeNow || !mentorNow) {
				skip(
					skipReasonFor(
						menteeNow ? "active" : "not_member",
						mentorNow ? "active" : "not_member",
					),
				);
				continue;
			}
			const pairKey = `${mentorId}:${menteeId}`;
			const existing = active.get(pairKey);
			if (existing) {
				await putRef(tx, input.clubId, "mentor_pair", sourceId, existing);
				imported.add(sourceId);
				result.alreadyPaired++;
				continue;
			}
			const [made] = await tx
				.insert(mentorships)
				.values({
					clubId: input.clubId,
					mentorMemberId: mentorId,
					menteeMemberId: menteeId,
					focus: null,
					createdByMemberId: null,
				})
				.returning({ id: mentorships.id });
			if (!made) throw new Error("Could not create a mentorship.");
			await putRef(tx, input.clubId, "mentor_pair", sourceId, made.id);
			imported.add(sourceId);
			active.set(pairKey, made.id);
			result.imported++;
			// The same entry `createMentorship` writes, attributed to the superadmin.
			await logActivity(tx, {
				clubId: input.clubId,
				actorMemberId: null,
				impersonatedBy: input.superadminUserId,
				action: "member_edit",
				targetType: "member",
				targetId: menteeId,
				detail: {
					mentorship: "created",
					mentorshipId: made.id,
					mentorMemberId: mentorId,
					menteeMemberId: menteeId,
					focus: null,
					focusOther: null,
					importId: input.importId,
				},
			});
		}

		await importWillingFlags(tx, {
			clubId: input.clubId,
			importId: input.importId,
			superadminUserId: input.superadminUserId,
			rows,
			sideOf,
			done: willingDone,
			result: result.willing,
		});

		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: null,
			impersonatedBy: input.superadminUserId,
			action: "history_imported",
			targetType: "club",
			targetId: input.clubId,
			detail: {
				importId: input.importId,
				source: SOURCE,
				step: "mentors",
				counts: {
					total: result.total,
					pairs: result.pairs,
					noMentor: result.noMentor,
					imported: result.imported,
					alreadyImported: result.alreadyImported,
					alreadyPaired: result.alreadyPaired,
					skipped: result.skipped.length,
					willingSet: result.willing.set,
					willingAlready: result.willing.alreadyWilling,
					willingPreviouslyImported: result.willing.previouslyImported,
					willingSkipped: result.willing.skipped.length,
				},
			},
		});
		return result;
	});
}
