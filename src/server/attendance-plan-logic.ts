import { and, eq, inArray, sql } from "drizzle-orm";
import type { db } from "#/db";
import {
	type attendancePlanStatusEnum,
	meetingAttendancePlan,
	members,
	roleSlots,
} from "#/db/schema";
import { resolveEffectiveRung } from "#/lib/attendance-panel";
import { SIGN_IN_REQUIRED_MESSAGE, type WriteProof } from "#/lib/write-proof";
import { logActivity } from "./activity";

// Either the main db client or a drizzle transaction — so callers writing
// inside their own transaction (e.g. `releaseSlotsAndMarkUnavailable`) can
// pass `tx` and commit atomically with the rest of their change.
type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

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
 * `onlyFrom` / `demoteFrom` from any session-less caller.
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
	via?: "nudge" | "manual";
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
 * self/TMOD caller clearing an ANSWER, {@link CLEARABLE_ASK} for an officer
 * clearing the ASK. Making the argument mandatory means a new caller has to pick
 * one rather than inheriting the widest possible delete by saying nothing.
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

/** Members marked `not_coming`, with names, for one meeting — ordered by name. */
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

/** `coming` member ids for one meeting — STORED rungs only, so a member whose
 *  only signal is a confirmed role slot is NOT here. That is the narrower of the
 *  two answers to "who is coming?" and it is kept narrow on purpose rather than
 *  widened in place: widening it would silently change what every caller gets.
 *  A consumer that wants the answer the officer's rail shows wants
 *  {@link listEffectiveComingForMeeting} instead (#664).
 *
 *  No pre-consolidation equivalent — the old pair could not express a positive
 *  answer at all — so every consumer of this is new, starting with the outreach
 *  panel, which would otherwise put a member who said yes into the "still to
 *  ask" list. */
export async function listComingForMeeting(
	database: DbOrTx,
	meetingId: string,
): Promise<string[]> {
	return listMemberIdsWithStatus(database, meetingId, "coming");
}

/**
 * Who is coming to one meeting, by the SAME rule the officer's rail and roll
 * mode apply (`resolveEffectiveRung`, `src/lib/attendance-panel.ts`): an
 * explicit `coming`, or a CONFIRMED role slot with no explicit answer, which
 * comes back `assumed: true` (#664). The server half of the one answer to "who
 * is coming?" — before it, the inference lived only in the rail's component and
 * any server consumer got the smaller, stored-only set from
 * {@link listComingForMeeting}.
 *
 * `assumed` is not optional decoration: it is the difference between "they said
 * yes" and "an officer put them on the programme and nobody asked", and a
 * consumer that flattens it renders an inference as an answer.
 *
 * Reads `role_slots` as well as the plan table, which is why it is a separate
 * reader rather than a widened `listComingForMeeting`. Like that reader it does
 * NOT filter to the active roster — the rail does that from its own roster
 * payload — and it carries no archive gate, which belongs to the caller (see
 * CODING_STANDARDS.md, "The seam does NOT carry the archive gate"). A member
 * holding two slots appears once. Sorted by member id so the result is
 * deterministic.
 */
export async function listEffectiveComingForMeeting(
	database: DbOrTx,
	meetingId: string,
): Promise<{ memberId: string; assumed: boolean }[]> {
	const [plan, confirmed] = await Promise.all([
		database
			.select({
				memberId: meetingAttendancePlan.memberId,
				status: meetingAttendancePlan.status,
			})
			.from(meetingAttendancePlan)
			.where(eq(meetingAttendancePlan.meetingId, meetingId)),
		database
			.selectDistinct({ memberId: roleSlots.assignedMemberId })
			.from(roleSlots)
			.where(
				and(
					eq(roleSlots.meetingId, meetingId),
					eq(roleSlots.status, "confirmed"),
				),
			),
	]);

	const stored = new Map(plan.map((p) => [p.memberId, p.status]));
	const confirmedIds = new Set(
		confirmed.flatMap((c) => (c.memberId ? [c.memberId] : [])),
	);

	const result: { memberId: string; assumed: boolean }[] = [];
	for (const memberId of new Set([...stored.keys(), ...confirmedIds])) {
		const { status, assumed } = resolveEffectiveRung(
			stored.get(memberId) ?? null,
			{ confirmed: confirmedIds.has(memberId) },
		);
		if (status === "coming") result.push({ memberId, assumed });
	}
	return result.sort((a, b) => a.memberId.localeCompare(b.memberId));
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
