import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { db } from "#/db";
import {
	type attendancePlanStatusEnum,
	meetingAttendance,
	meetingAttendancePlan,
	meetings,
	members,
} from "#/db/schema";
import {
	assertMeetingAccepts,
	type MeetingWriteOptions,
} from "#/lib/meeting-lifecycle";
import { SIGN_IN_REQUIRED_MESSAGE, type WriteProof } from "#/lib/write-proof";
import { logActivity } from "./activity";
import type { ResolvedActor } from "./attendance-actor-logic";
import { takeAdvisoryLockWithin } from "./club-write-lock";

// Either the main db client or a drizzle transaction — so callers writing
// inside their own transaction (e.g. `releaseSlotsAndMarkUnavailable`) can
// pass `tx` and commit atomically with the rest of their change.
type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];
type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * The `table.column` of this table's cascading foreign key to `members`, as the
 * guest-conversion undo's FK drift guard spells it (`UNDO_CASCADE_CHECKS`). Here
 * so the table's name stays inside the seam (`attendance-plan-store.guard.test.ts`).
 */
export const ATTENDANCE_PLAN_MEMBER_FK = "meeting_attendance_plan.member_id";

/**
 * Whether the member has ANY RSVP row. An existence check: it returns no plan
 * data. Its caller is the gated guest-conversion undo, which runs it inside its
 * own transaction (`conn`) to refuse before a cascading delete takes the RSVPs
 * (#1202).
 */
export async function memberHasAttendancePlanRows(
	conn: DbOrTx,
	memberId: string,
): Promise<boolean> {
	const rows = await conn
		.select({ meetingId: meetingAttendancePlan.meetingId })
		.from(meetingAttendancePlan)
		.where(eq(meetingAttendancePlan.memberId, memberId))
		.limit(1);
	return rows.length > 0;
}

// DERIVED from the Postgres enum, never hand-listed — see the same warning in
// `./activity.ts`. #510 hit exactly this from the other side: a hand-listed
// union that duplicated `activity_action` drifted from the database, and only
// `tsc` caught it once `vote_open`/`vote_close` were added to the enum.
export type AttendancePlanStatus =
	(typeof attendancePlanStatusEnum.enumValues)[number];

/**
 * The rungs a member may set for THEMSELVES. `reached_out` is missing on
 * purpose: it is an officer's record of having asked, not an answer, so the
 * self-serve surfaces neither write it nor may erase it. Pass this as
 * `onlyFrom` / `demoteFrom` from any session-less caller. As a CLEAR floor it
 * is for a caller whose row it is: whether the caller IS the subject is the
 * actor ladder's question, never this constant's.
 */
export const SELF_SERVICE_RUNGS: readonly AttendancePlanStatus[] = [
	"coming",
	"not_coming",
];

/**
 * The rungs an OFFICER's "No answer" may delete — the exact complement of
 * {@link SELF_SERVICE_RUNGS}, and defined beside it so the symmetry is readable
 * rather than inferred (#573).
 *
 * A member may clear their own ANSWER; an officer may clear the ASK. Neither may
 * erase the other's. The officer arm used to pass no floor at all, which meant
 * "No answer" could destroy a reply that arrived since the panel rendered —
 * dropping that member off `unavailableMembers` and out of the recruit picker's
 * warning, so they could be handed a role they had declined.
 *
 * Correcting a wrong answer is the SET path, not this one.
 */
export const CLEARABLE_ASK: readonly AttendancePlanStatus[] = ["reached_out"];

/** What an officer may delete from THEIR OWN row: their own answer and the ask. */
const OFFICER_OWN_ROW_RUNGS: readonly AttendancePlanStatus[] = [
	...SELF_SERVICE_RUNGS,
	...CLEARABLE_ASK,
];

/**
 * The floor that deletes NOTHING: the Toastmaster's clear of ANOTHER member's
 * row. Named rather than a bare `[]` so the intent reads at the call site and a
 * "tidy-up" to an empty literal is not mistaken for a leftover. It is safe as
 * an `onlyFrom` because drizzle compiles `inArray(col, [])` to `false` — a
 * delete that matches no row, not one that matches every row — which
 * `clearPlanStatus` documents beside the predicate.
 *
 * Neither floor fits that caller. `SELF_SERVICE_RUNGS` would let them erase
 * another member's own answer; `CLEARABLE_ASK` would let them erase an
 * officer's ask, which the Toastmaster arm never could (its claim can be
 * honour-system, and its id is published on the public agenda payload).
 */
export const NO_CLEARABLE_RUNGS: readonly AttendancePlanStatus[] = [];

/**
 * The `onlyFrom` floor for `clearPlannedAttendance`: which rungs this caller's
 * "No answer" may delete.
 *
 * A member's ANSWER is cleared by that member, or by an officer acting
 * deliberately on the season grid (`clearAvailability`), and by nobody else.
 * #573's floor stops an officer's "No answer" destroying ANOTHER member's reply
 * on this path too, and this function extends the same rule to the Toastmaster.
 * Each arm may clear its OWN row, and an officer may also clear the ASK on
 * anyone's:
 *
 *   officer, own row      their answer and the ask  (OFFICER_OWN_ROW_RUNGS)
 *   officer, another row  the ask only              (CLEARABLE_ASK)
 *   tmod, own row         their answer              (SELF_SERVICE_RUNGS)
 *   tmod, another row     nothing                   (NO_CLEARABLE_RUNGS)
 *   self                  their answer              (SELF_SERVICE_RUNGS)
 *
 * The self arm needs no row test: `resolveActor` throws `SELF_ONLY_MESSAGE`
 * unless its actor IS the subject, so that arm only ever reaches here on its
 * own row.
 *
 * `actorMemberId` is trustworthy here because `clearPlannedAttendance` runs
 * `requireSessionActor` BEFORE `resolveActor`: with a session bound to a member
 * of this club, `resolveWriteActorWithProof` answers with that membership and
 * ignores the claimed id, so the tmod arm's actor is the SESSION's own member
 * and cannot be asserted into equalling a subject. (Without that gate a visitor
 * could claim the Toastmaster's published id and "clear their own row", which
 * is the honour-system shape ADR-0026 removed.) The officer arm's is the
 * session's `membership.id` outright. A `null` actor (an impersonating
 * superadmin has no member row) equals no id, so is never "self".
 */
export function clearFloor(args: {
	via: ResolvedActor["via"];
	actorMemberId: string | null;
	memberId: string;
}): readonly AttendancePlanStatus[] {
	const ownRow = args.actorMemberId === args.memberId;
	switch (args.via) {
		case "officer":
			return ownRow ? OFFICER_OWN_ROW_RUNGS : CLEARABLE_ASK;
		case "tmod":
			return ownRow ? SELF_SERVICE_RUNGS : NO_CLEARABLE_RUNGS;
		case "self":
			return SELF_SERVICE_RUNGS;
	}
}

/**
 * The rungs that are NOT a member's own answer, and so still count as BLANK for
 * a fill-blank write (#762).
 *
 * ADR-0026's line is "an unverified pick may fill a blank", and `reached_out`
 * IS a blank by that definition: it is the officer's record of having ASKED,
 * not a reply, which is the same sentence {@link CLEARABLE_ASK} is built on and
 * the reason `SELF_SERVICE_RUNGS` leaves it out. Treating a row as answered
 * because an officer touched it is what took the officer's own nudge round trip
 * off the table — the WhatsApp draft INSERTS `reached_out` onto a blank row
 * (`src/lib/attendance-panel.ts`), and the member then arrives at the
 * session-less personal meeting page to answer and finds BOTH answers refused.
 *
 * Deliberately a SEPARATE constant from `CLEARABLE_ASK` even though both hold
 * exactly `["reached_out"]` today. They are different claims about the same
 * rung — "an officer may delete this" and "a member may still answer over this"
 * — and a fourth rung would not have to join both. Collapsing them would make
 * the next rung's classification a single decision when it is two.
 *
 * It is NOT the full answer to "who put this row here". A `coming` written by
 * `markComingOnSelfClaim` when a session-less member claims a role is not the
 * member's deliberate answer either, and this constant cannot say so because
 * the row records the rung and not its provenance — see `setPlanStatus`'s
 * `onlyIfAbsent` note.
 */
export const UNANSWERED_RUNGS: readonly AttendancePlanStatus[] = [
	"reached_out",
];

/**
 * The invariant the type system cannot state: an ASSERTED write may not
 * overwrite a row without naming a floor (#762 review).
 *
 * `onlyIfAbsent: true` implies `proof: "asserted"` structurally — the union
 * below binds them. The converse does not fit in the union, because one
 * legitimate asserted write is NOT fill-blank: an asserted Toastmaster writing
 * `reached_out` carries `demoteFrom: ["reached_out"]` and is the Phase 2 debt
 * ADR-0026 dates rather than closes (#747). Its call site supplies that floor
 * through a ternary whose exact text `attendance-plan-authz.guard.test.ts`
 * pins, so the branch cannot be split to narrow `proof` at compile time without
 * failing a guard about a different rule.
 *
 * So the residue is checked HERE, once, where every caller passes: an
 * UNFLOORED overwrite (`demoteFrom` absent) carrying `proof: "asserted"` is a
 * programming error and throws. That is strictly more than a type would catch
 * — it sees a `proof` VARIABLE that is asserted at runtime, not only a literal
 * — and it is what replaces the convention the ADR rule was previously held by
 * at three call sites.
 *
 * Not a user-facing refusal: `SIGN_IN_REQUIRED_MESSAGE` is what an asserted
 * caller who tried to overwrite something should see, and reaching this means
 * a caller failed to ask for that mode at all.
 */
export const ASSERTED_OVERWRITE_MESSAGE =
	"setPlanStatus: an asserted write must fill a blank or name a floor (ADR-0026).";

/**
 * What every `setPlanStatus` call carries, whichever write mode it picks.
 *
 * Split from the two modes below so the mutually-exclusive pair is expressed in
 * the TYPE rather than in a comment — see {@link SetPlanStatusArgs}.
 */
interface SetPlanStatusCommon {
	memberId: string;
	meetingId: string;
	clubId: string;
	status: AttendancePlanStatus;
	/** Null is a decision, not an omission: an impersonated write resolves to
	 *  null and `logActivity` stamps the real superadmin for it. */
	actorMemberId: string | null;
	/** How the change happened. Recorded in the activity detail only. */
	via?: "nudge" | "manual" | "connector";
	/** WHICH authorization arm admitted the write, recorded in the activity
	 *  detail. An honour-system TMOD write and a session-authenticated
	 *  officer's are otherwise indistinguishable in the feed — and for a grant
	 *  whose defence is "it is auditable afterwards", the arm is the one thing
	 *  that has to be persisted (#576 review). Optional so the existing
	 *  callers that have no ladder (`setAvailability`, the self-claim path)
	 *  need no change. */
	grantedVia?: "officer" | "tmod" | "self";
	/** HOW the actor's identity was established, recorded as `detail.proof`
	 *  (#762, ADR-0026).
	 *
	 *  `grantedVia` beside it answers a DIFFERENT question and neither implies
	 *  the other: two of the three arms admit a signed-in member and an
	 *  asserted roster pick alike, so a feed carrying only the arm cannot say
	 *  whether the row in front of you was written by the person it names. The
	 *  pair is what makes an honour-system write auditable rather than merely
	 *  attributed.
	 *
	 *  Optional, so the callers with no ladder to read it off — `setContacted`,
	 *  `markComingOnSelfClaim`, `confirmSlot`'s self arm — need no change;
	 *  absent means the detail simply omits the key, as `grantedVia` already
	 *  does.
	 *
	 *  READ THE ABSENCE HONESTLY. It does NOT mean "not asserted". Three plan
	 *  writers are still session-less and pass none, so a row with no `proof`
	 *  is "written before #762, or by a writer that has no ladder to read it
	 *  off" — which includes writes that WERE asserted. Only a present value
	 *  carries information, and `"asserted"` is the one that carries the most.
	 *  The seam cannot fix that: a mandatory field would make the three
	 *  ungated writers state a proof they have not resolved.
	 *
	 *  Bound to `"asserted"` on the fill-blank arm below, and refused as an
	 *  unfloored overwrite by {@link ASSERTED_OVERWRITE_MESSAGE}. */
	proof?: WriteProof;
}

/**
 * The two write modes, mutually exclusive BY TYPE (#762).
 *
 * `demoteFrom` narrows which existing rows may be overwritten; `onlyIfAbsent`
 * refuses to overwrite at all. A call carrying both would be asking the
 * database two incompatible questions in one statement, and the shape that
 * would actually be written — the `onConflictDoNothing` arm — silently ignores
 * the other, so the union is what stops a caller believing a floor applied when
 * nothing was floored.
 */
export type SetPlanStatusArgs = SetPlanStatusCommon &
	(
		| {
				/** Overwrite an EXISTING row only when its status is one of these. Omit
				 *  to overwrite any, which is right for a deliberate answer: moving UP
				 *  the ladder from `reached_out` to `coming`/`not_coming` is the whole
				 *  point of the feature, and a caller recording the member's answer
				 *  must never be blocked from it. Two callers move the other way and do
				 *  need it:
				 *
				 *  - `setContacted` passes `["reached_out"]` so ticking "contacted" can
				 *    never demote a real answer back to "I asked them". Without it, an
				 *    officer working from a list that rendered a moment ago erases the
				 *    decline that arrived since — and because `unavailableMembers` is
				 *    `not_coming` only, that member silently drops off the meeting
				 *    page's Not Available list AND loses the warning in the assign
				 *    picker, so the VPE hands a role to someone who said they cannot
				 *    come.
				 *  - `markComingOnSelfClaim` passes `["reached_out", "not_coming"]`,
				 *    which both skips the redundant write when the row already says
				 *    `coming` and makes that de-dup ATOMIC. It used to be a SELECT
				 *    followed by an upsert, and two concurrent claims by the same
				 *    member both read "not coming yet" and both logged.
				 *
				 *  Note the list names the statuses that may be REPLACED, not the ones
				 *  that may be written; a caller wanting "re-affirming the same rung
				 *  still logs" includes `args.status` in its own list. */
				demoteFrom?: readonly AttendancePlanStatus[];
				onlyIfAbsent?: false;
		  }
		| {
				/** FILL A BLANK and nothing else — ADR-0026's line, drawn for a caller
				 *  whose identity was only asserted (#762).
				 *
				 *  An unverified roster pick may record a member's FIRST answer,
				 *  because a blank row and a name typed on a paper sign-up sheet carry
				 *  the same weight. It may not change one, because changing one
				 *  destroys something a person put there and nothing about the request
				 *  says the two people are the same.
				 *
				 *  Three outcomes, and the middle one is why this is not simply a
				 *  refusal: no row ⇒ insert and log, as any other write;
				 *  a row that ALREADY says `status` ⇒ `changed: false`, no throw and
				 *  no log, so re-tapping an answer you already gave is a no-op rather
				 *  than a lecture; a row saying anything else ⇒
				 *  {@link SIGN_IN_REQUIRED_MESSAGE}, which the client turns into a
				 *  toast carrying a one-tap sign-in link.
				 *
				 *  "Blank" means no row OR a row holding only
				 *  {@link UNANSWERED_RUNGS} — the officer's ask is not an answer, so
				 *  writing over it is still filling a blank. See that constant for
				 *  the nudge round trip this exists to keep working, and for the one
				 *  case it cannot see.
				 *
				 *  The insert and the conflict test are ONE statement, so two
				 *  simultaneous first answers cannot both write. */
				onlyIfAbsent: true;
				demoteFrom?: undefined;
				/** BOUND to this arm (#762 review). Fill-blank mode exists for one
				 *  kind of caller and raises a refusal — {@link SIGN_IN_REQUIRED_MESSAGE}
				 *  — that is meaningless for any other, so the two travel together
				 *  rather than by convention at each call site.
				 *
				 *  The converse is NOT expressible here and is enforced at runtime
				 *  instead: see {@link ASSERTED_OVERWRITE_MESSAGE}. */
				proof: "asserted";
		  }
	);

/**
 * What the seam asks of a meeting's status (#1057, #1137), by write class: who is
 * EXPECTED at a meeting is what is intended for one that has not happened, so
 * `setPlanStatus` and `clearPlanStatus` ask the `plan` class, which refuses
 * cancelled and completed. Here in the seam rather than in its dozen callers,
 * for the reason the seam exists: one place where "may this row change" is true
 * or false.
 *
 * `accept: ["completed"]` is the override that keeps this seam exactly as it
 * was: it refuses CANCELLED and nothing else. A completed meeting stays refused
 * by the callers that mean to (each of `attendance-plan.ts`, `availability.ts`,
 * `outreach.ts` and the plan slot writers calls the lock ahead of its own
 * checks, so a locked meeting is refused before a subject or a session is
 * looked at) and ACCEPTED here, because one caller reaches this seam on a
 * completed meeting on purpose: `attachSpeechToOpenSlot` is a `record` write,
 * and when its actor owns the speech it records them as coming through
 * `markComingOnSelfClaim`. Refusing completed here would answer "This meeting
 * is locked." to a member scheduling their own speech into an open slot of a
 * meeting main accepts it on, while an officer still can.
 *
 * `meeting-writers.guard.test.ts` holds both halves: each writer's own body
 * calls the helper with THIS constant (so deleting the call, or widening the
 * option, fails it), and the callers that keep completed refused are named in
 * the writers' `overrides.completed`, so a new caller has to refuse or be
 * classified. The call sits in each writer rather than in a shared helper
 * because the guard reads an override only from the writer that declares it.
 *
 * The status is read through the CALLER's handle, so a writer inside a
 * transaction compares against its own view, and as its own statement, so a
 * cancel committed before it is seen. There is no lock to re-read behind —
 * these writes take an advisory lock on the member, never the meeting row — and
 * the INSERT below is an upsert whose insert arm cannot carry a predicate
 * without rebuilding it as an INSERT … SELECT. A cancel that commits between
 * this read and that write is the window #1057 accepted when it declined a new
 * lock; the plan row it leaves is harmless, since every reader of a cancelled
 * meeting's plan is a reader of a meeting that no longer happens. A meeting
 * that does not exist is left to the FK: this gate answers one question only.
 */
const PLAN_SEAM_WRITE_OPTIONS = {
	accept: ["completed"],
} as const satisfies Pick<MeetingWriteOptions, "accept">;

/** The meeting's status on the caller's handle, or null when there is no such meeting. */
async function meetingStatusOf(
	database: DbOrTx,
	meetingId: string,
): Promise<string | null> {
	const [row] = await database
		.select({ status: meetings.status })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	return row?.status ?? null;
}

/**
 * THE only module that reads or writes `meeting_attendance_plan`, apart from the
 * membership merge (`membership-collapse-logic.ts`), which re-points `member_id`
 * in raw SQL and is waived by name in `attendance-plan-store.guard.test.ts`.
 *
 * Row absent = "no answer"; there is no fourth enum value for it, because a row
 * that means "nothing is known" is a row every reader has to remember to ignore.
 *
 * `not_coming` is the sole encoding of "unavailable" in the database. Anything
 * asking "is this member out?" MUST come through here rather than testing for
 * row presence — the whole point of the consolidation is that presence no
 * longer answers that question.
 *
 * WHAT THIS SEAM OWNS, precisely: actor attribution, and the two status
 * predicates below. It does NOT own the archive gate or the write ladder — those
 * live in the callers (`attendance-plan.ts` and the legacy delegates). Read that
 * as "the callers decide", NOT as "they need a session": since #576
 * `resolveActor` has a session-less arm for this meeting's Toastmaster, so the
 * `reached_out` rung is officer-only in name only. An earlier draft of this
 * comment claimed the seam owned these, which is exactly how a caller ends up
 * assuming it inherited a check it never got.
 */
export async function setPlanStatus(
	database: DbOrTx,
	args: SetPlanStatusArgs,
): Promise<{ ok: true; changed: boolean }> {
	// The invariant the union cannot state — see ASSERTED_OVERWRITE_MESSAGE.
	// FIRST, before any statement reaches the database, so a miswired caller
	// fails on the call rather than after a partial write.
	if (!args.onlyIfAbsent && args.proof === "asserted" && !args.demoteFrom) {
		throw new Error(ASSERTED_OVERWRITE_MESSAGE);
	}
	const status = await meetingStatusOf(database, args.meetingId);
	if (status !== null) {
		assertMeetingAccepts(status, "plan", PLAN_SEAM_WRITE_OPTIONS);
	}
	const values = {
		memberId: args.memberId,
		meetingId: args.meetingId,
		status: args.status,
	};
	const target = [
		meetingAttendancePlan.memberId,
		meetingAttendancePlan.meetingId,
	];
	const written = args.onlyIfAbsent
		? // NOT `onConflictDoNothing`. "Blank" includes a row holding only the
			// officer's ASK (UNANSWERED_RUNGS), so the conflict arm is an UPDATE
			// floored to those rungs — one statement, so it stays atomic against a
			// concurrent first answer exactly as the do-nothing form was: whichever
			// request lands second sees a real answer, matches no floor, writes
			// nothing and logs nothing.
			await database
				.insert(meetingAttendancePlan)
				.values(values)
				.onConflictDoUpdate({
					target,
					set: { status: args.status, updatedAt: sql`now()` },
					setWhere: inArray(meetingAttendancePlan.status, UNANSWERED_RUNGS),
				})
				.returning({ id: meetingAttendancePlan.id })
		: await database
				.insert(meetingAttendancePlan)
				.values(values)
				.onConflictDoUpdate({
					target,
					// `now()` rather than `new Date()`: `created_at` defaults to the
					// DATABASE clock, and stamping this one from the Node process clock
					// lets skew between the app container and Railway's managed Postgres
					// produce `updated_at < created_at`, or order two app instances'
					// writes wrongly.
					set: { status: args.status, updatedAt: sql`now()` },
					...(args.demoteFrom
						? {
								setWhere: inArray(
									meetingAttendancePlan.status,
									args.demoteFrom,
								),
							}
						: {}),
				})
				.returning({ id: meetingAttendancePlan.id });

	// Nothing written ⇒ the `demoteFrom` floor refused the demotion, or a row was
	// already there and `onlyIfAbsent` refused to touch it. Log nothing either
	// way: a `plan_set` row for a change that did not happen is a lie the
	// activity feed then tells forever.
	if (written.length === 0) {
		if (args.onlyIfAbsent) {
			// Reached only when a row exists holding a real ANSWER — the floor above
			// already absorbed the blank and the officer's ask. Read back through
			// the SAME `database` handle, so a caller inside a transaction compares
			// against its own uncommitted state rather than the world as it was.
			const current = await getPlanStatus(database, {
				memberId: args.memberId,
				meetingId: args.meetingId,
			});
			// An answer that already says what this write says is not an overwrite,
			// so it is not the thing ADR-0026 refuses. Refusing it anyway would
			// make a double-tap — or a retried request off a flaky mobile
			// connection — look like a permission failure to the member who gave
			// the answer in the first place.
			if (current !== args.status) throw new Error(SIGN_IN_REQUIRED_MESSAGE);
		}
		return { ok: true as const, changed: false };
	}

	await logActivity(database, {
		clubId: args.clubId,
		actorMemberId: args.actorMemberId,
		action: "plan_set",
		targetType: "meeting",
		targetId: args.meetingId,
		detail: {
			memberId: args.memberId,
			status: args.status,
			via: args.via ?? "manual",
			...(args.grantedVia ? { grantedVia: args.grantedVia } : {}),
			...(args.proof ? { proof: args.proof } : {}),
		},
	});
	return { ok: true as const, changed: true };
}

/**
 * Back to "no answer" — deletes the row. Idempotent.
 *
 * `onlyFrom` is the delete-side twin of `setPlanStatus`'s `demoteFrom`, and it
 * is what stops a session-less caller destroying officer state. Before the
 * consolidation, erasing "I contacted them" meant deleting a row in the separate
 * outreach table, which took `requireUser()` + `requireClubRole(admin)`. That
 * fact now shares a row with the member's own answer, so a status-blind DELETE
 * reached through the PUBLIC `clearAvailability` would have let anyone wipe it —
 * the officer's chase list silently loses people and they get contacted twice.
 * REQUIRED, since #573 — every caller must name a floor, and the parameter used
 * to be optional with "omit to delete whatever is there (officer-gated callers
 * only)". That permission is how the defect shipped: a one-tap "No answer" menu
 * item was wired to the unfloored clear, so an officer's un-ask could destroy an
 * answer that arrived since the panel rendered. Nobody chose that; omitting a
 * parameter simply looked sanctioned.
 *
 * The two floors in use are exact complements — {@link SELF_SERVICE_RUNGS} for a
 * caller clearing their OWN ANSWER, {@link CLEARABLE_ASK} for an officer
 * clearing the ASK on someone else's row (and the union of the two on their OWN
 * row, see {@link clearFloor}). A Toastmaster clearing ANOTHER member's row gets
 * {@link NO_CLEARABLE_RUNGS}: a member's answer is cleared by that member, or by
 * an officer on the season grid, and by nobody else. Making the argument
 * mandatory means a new caller has to pick one rather than inheriting the widest
 * possible delete by saying nothing.
 */
export async function clearPlanStatus(
	database: DbOrTx,
	args: {
		memberId: string;
		meetingId: string;
		clubId: string;
		actorMemberId: string | null;
		/** Delete only when the current status is one of these. No "clear
		 *  anything" option by design — see the note above. */
		onlyFrom: readonly AttendancePlanStatus[];
	},
): Promise<{ ok: true; cleared: boolean }> {
	const status = await meetingStatusOf(database, args.meetingId);
	if (status !== null) {
		assertMeetingAccepts(status, "plan", PLAN_SEAM_WRITE_OPTIONS);
	}
	const removed = await database
		.delete(meetingAttendancePlan)
		.where(
			and(
				eq(meetingAttendancePlan.memberId, args.memberId),
				eq(meetingAttendancePlan.meetingId, args.meetingId),
				// Unconditional now that `onlyFrom` is required. Note `inArray` with an
				// EMPTY array compiles to `false` in drizzle, so `onlyFrom: []` is a
				// delete that matches nothing rather than one that matches everything
				// — the safe direction, and the reason a required-but-empty argument
				// is not a hole.
				inArray(meetingAttendancePlan.status, args.onlyFrom),
			),
		)
		.returning({ id: meetingAttendancePlan.id });

	// No row removed ⇒ either there was nothing to clear, or the guard refused.
	// Either way nothing changed, so nothing is logged.
	if (removed.length === 0) return { ok: true as const, cleared: false };

	await logActivity(database, {
		clubId: args.clubId,
		actorMemberId: args.actorMemberId,
		action: "plan_set",
		targetType: "meeting",
		targetId: args.meetingId,
		detail: { memberId: args.memberId, status: null },
	});
	return { ok: true as const, cleared: true };
}

/**
 * Fill in a past meeting's plan answers from an import (#1051, D3 of #1196): a
 * bulk fill-if-ABSENT, and nothing else.
 *
 * It is not `setPlanStatus` in a loop, for two reasons that are the whole point:
 * it LOGS NOTHING (a history import of hundreds of answers must not write one
 * `plan_set` row per answer into the club's activity feed; the import logs one
 * `history_imported` row for itself), and it never overwrites. A row that is
 * already there, whatever its rung — a member's own answer, an officer's ask — is
 * left exactly as it is (`ON CONFLICT DO NOTHING`), so re-running an import, or
 * importing over a meeting people have since touched, changes nothing.
 *
 * Gated like every other writer here: a cancelled meeting is refused by the
 * class policy, and so is a scheduled one (it has no lock and no log, so it is
 * only for a meeting nobody decides plans on any more); a completed one is
 * the one thing ACCEPTED, because a past meeting is the only thing a history
 * import writes. The caller (`history-import-logic.ts`,
 * superadmin only) decides which meetings and which members; this function
 * trusts its `memberId`s to be members of the meeting's club, exactly as
 * `setPlanStatus` does.
 *
 * Returns how many rows it inserted.
 */
export const IMPORT_PLAN_STATUS_MESSAGE =
	"Plan answers can only be imported into a completed meeting.";

export async function importPlanAnswers(
	database: DbOrTx,
	args: {
		meetingId: string;
		answers: ReadonlyArray<{ memberId: string; status: AttendancePlanStatus }>;
	},
): Promise<{ inserted: number }> {
	if (args.answers.length === 0) return { inserted: 0 };
	const status = await meetingStatusOf(database, args.meetingId);
	if (status !== null) {
		assertMeetingAccepts(status, "plan", PLAN_SEAM_WRITE_OPTIONS);
		// This path takes no `lockMemberAttendance` and logs nothing, which is only
		// safe on a meeting nobody is deciding plans for any more: the class policy
		// also lets a scheduled meeting through, so a completed one is named here.
		if (status !== "completed") throw new Error(IMPORT_PLAN_STATUS_MESSAGE);
	}
	const written = await database
		.insert(meetingAttendancePlan)
		.values(
			args.answers.map((a) => ({
				memberId: a.memberId,
				meetingId: args.meetingId,
				status: a.status,
			})),
		)
		.onConflictDoNothing()
		.returning({ id: meetingAttendancePlan.id });
	return { inserted: written.length };
}

/** The advisory-lock key `lockMemberAttendance` takes. Exported so the race
 *  test can hold the SAME key. */
export function memberAttendanceLockKey(
	meetingId: string,
	memberId: string,
): string {
	return `attendance:${meetingId}:${memberId}`;
}

/**
 * Serialise a decision on one member's answer for one meeting against the
 * releasing decline that changes it.
 *
 * `releaseSlotsAndMarkUnavailable` frees every role a member holds and then
 * records `not_coming`. An unverified claim in their name reads that answer and
 * refuses over `not_coming` (ADR-0026) — but a read with no lock let a claim
 * check, lose the race to a decline that released everything it could SEE and
 * committed, then flip its still-open slot to the member: a role held by
 * someone who had just said they cannot come, which neither order allows. Both
 * take this key before anything else in their transaction, so one finishes
 * before the other looks. A transaction-scoped bigint advisory lock, like the
 * anonymous ballot's; nothing else takes a key with this prefix.
 *
 * Bounded like the club write lock (`takeAdvisoryLockWithin`): the claim that
 * waits on it needs no session, member ids are public, and every waiter holds
 * one of the pool's ten connections — so a decline stuck behind a slow slot
 * lock could otherwise let a page of public claims starve the process.
 * `timeout` is a parameter only so a test can wait less than the default.
 */
export async function lockMemberAttendance(
	tx: Tx,
	meetingId: string,
	memberId: string,
	timeout?: string,
): Promise<void> {
	await takeAdvisoryLockWithin(
		tx,
		sql`select pg_advisory_xact_lock(hashtextextended(${memberAttendanceLockKey(meetingId, memberId)}, 0))`,
		timeout,
	);
}

/**
 * One member's rung for one meeting, or null for "no answer" (no row).
 *
 * Takes a `DbOrTx` like the writers so a caller inside a transaction reads its
 * OWN uncommitted state — `markComingOnSelfClaim` runs inside the claim's
 * transaction, and reading through the pool client there would see the world as
 * it was before the claim and could act on it.
 */
export async function getPlanStatus(
	database: DbOrTx,
	args: { memberId: string; meetingId: string },
): Promise<AttendancePlanStatus | null> {
	const [row] = await database
		.select({ status: meetingAttendancePlan.status })
		.from(meetingAttendancePlan)
		.where(
			and(
				eq(meetingAttendancePlan.memberId, args.memberId),
				eq(meetingAttendancePlan.meetingId, args.meetingId),
			),
		)
		.limit(1);
	return row?.status ?? null;
}

/**
 * "Can this member take a role?" as one predicate over `members LEFT JOIN plan
 * LEFT JOIN attendance` (#1257). The roll record wins when there is one,
 * otherwise the plan: Absent is unavailable whatever the plan says, Present is
 * available even after Not coming, and Excused (being retired, #1255) and no
 * record both fall through to the plan.
 */
const unavailableNow = or(
	eq(meetingAttendance.status, "absent"),
	and(
		or(
			isNull(meetingAttendance.status),
			ne(meetingAttendance.status, "present"),
		),
		eq(meetingAttendancePlan.status, "not_coming"),
	),
);

function unavailableBase(database: DbOrTx, meetingId: string) {
	return database
		.select({ id: members.id, name: members.name })
		.from(members)
		.innerJoin(
			meetings,
			and(eq(meetings.id, meetingId), eq(meetings.clubId, members.clubId)),
		)
		.leftJoin(
			meetingAttendancePlan,
			and(
				eq(meetingAttendancePlan.memberId, members.id),
				eq(meetingAttendancePlan.meetingId, meetingId),
			),
		)
		.leftJoin(
			meetingAttendance,
			and(
				eq(meetingAttendance.memberId, members.id),
				eq(meetingAttendance.meetingId, meetingId),
			),
		);
}

/**
 * Members who cannot take a role at this meeting, with names, ordered by name:
 * the roll record wins over the plan (see `unavailableNow`). Feeds the
 * pickers' `unavailableMembers`.
 */
export async function listUnavailableWithNames(
	database: DbOrTx,
	meetingId: string,
): Promise<{ id: string; name: string }[]> {
	return unavailableBase(database, meetingId)
		.where(unavailableNow)
		.orderBy(members.name);
}

/**
 * Members recorded `not_coming` in the PLAN, with names, ordered by name. The
 * PUBLIC variant of `listUnavailableWithNames` (#1257): it ignores the roll, so
 * a signed-out reader or a non-member cannot combine it with the public
 * answers to infer who was marked Present or Absent (the roll is members-only).
 */
export async function listNotComingWithNames(
	database: DbOrTx,
	meetingId: string,
): Promise<{ id: string; name: string }[]> {
	return database
		.select({ id: members.id, name: members.name })
		.from(meetingAttendancePlan)
		.innerJoin(members, eq(members.id, meetingAttendancePlan.memberId))
		.where(
			and(
				eq(meetingAttendancePlan.meetingId, meetingId),
				eq(meetingAttendancePlan.status, "not_coming"),
			),
		)
		.orderBy(members.name);
}

/**
 * One member's answer to `listUnavailableWithNames`. Takes a `DbOrTx` so the
 * claim reads its own transaction.
 */
export async function isMemberUnavailable(
	database: DbOrTx,
	args: { memberId: string; meetingId: string },
): Promise<boolean> {
	const rows = await unavailableBase(database, args.meetingId)
		.where(and(eq(members.id, args.memberId), unavailableNow))
		.limit(1);
	return rows.length > 0;
}

/**
 * Is one member's PLAN answer `not_coming` for this meeting? Plan-only
 * unavailability, used by the asserted claim and confirm. Its query holds the
 * club's `members` and `meetings` rows (for club scoping) and the plan table,
 * and no attendance table at all; session and connector callers use
 * `isMemberUnavailable`, which reads both.
 *
 * Club-scoped like `isMemberUnavailable`: a member id from another club is
 * never `not_coming` for this meeting.
 */
export async function isMemberNotComing(
	database: DbOrTx,
	args: { memberId: string; meetingId: string },
): Promise<boolean> {
	const rows = await database
		.select({ id: members.id })
		.from(members)
		.innerJoin(
			meetings,
			and(eq(meetings.id, args.meetingId), eq(meetings.clubId, members.clubId)),
		)
		.innerJoin(
			meetingAttendancePlan,
			and(
				eq(meetingAttendancePlan.memberId, members.id),
				eq(meetingAttendancePlan.meetingId, args.meetingId),
			),
		)
		.where(
			and(
				eq(members.id, args.memberId),
				eq(meetingAttendancePlan.status, "not_coming"),
			),
		)
		.limit(1);
	return rows.length > 0;
}

/** `not_coming` pairs across several meetings (season grid, recurrence check). */
export async function listNotComingForMeetings(
	database: DbOrTx,
	meetingIds: string[],
): Promise<{ memberId: string; meetingId: string }[]> {
	// Short-circuit: an empty `inArray` compiles to `false`, so this guard exists
	// to skip the round-trip, not to change the result.
	if (meetingIds.length === 0) return [];
	return database
		.select({
			memberId: meetingAttendancePlan.memberId,
			meetingId: meetingAttendancePlan.meetingId,
		})
		.from(meetingAttendancePlan)
		.where(
			and(
				inArray(meetingAttendancePlan.meetingId, meetingIds),
				eq(meetingAttendancePlan.status, "not_coming"),
			),
		);
}

/** Every plan row across several meetings, statuses included — the season grid
 *  needs both partitions from one round-trip. */
export async function listPlanForMeetings(
	database: DbOrTx,
	meetingIds: string[],
): Promise<
	{ memberId: string; meetingId: string; status: AttendancePlanStatus }[]
> {
	if (meetingIds.length === 0) return [];
	return database
		.select({
			memberId: meetingAttendancePlan.memberId,
			meetingId: meetingAttendancePlan.meetingId,
			status: meetingAttendancePlan.status,
		})
		.from(meetingAttendancePlan)
		.where(inArray(meetingAttendancePlan.meetingId, meetingIds));
}

/** The plan answers and the roll marks of a set of members across several
 *  meetings, one round-trip each regardless of how many meetings are asked
 *  about. Both are narrowed to `memberIds` IN SQL, so no other member's row
 *  leaves the database: the "my schedule" reads (#1281) ask for the caller's
 *  own membership ids only. */
export async function listMyAttendanceForMeetings(
	database: DbOrTx,
	args: { meetingIds: string[]; memberIds: string[] },
): Promise<{
	plan: { meetingId: string; status: AttendancePlanStatus }[];
	roll: { meetingId: string; status: string }[];
}> {
	const { meetingIds, memberIds } = args;
	// Short-circuit only; an empty `inArray` compiles to `false`.
	if (meetingIds.length === 0 || memberIds.length === 0) {
		return { plan: [], roll: [] };
	}
	const [plan, roll] = await Promise.all([
		database
			.select({
				meetingId: meetingAttendancePlan.meetingId,
				status: meetingAttendancePlan.status,
			})
			.from(meetingAttendancePlan)
			.where(
				and(
					inArray(meetingAttendancePlan.meetingId, meetingIds),
					inArray(meetingAttendancePlan.memberId, memberIds),
				),
			),
		database
			.select({
				meetingId: meetingAttendance.meetingId,
				status: meetingAttendance.status,
			})
			.from(meetingAttendance)
			.where(
				and(
					inArray(meetingAttendance.meetingId, meetingIds),
					inArray(meetingAttendance.memberId, memberIds),
				),
			),
	]);
	return { plan, roll };
}

/** `reached_out` member ids for one meeting — the old "contacted" set.
 *
 *  NO production caller since the panel landed: `meetings.ts` now takes the
 *  whole ladder in one `listPlanForMeetings` round trip and splits it. Kept
 *  deliberately, not stranded — this and `listComingForMeeting` are the seam's
 *  single-status readers, and `attendance-plan-store.guard.test.ts` requires
 *  every plan-table query to live in this module, so the next consumer that
 *  wants one status has somewhere to come rather than a reason to inline a
 *  query. Delete them only together with that need. */
export async function listReachedOutForMeeting(
	database: DbOrTx,
	meetingId: string,
): Promise<string[]> {
	return listMemberIdsWithStatus(database, meetingId, "reached_out");
}

/** `coming` member ids for one meeting. No pre-consolidation equivalent — the
 *  old pair could not express a positive answer at all — so every consumer of
 *  this is new, starting with the outreach panel, which would otherwise put a
 *  member who said yes into the "still to ask" list. */
export async function listComingForMeeting(
	database: DbOrTx,
	meetingId: string,
): Promise<string[]> {
	return listMemberIdsWithStatus(database, meetingId, "coming");
}

async function listMemberIdsWithStatus(
	database: DbOrTx,
	meetingId: string,
	status: AttendancePlanStatus,
): Promise<string[]> {
	const rows = await database
		.select({ memberId: meetingAttendancePlan.memberId })
		.from(meetingAttendancePlan)
		.where(
			and(
				eq(meetingAttendancePlan.meetingId, meetingId),
				eq(meetingAttendancePlan.status, status),
			),
		);
	return rows.map((r) => r.memberId);
}
