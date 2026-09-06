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
 * ## `releaseHeldRoles` is the STALE-TAB GATE, and it is the load-bearing one
 *
 * Read this before touching the flag or its default. `setPlannedAttendance`'s
 * URL, method and payload shape did not change when #663 landed — only the
 * server's side effect did. Push-to-main auto-deploys (ADR-0007), and
 * `public/sw.js` calls `skipWaiting()` + `clients.claim()` while the only
 * `controllerchange` listener just sets a flag, so an open tab never reloads.
 * Without a gate, every release would mean: an officer with the rail open sends
 * exactly the request they have always sent, and gets a destructive release with
 * no dialog (their bundle has no `DeclineReleaseDialog`) and no toast. It does
 * not even undo cleanly — re-claiming a freed slot runs `attachSpeechToSlot`,
 * which INSERTs a new speech row and orphans the original.
 *
 * That is CLAUDE.md's `method`-flip hazard, minus the part that makes a flip
 * survivable: a flipped verb fails loudly with a 405 the router surfaces, and
 * this would succeed silently.
 *
 * So the release is OPT-IN on a field the old client cannot send, and the flag
 * is a REQUIRED parameter here rather than an optional one defaulting to true:
 * false means "record the rung, free nothing", which is byte-for-byte the
 * pre-#663 behaviour, and that is what a caller who has not thought about it
 * gets. `attendance-decline-wiring.guard.test.ts` pins the zod default, because
 * `.default(true)` is a one-token edit that reopens the whole window.
 *
 * ## The arm gate is a PRODUCT CEILING, not a security boundary
 *
 * Stated plainly because an earlier draft of this file claimed otherwise and the
 * claim was disproved by execution. `DECLINE_RELEASING_ARMS` withholds the
 * release from a Toastmaster acting on ANOTHER member's row. It stops nothing an
 * attacker wants: `resolveActor`'s last arm resolves a caller who asserted
 * NOTHING to the subject and returns `via: "self"`, which releases — so the
 * cheap forgery is to omit `claimedActorMemberId` entirely, one request per
 * member, and it logs the victim as the actor.
 * `availability.integration.test.ts:468` has asserted exactly that for the
 * sibling endpoint since #675, and the case below marked THE RESIDUAL asserts it
 * here.
 *
 * That is the product's identity model (#317) — the same honour system
 * `claimSlot` and `releaseSlot` run on — and closing it is a much larger change
 * than this one. What the arm gate buys is a real but narrower thing: a
 * Toastmaster running the panel cannot sweep a meeting's whole programme in a
 * few honest taps. Keep it for that. Do not defend it as authorization.
 *
 * ## Why the branch lives HERE
 *
 * A `createServerFn` handler body cannot be invoked from vitest, so a
 * handler-gated rule is covered by a source grep and nothing else
 * (CODING_STANDARDS.md, "WRITES are closed too"). A seam is reachable and
 * therefore provable; `attendance-decline.integration.test.ts` executes every
 * outcome against a real database.
 *
 * It COMPOSES the existing release rather than reimplementing it. A second copy
 * of "null the assignee, open the slot, unlink the speech, log one `release` per
 * slot" is how the two drift, and the copy would not inherit the seam's own
 * archive assert or its subject check. The cost is that the ladder runs twice on
 * the releasing path — once here to read the arm, once inside
 * `releaseSlotsAndMarkUnavailable`, which takes the RAW claim and must resolve it
 * itself (handing it a finished actor id is the #675 hole). Both resolutions see
 * the same request and agree.
 *
 * This module touches `db` and must never be imported by client code.
 */
import { eq } from "drizzle-orm";
import type { db } from "#/db";
import { clubs, meetings } from "#/db/schema";
import { isMeetingOver } from "#/lib/meeting-lifecycle";
import { type ResolvedActor, resolveActor } from "./attendance-actor-logic";
import { setPlanStatus } from "./attendance-plan-logic";
import { releaseSlotsAndMarkUnavailable } from "./availability-logic";
import { assertClubNotArchived } from "./guards";

type Database = typeof db;

/** Refusal when a release is asked for on a meeting that has already happened.
 *  Exported so a test compares against THIS string rather than a copy. */
export const RELEASE_AFTER_MEETING_MESSAGE =
	"That meeting has already happened, so its roles can't be released.";

/**
 * The arms of the D6 ladder whose `not_coming` also frees the member's roles.
 *
 * `officer` is a real session that `requireClubRole(admin)` accepted. `self` is
 * the member's own answer about their own row.
 *
 * The `tmod` arm is admitted for the Toastmaster's OWN row and withheld for
 * everyone else's — see `mayRelease` below, which is where that split is
 * expressed, because it needs the subject as well as the arm. Arm ORDER is what
 * makes the own-row case need saying at all: `resolveActor` runs officer → TMOD
 * → self (self last, or a TMOD writing their own row would satisfy the self test
 * and swallow the TMOD arm), so a Toastmaster declining for themselves resolves
 * to `tmod`. Leaving that on the withholding side meant the one member most
 * likely to hold a role got the one answer that silently kept it.
 */
export const DECLINE_RELEASING_ARMS: readonly ResolvedActor["via"][] = [
	"officer",
	"self",
];

/** Whether this arm, acting on this subject, frees the subject's roles. Split
 *  out so the own-row TMOD case is one readable expression rather than a
 *  condition buried in a branch. */
function mayRelease(actor: ResolvedActor, subjectMemberId: string): boolean {
	if (DECLINE_RELEASING_ARMS.includes(actor.via)) return true;
	// The Toastmaster's own answer about their own attendance. Compared against
	// the RESOLVED actor, never the raw claim: on this arm `actorMemberId` is the
	// caller `resolveWriteActor` club-scoped and `resolveActor` then matched
	// against the meeting's TMOD slot, so this reads "the Toastmaster is the
	// subject" and not "the request said so".
	return actor.via === "tmod" && actor.actorMemberId === subjectMemberId;
}

/** Refuse a release once the meeting's club-local day has PASSED.
 *
 *  `assertMeetingNotLocked` is `status === "completed"` and nothing else, and
 *  clubs routinely never press Complete — so last month's meeting sits at
 *  "scheduled" forever while its nudge link stays in a chat scrollback. A
 *  release there nulls `assigned_member_id` and `speech_id` on every slot the
 *  member held and erases the record of who actually did what.
 *  `personal-meeting-body.tsx` defends exactly this case, and defends it CLIENT
 *  side only; this is the server half.
 *
 *  `isMeetingOver`, the repo's one definition of a closed planning window
 *  (#393) — completed-or-day-passed, so it also covers the locked case rather
 *  than sitting beside it. Asserted only when a release is actually asked for:
 *  recording the RUNG on a past meeting is harmless and is what the pre-#663
 *  client does, and newly rejecting it would break a stale tab in the other
 *  direction. */
async function assertReleasableWindow(
	database: Database,
	meetingId: string,
): Promise<void> {
	const [row] = await database
		.select({
			status: meetings.status,
			scheduledAt: meetings.scheduledAt,
			timezone: clubs.timezone,
		})
		.from(meetings)
		.innerJoin(clubs, eq(clubs.id, meetings.clubId))
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!row) throw new Error("Meeting not found.");
	if (isMeetingOver(row)) throw new Error(RELEASE_AFTER_MEETING_MESSAGE);
}

/**
 * Record `not_coming` for a member, releasing the roles they hold in that
 * meeting when the caller asked for it AND their arm allows it.
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
		/**
		 * The caller has shown someone what would be freed and they said yes.
		 *
		 * REQUIRED, and false is the safe answer: see this module's header. A
		 * client that predates #663 cannot send it, and must keep getting the rung
		 * write it has always got rather than a silent, unrecoverable release
		 * during the deploy window.
		 */
		releaseHeldRoles: boolean;
		/** How the change happened, recorded in `activity_log.detail` only. */
		via?: "nudge" | "manual";
	},
): Promise<{ ok: true; changed: boolean; released: number }> {
	// Takedown outranks every other reason to refuse (ADR-0016), so it runs
	// before everything else — an archived club must not answer differently for
	// an authorized caller than for an unauthorized one. It is this seam's OWN
	// assert, not a duplicate for its own sake: the non-releasing branch below
	// reaches `setPlanStatus` directly, and on a session-less arm nothing else on
	// that path reads `clubs.archived_at` (`requireMembership`'s check, #186,
	// never runs without a session). The releasing branch asserts it again inside
	// `releaseSlotsAndMarkUnavailable`, and the handler asserts it FIRST of all so
	// an archived club cannot be probed through the differing errors of the checks
	// after it (#544).
	await assertClubNotArchived(args.clubId);
	if (args.releaseHeldRoles) {
		await assertReleasableWindow(database, args.meetingId);
	}
	const actor = await resolveActor({
		clubId: args.clubId,
		meetingId: args.meetingId,
		memberId: args.memberId,
		claimedActorMemberId: args.claimedActorMemberId,
	});

	// BOTH conditions, and the flag first: a caller that did not ask for a
	// release never reaches the arm question at all.
	const releasing = args.releaseHeldRoles && mayRelease(actor, args.memberId);

	if (!releasing) {
		// Byte-for-byte what `setPlannedAttendance` wrote for this rung before
		// #663, including the absent `demoteFrom` — a deliberate answer may
		// overwrite whatever is on the row, which is the ladder working.
		const { changed } = await setPlanStatus(database, {
			memberId: args.memberId,
			meetingId: args.meetingId,
			clubId: args.clubId,
			status: "not_coming",
			actorMemberId: actor.actorMemberId,
			via: args.via,
			grantedVia: actor.via,
		});
		return { ok: true as const, changed, released: 0 };
	}

	const { released } = await releaseSlotsAndMarkUnavailable(database, {
		memberId: args.memberId,
		meetingId: args.meetingId,
		clubId: args.clubId,
		claimedActorMemberId: args.claimedActorMemberId,
		// FORWARDED, not dropped. Without it the DESTRUCTIVE branch records less
		// provenance in `activity_log.detail` than the harmless one above — the
		// feed would say `via: "manual"` for every release however it was
		// triggered, which is backwards for the branch whose audit trail is the
		// only record that survives it.
		via: args.via,
	});
	// `changed: true` is a statement about that seam, not a guess: its
	// `setPlanStatus` call carries no `demoteFrom`, so the upsert has no
	// `setWhere` and always returns a row.
	return { ok: true as const, changed: true, released };
}
