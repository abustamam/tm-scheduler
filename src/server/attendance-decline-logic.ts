/**
 * What a DECLINE means on the planned-attendance write surface (#663).
 *
 * A member cannot both hold a role and be absent, and the product already knew
 * it: `releaseSlotsAndMarkUnavailable` marks `not_coming` AND frees every slot
 * they hold in that meeting, in one transaction (#204). Until this seam existed
 * that operation had exactly two callers — the season grid and the personal
 * meeting page — and the officer's attendance rail was not one of them. Picking
 * "Not coming" there went through `setPlanStatus` and left the slot alone, so
 * the agenda still listed someone as Toastmaster while their own row two panels
 * away read "Not coming", and the role never returned to the open pool.
 *
 * ## Why the arm decides, and why the decision lives HERE
 *
 * `setPlannedAttendance`'s ladder is WIDER than the season grid's officer path:
 * since #576 `resolveActor` also admits this meeting's Toastmaster on a
 * self-asserted member id with no session, honour-system by design. Releasing
 * roles is materially more destructive than writing a rung — `assigned_member_id
 * = null`, `status = open`, `speech_id = null`, with no undo — so the auto-release
 * is limited to the arms that are either authenticated (officer) or acting on
 * their own row (self). A TMOD picking "Not coming" records the rung and leaves
 * the slot alone; otherwise one forged request per member would empty a
 * meeting's whole programme, which is a bigger power than the "mark everyone
 * asked" ceiling `demoteFrom` was added to cap.
 *
 * That branch is the whole content of this module, and it is a module rather
 * than four lines inside the handler for the reason CODING_STANDARDS.md gives
 * ("WRITES are closed too"): a `createServerFn` handler body cannot be invoked
 * from vitest, so a handler-gated rule is covered by a source grep and nothing
 * else, while a seam is reachable and therefore provable.
 * `attendance-decline.integration.test.ts` executes all four outcomes against a
 * real database.
 *
 * It COMPOSES the existing release rather than reimplementing it. A second copy
 * of "null the assignee, open the slot, unlink the speech, log one `release` per
 * slot" is how the two drift, and the copy would not inherit the seam's own
 * archive assert or its subject check. The cost is that the ladder runs twice on
 * the releasing path — once here to read the arm, once inside
 * `releaseSlotsAndMarkUnavailable`, which takes the RAW claim and must resolve it
 * itself (handing it a finished actor id is the #675 hole). Both resolutions see
 * the same request and agree; the second is a re-verification, not a race. It
 * costs one session + membership lookup on a path a club takes a handful of
 * times per meeting.
 *
 * This module touches `db` and must never be imported by client code.
 */
import type { db } from "#/db";
import { type ResolvedActor, resolveActor } from "./attendance-actor-logic";
import { setPlanStatus } from "./attendance-plan-logic";
import { releaseSlotsAndMarkUnavailable } from "./availability-logic";
import { assertClubNotArchived } from "./guards";

type Database = typeof db;

/**
 * The arms of the D6 ladder whose `not_coming` also frees the member's roles.
 *
 * `officer` is a real session that `requireClubRole(admin)` accepted. `self` is
 * the member's own answer about their own row — the anonymous roster-pick
 * identity the product runs on (#317), and the same basis the personal meeting
 * page already declines-and-releases on.
 *
 * `tmod` is deliberately absent. It is an honour-system claim compared against a
 * member id the public agenda payload already ships as `assigneeId`, so it is
 * reachable by any visitor; granting it a bulk, undoable release of other
 * people's roles is a different order of power from the write ladder it was
 * given in #576. Note the arm ORDER makes this bite one case that reads
 * surprising: a TMOD declining their OWN row resolves to `tmod`, not `self`
 * (officer, then TMOD, then self — self last, or it would swallow the TMOD arm),
 * so their rung is recorded and their slot stays theirs. They still have the
 * agenda's own release control, and the personal meeting page's "Can't make it",
 * which is a confirmed single-subject action rather than a ladder.
 */
export const DECLINE_RELEASING_ARMS: readonly ResolvedActor["via"][] = [
	"officer",
	"self",
];

/**
 * Record `not_coming` for a member, releasing the roles they hold in that
 * meeting when the caller's arm allows it.
 *
 * The caller is responsible for the request-scoped guards its handler owns —
 * the archive gate FIRST (the existence oracle of #544), the meeting lock, and
 * `requireMemberInClub` on the SUBJECT. Authorization of the CALLER is this
 * seam's, through `resolveActor`, exactly as it is for the release it composes.
 */
export async function declinePlannedAttendance(
	database: Database,
	args: {
		/** The member being marked `not_coming` (whose roles may be released). */
		memberId: string;
		/** The actor the CLIENT asserted, if any — an assertion, not proof. Passed
		 *  straight through to both ladders rather than defaulted to the subject:
		 *  that default would make actor === subject for every request and turn the
		 *  self-only check into a no-op (#675). */
		claimedActorMemberId?: string;
		meetingId: string;
		/** ALWAYS the OWNING club, read off the meeting row by the caller (#396) —
		 *  never the `clubId` a request payload carries. */
		clubId: string;
		/** How the change happened, recorded in `activity_log.detail` only. */
		via?: "nudge" | "manual";
	},
): Promise<{ ok: true; changed: boolean; released: number }> {
	// Takedown outranks every other reason to refuse (ADR-0016), so it runs
	// before the ladder — an archived club must not answer differently for an
	// authorized caller than for an unauthorized one. It is this seam's OWN
	// assert, not a duplicate for its own sake: the non-releasing branch below
	// reaches `setPlanStatus` directly, and on a session-less arm nothing else on
	// that path reads `clubs.archived_at` (`requireMembership`'s check, #186,
	// never runs without a session). The releasing branch asserts it again inside
	// `releaseSlotsAndMarkUnavailable`, and the handler asserts it FIRST of all so
	// an archived club cannot be probed through the differing errors of the checks
	// after it (#544).
	await assertClubNotArchived(args.clubId);
	const { actorMemberId, via } = await resolveActor({
		clubId: args.clubId,
		meetingId: args.meetingId,
		memberId: args.memberId,
		claimedActorMemberId: args.claimedActorMemberId,
	});

	if (!DECLINE_RELEASING_ARMS.includes(via)) {
		// Byte-for-byte what `setPlannedAttendance` wrote for this rung before
		// #663, including the absent `demoteFrom` — a deliberate answer may
		// overwrite whatever is on the row, which is the ladder working.
		const { changed } = await setPlanStatus(database, {
			memberId: args.memberId,
			meetingId: args.meetingId,
			clubId: args.clubId,
			status: "not_coming",
			actorMemberId,
			via: args.via,
			grantedVia: via,
		});
		return { ok: true as const, changed, released: 0 };
	}

	const { released } = await releaseSlotsAndMarkUnavailable(database, {
		memberId: args.memberId,
		meetingId: args.meetingId,
		clubId: args.clubId,
		claimedActorMemberId: args.claimedActorMemberId,
	});
	// `changed: true` is a statement about that seam, not a guess: its
	// `setPlanStatus` call carries no `demoteFrom`, so the upsert has no
	// `setWhere` and always returns a row.
	return { ok: true as const, changed: true, released };
}
