/**
 * Recording the times the Timer measured (#730) — the write behind
 * `meeting_timings`, with its own actor ladder.
 *
 * ## Why this is a plain server fn and not the offline minutes queue
 *
 * The rest of the minutes RECORD (attendance, Table Topics speakers, awards)
 * goes through `use-offline-minutes`. This does not, for three verified
 * reasons, and the newest section of the record — action items (#529) — already
 * set the precedent by writing through a plain server fn:
 *
 *  - the queue is client-only, keyed on `meetingId`, and SEEDED from an online
 *    `getMinutes` snapshot drained from the signed-in meeting route. `/me/timer`
 *    is session-less by design, reached from a chat link, with no session and
 *    no snapshot to seed from;
 *  - `derive-minutes.ts` closes its `switch (op.type)` with `const _never: never
 *    = op`, so a new `MinutesOp` variant is a TYPECHECK failure there until it
 *    is handled — and the reducer it lives in has no timing state to reduce;
 *  - `use-offline-minutes-instance.guard.test.ts` keeps an exhaustive
 *    `toEqual` allowlist of the two files that may instantiate the hook.
 *
 * ## The ladder, and how it differs from the one it is modelled on
 *
 * `attendance-actor-logic.ts`'s `resolveActor` is the shape: officer, then this
 * meeting's TMOD, then a self-asserted arm, in that ORDER because putting self
 * first swallows the TMOD arm whole. What differs is the third arm's MEANING. A
 * planned-attendance write has a subject member, so "self" there is "the caller
 * is the subject". A timing has no subject member, so "self" here is "the
 * caller holds this meeting's Timer slot" — which is why this is its own
 * function rather than a call into that one.
 *
 * `requireClubRole(user.id, clubId, ["admin"])` is the officer arm, and it is
 * what "club admin/VPE" means in this schema: `clubRole` is `admin | member`
 * only, and the widening to an officer holding an open officer position lives
 * inside that guard rather than in a second list here.
 *
 * THE TRUST MODEL, stated because it is a widening. On the anonymous path both
 * non-officer arms are HONOUR-SYSTEM claims: `resolveWriteActor` club-scopes
 * the asserted member id, but nothing proves the caller is that person, and the
 * id is not secret — `loadMeetingDetail` publishes it as `assigneeId`. That is
 * the same basis on which a self-asserted TMOD already edits the agenda and
 * sets another member's planned attendance (#317/#576), and it is why the arm
 * is PERSISTED: a grant defended as auditable afterwards is only auditable
 * while the arm that admitted it is recorded accurately.
 *
 * ## The meeting lock does NOT apply here
 *
 * A `completed` meeting refuses every AGENDA mutation. A timing is not agenda
 * content — it is part of the minutes record, and minutes are written after the
 * meeting by definition, which is why `setAttendance`'s gates are the day check
 * and not `status` either. So a completed meeting ACCEPTS a timing write, a
 * cancelled one refuses it, and an archived club throws rather than collapsing
 * to not-found (#555). Borrowing the agenda-lock helper here would make the
 * record unwritable at exactly the moment it is meant to be written.
 *
 * ## Two things this file must discuss in PROSE rather than in code shape
 *
 * `timings-authz.guard.test.ts` reads this file RAW for its offender lists, and
 * `guard-source.ts` explains why that is right: stripping comments there could
 * only ever LOOSEN the check. The cost is that a comment quoting a forbidden
 * spelling fails the sweep. So the agenda-lock helper is named descriptively
 * above rather than by its identifier, and the inline key comparison the actor
 * ladder must not make is described rather than quoted. Same rule
 * `role-duties.ts` records for its own db-import sweep.
 *
 * This module touches `db` and must never be imported by client code.
 */
import { eq } from "drizzle-orm";
import { db } from "#/db";
import {
	meetings,
	meetingTimings,
	roleDefinitions,
	roleSlots,
	type timingGrantedViaEnum,
} from "#/db/schema";
import { findTimerSlot, findTmodSlot } from "#/lib/meeting-roles";
import { isTimeableRole, TimingNotRecordableError } from "#/lib/timeable-roles";
import { logActivity } from "./activity";
import {
	assertClubNotArchived,
	getSessionUser,
	NO_PERMISSION_MESSAGE,
	NOT_A_MEMBER_MESSAGE,
	type ResolvedMembership,
	requireClubRole,
} from "./guards";
import { resolveWriteActor } from "./write-actor-logic";

/** Which arm admitted the write — the pgEnum's own union, DERIVED so the two
 *  cannot drift (the mistake `logActivity`'s hand-listed action union made). */
export type TimingGrantedVia = (typeof timingGrantedViaEnum.enumValues)[number];

/** The caller holds none of the three capabilities. Its own message, distinct
 *  from `TimingNotRecordableError`: that one means "there is nothing here to
 *  record against", this one means "not you". */
export const TIMING_NOT_PERMITTED_MESSAGE =
	"Only this meeting's Timer, its Toastmaster or a club officer can record a time.";

/** A self-asserted Timer may ADD their own answer; replacing somebody else's
 *  record needs the officer or Toastmaster arm. Same floor, and the same
 *  reason, as planned attendance's. */
export const TIMING_OVERWRITE_MESSAGE =
	"Someone else already recorded a time for this segment. Ask an officer or the Toastmaster to correct it.";

export const MEETING_CANCELLED_MESSAGE =
	"This meeting was cancelled, so there is nothing to record against it.";

/** Denials that legitimately mean "not an officer HERE" and so fall through to
 *  the two self-asserted arms. Anything else — a db blip, an archived club — is
 *  rethrown rather than silently demoting a real officer. */
const OFFICER_DENIALS: ReadonlySet<string> = new Set([
	NOT_A_MEMBER_MESSAGE,
	NO_PERMISSION_MESSAGE,
]);

/** One slot of the meeting, with the columns every decision below reads. */
interface MeetingSlotRow {
	slotId: string;
	roleName: string;
	roleKey: string | null;
	category: string;
	isSpeakerRole: boolean;
	assigneeId: string | null;
}

/**
 * Every slot of a meeting, ONCE.
 *
 * One query serves four decisions — who the Timer is, who the TMOD is, whether
 * the target slot belongs to this meeting at all, and whether its role is
 * timeable. Splitting them would be four round trips on a request made from a
 * phone on venue wifi, and would put the same join in four places.
 *
 * Deliberately NOT `loadTmodMemberId` from `meeting-authz-logic.ts`, even
 * though that seam exists: it returns the TMOD and nothing else, so the Timer
 * would still need this query beside it. Sharing the RESOLVERS is what matters
 * and that is what happens — `findTmodSlot` / `findTimerSlot` are the same
 * functions that seam calls, so the key-first-then-exact-name rule has exactly
 * one implementation.
 *
 * Ordered the way `loadRoleSlotAssignees` orders, and for its reason: the keyed
 * pass makes the common tie irrelevant, but two KEYLESS rows both named
 * canonically are separated by order alone, and an unordered SQL result could
 * grant a different member between two requests.
 */
async function loadMeetingSlots(meetingId: string): Promise<MeetingSlotRow[]> {
	return db
		.select({
			slotId: roleSlots.id,
			roleName: roleDefinitions.name,
			roleKey: roleDefinitions.key,
			category: roleDefinitions.category,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
			assigneeId: roleSlots.assignedMemberId,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.where(eq(roleSlots.meetingId, meetingId))
		.orderBy(roleDefinitions.sortOrder, roleSlots.slotIndex);
}

export interface ResolvedTimingActor {
	/** Who to credit. Null only for a memberless read-write impersonation. */
	actorMemberId: string | null;
	/** Admitted as someone who RUNS this meeting, and so may correct a timing
	 *  another actor recorded. Named for the CAPABILITY, not the arm, because
	 *  two arms grant it — the same distinction `ResolvedActor.viaManager` makes
	 *  and for the same reason. */
	viaManager: boolean;
	via: TimingGrantedVia;
}

/**
 * Resolve who is recording, or throw.
 *
 * EXPORTED so the ladder is reachable from vitest. It was the privacy of
 * exactly this decision inside a `createServerFn` module that left
 * `attendance-plan`'s ladder assertable only against its own source text, and
 * left the other session-less writer that needed it shipping with no subject
 * check at all (#675).
 *
 * Arm order is load-bearing: officer, then TMOD, then Timer. A session admin
 * who also holds the Timer slot should be credited as the officer they are, and
 * putting the Timer arm first would swallow the officer arm for that person —
 * which matters, because only the manager arms may overwrite.
 */
export async function resolveTimingActor(args: {
	/** ALWAYS the meeting's OWN club, read from the meeting row by the caller —
	 *  never a club id taken off the request payload. */
	clubId: string;
	slots: MeetingSlotRow[];
	claimedActorMemberId?: string | null;
}): Promise<ResolvedTimingActor> {
	const user = await getSessionUser();
	if (user) {
		// Branch on whether the CALL succeeded, never on `membership.id` being
		// truthy: a superadmin with an active read_write session comes back as a
		// memberless effective-admin whose `id` is null (#246), and an `if (id)`
		// would push exactly that principal down into the arms below, where they
		// hold no membership, and reject the write.
		let membership: ResolvedMembership | null = null;
		try {
			membership = await requireClubRole(user.id, args.clubId, ["admin"]);
		} catch (error) {
			if (!OFFICER_DENIALS.has(error instanceof Error ? error.message : "")) {
				throw error;
			}
		}
		if (membership) {
			return { actorMemberId: membership.id, viaManager: true, via: "officer" };
		}
	}

	// Resolve the CALLER once and reuse it for both remaining arms. `?? null`
	// and never a default to some subject: this asks "who is CALLING", and there
	// is no subject member on a timing to default to anyway.
	const caller = await resolveWriteActor({
		clubId: args.clubId,
		sessionUserId: user?.id ?? null,
		claimedActorMemberId: args.claimedActorMemberId ?? null,
	});
	if (caller) {
		const tmod = findTmodSlot(args.slots)?.assigneeId ?? null;
		if (tmod && caller === tmod) {
			return { actorMemberId: caller, viaManager: true, via: "tmod" };
		}
		// `findTimerSlot`, never an inline key comparison: the key comes first and
		// the exact canonical name only backs a NULL key, so a renamed standard
		// Timer keeps the capability and a club-invented "Timer Assistant" never
		// gains it (#464/#732).
		const timer = findTimerSlot(args.slots)?.assigneeId ?? null;
		if (timer && caller === timer) {
			return { actorMemberId: caller, viaManager: false, via: "self" };
		}
	}
	throw new Error(TIMING_NOT_PERMITTED_MESSAGE);
}

/** The marks in force when the clock stopped, as the caller measured them.
 *  Optional as a whole: a CORRECTION carries none, and the stored copy must
 *  survive it untouched. */
export interface TimingMarksInput {
	green?: number | null;
	yellow?: number | null;
	red?: number | null;
}

export interface RecordTimingInput {
	meetingId: string;
	slotId: string;
	elapsedSeconds: number;
	marks?: TimingMarksInput | null;
	/**
	 * Self-asserted roster member id. PUBLIC path, so this is an ASSERTION, not
	 * proof — `resolveWriteActor` club-scopes it and a real session wins over it.
	 *
	 * Named `claimed…` rather than `actorMemberId`, deliberately, and the name is
	 * the point: `actorMemberId` on a payload is the shape #396 was, where the
	 * client picked who the `activity_log` credits. This one is the CLAIM going
	 * IN; what comes out is `ResolvedTimingActor.actorMemberId`, and the two must
	 * not be spelled the same or the next reader will pass one for the other.
	 */
	claimedActorMemberId?: string | null;
}

export interface RecordedTiming {
	slotId: string;
	roleName: string;
	elapsedSeconds: number;
	markGreen: number | null;
	markYellow: number | null;
	markRed: number | null;
	grantedVia: TimingGrantedVia;
	recordedByMemberId: string | null;
}

/**
 * Record (or correct) one measured time.
 *
 * The order of the gates is deliberate and mirrors the agenda resolvers':
 * ARCHIVE first (takedown outranks every other reason to refuse, and answering
 * "this meeting was cancelled" for an archived club both discloses state and
 * answers differently from the same club's scheduled meeting), then the meeting
 * window, then WHAT is being recorded against, then WHO. Telling a Timer they
 * are not permitted, when the real answer is that a Table Topics segment has no
 * one speaker, sends them looking for a permissions problem that does not
 * exist.
 */
export async function recordMeetingTiming(
	input: RecordTimingInput,
): Promise<RecordedTiming> {
	const [meeting] = await db
		.select({
			id: meetings.id,
			clubId: meetings.clubId,
			status: meetings.status,
		})
		.from(meetings)
		.where(eq(meetings.id, input.meetingId))
		.limit(1);
	if (!meeting) throw new Error("Meeting not found.");

	// #555: an archived club THROWS rather than resolving to not-found. Every
	// caller already has an error path, and accepting a write nobody can ever
	// read is the worse failure.
	await assertClubNotArchived(meeting.clubId);
	// A COMPLETED meeting is fine — see the module header. A cancelled one is
	// not: there was no meeting, so there is nothing that was timed.
	if (meeting.status === "cancelled") {
		throw new Error(MEETING_CANCELLED_MESSAGE);
	}

	const slots = await loadMeetingSlots(meeting.id);
	// Scoped to THIS meeting by construction: `loadMeetingSlots` only returns
	// its slots, so a hand-made request naming another meeting's slot — or no
	// slot at all — finds nothing here rather than inserting a row whose
	// `meeting_id` and `slot_id` disagree.
	const slot = slots.find((s) => s.slotId === input.slotId);
	if (!slot) throw new Error("That segment isn't part of this meeting.");
	if (!isTimeableRole(slot)) {
		throw new TimingNotRecordableError(slot.roleName);
	}

	const actor = await resolveTimingActor({
		clubId: meeting.clubId,
		slots,
		claimedActorMemberId: input.claimedActorMemberId ?? null,
	});

	// THE FLOOR, in two halves that do different jobs.
	//
	// A self-asserted Timer may add their own answer and correct their OWN, but
	// may not replace somebody else's record — the same shape as planned
	// attendance's, and the same reason. A NULL recorder fails CLOSED:
	// `recorded_by_member_id` is `set null` on member delete, so after a member
	// is deleted a row cannot prove whose it was, and `eq(col, <id>)` is already
	// false for NULL in SQL, which is the behaviour we want rather than an
	// accident of it.
	//
	// The PREDICATE below is the enforcement — a `setWhere` Postgres evaluates
	// against the live row, so two writes racing cannot both pass a check made
	// before either landed. That is the same reason `setPlanStatus`'s `demoteFrom`
	// is a predicate rather than a read-then-write.
	//
	// The READ here is only for the MESSAGE. A filtered-out `setWhere` produces
	// no returned row and no error, which as a refusal is indistinguishable from
	// a success the Timer never sees — so the read tells them WHY, and the
	// `!written` arm below catches the race the read cannot see.
	const floor =
		actor.viaManager || actor.actorMemberId === null
			? undefined
			: eq(meetingTimings.recordedByMemberId, actor.actorMemberId);
	const [existing] = await db
		.select({ recordedByMemberId: meetingTimings.recordedByMemberId })
		.from(meetingTimings)
		.where(eq(meetingTimings.slotId, slot.slotId))
		.limit(1);
	if (
		existing &&
		floor !== undefined &&
		existing.recordedByMemberId !== actor.actorMemberId
	) {
		throw new Error(TIMING_OVERWRITE_MESSAGE);
	}

	// `marks` absent means "leave the stored copy alone", which is what a
	// CORRECTION wants: an officer fixing a mistyped number must not also
	// rewrite the window that number was judged against. Present-but-null is a
	// real value (measured against no window) and is written as such.
	const marks = input.marks
		? {
				markGreen: input.marks.green ?? null,
				markYellow: input.marks.yellow ?? null,
				markRed: input.marks.red ?? null,
			}
		: null;

	const row = await db.transaction(async (tx) => {
		const [written] = await tx
			.insert(meetingTimings)
			.values({
				meetingId: meeting.id,
				slotId: slot.slotId,
				elapsedSeconds: input.elapsedSeconds,
				markGreen: marks?.markGreen ?? null,
				markYellow: marks?.markYellow ?? null,
				markRed: marks?.markRed ?? null,
				recordedByMemberId: actor.actorMemberId,
				grantedVia: actor.via,
			})
			// The arbiter is stated EXPLICITLY. A unique index alone only proves an
			// insert fails; naming `slot_id` as the conflict target is what makes a
			// second recording an UPDATE of the same row rather than an error the
			// Timer cannot get past.
			.onConflictDoUpdate({
				target: meetingTimings.slotId,
				set: {
					elapsedSeconds: input.elapsedSeconds,
					recordedByMemberId: actor.actorMemberId,
					grantedVia: actor.via,
					updatedAt: new Date(),
					// Spread, so an omitted `marks` leaves the stored columns untouched
					// rather than nulling them — see above.
					...(marks ?? {}),
				},
				// `undefined` on the manager arms: an officer or the Toastmaster may
				// correct anyone's row, and a predicate here would floor them too.
				setWhere: floor,
			})
			.returning({
				elapsedSeconds: meetingTimings.elapsedSeconds,
				markGreen: meetingTimings.markGreen,
				markYellow: meetingTimings.markYellow,
				markRed: meetingTimings.markRed,
				grantedVia: meetingTimings.grantedVia,
				recordedByMemberId: meetingTimings.recordedByMemberId,
			});
		if (!written) {
			// The `setWhere` filtered the update out, which on this path means the
			// row changed hands between the read above and the write: another actor
			// recorded it in the window between. Same message as the read's
			// refusal, because it is the same refusal — the difference is only that
			// Postgres caught this one.
			throw new Error(
				floor === undefined
					? "Failed to record the time."
					: TIMING_OVERWRITE_MESSAGE,
			);
		}
		// In the SAME transaction, so the row and its audit trail commit together.
		await logActivity(tx, {
			clubId: meeting.clubId,
			actorMemberId: actor.actorMemberId,
			action: "timing_record",
			targetType: "slot",
			targetId: slot.slotId,
			detail: {
				roleName: slot.roleName,
				elapsedSeconds: written.elapsedSeconds,
				grantedVia: actor.via,
			},
		});
		return written;
	});

	return { slotId: slot.slotId, roleName: slot.roleName, ...row };
}

// The READS live where their consumers do, deliberately, rather than being
// re-exported from here: `loadMinutes` (`minutes-logic.ts`) selects the rows
// for the minutes screen and the PDF, and `loadPublicPersonalMeetingView`
// (`personal-meeting-logic.ts`) left-joins the table onto the slot query it
// already runs, so the duty tick costs no extra round trip. There is no store
// guard on `meeting_timings` and this comment is not pretending otherwise —
// what belongs HERE is the write and the decision that admits it, which is the
// part with a rule in it.
