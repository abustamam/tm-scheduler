import { and, eq, inArray } from "drizzle-orm";
import type { db } from "#/db";
import { meetings, roleDefinitions, roleSlots, speeches } from "#/db/schema";
import { buildRoleCounts, slotLabel } from "#/lib/agenda";
import { assertMeetingAccepts } from "#/lib/meeting-lifecycle";
import {
	isConnectorSelf,
	SIGN_IN_REQUIRED_MESSAGE,
	type WriteProof,
} from "#/lib/write-proof";
import { logActivity } from "./activity";
import {
	type ResolvedActor,
	resolveActor,
	SELF_ONLY_MESSAGE,
} from "./attendance-actor-logic";
import { lockMemberAttendance, setPlanStatus } from "./attendance-plan-logic";
import { assertClubNotArchived } from "./guards";
import { meetingAcceptsWrite } from "./meeting-write-gate";
import { lockMembershipsAgainstMerge } from "./membership-merge-lock";

type Database = typeof db;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** A pool handle or a transaction already open: a `tx.transaction` nests as a
 *  savepoint, so the seam can run inside the caller's own transaction (#1283). */
type DbOrTx = Database | Tx;

/** Thrown by {@link releaseSlotsAndMarkUnavailable} when `expectedHeldSlotIds`
 *  was given and the member's held slots, read under the attendance lock, are not
 *  exactly that set. Nothing was written. */
export class HeldSlotsChangedError extends Error {
	constructor() {
		super("The roles this member holds changed since they were previewed.");
		this.name = "HeldSlotsChangedError";
	}
}

/** One slot `releaseHeldSlots` freed: the NUMBERED agenda label ("Speaker 2")
 *  and the title of the speech that was attached, which the release unlinks but
 *  never deletes (ADR-0009). */
export type ReleasedSlot = {
	slotId: string;
	label: string;
	speechTitle: string | null;
};

/** What both release writers share, read BEFORE their UPDATE: every slot in the
 *  meeting, so labels are numbered off the whole meeting, and the member's own. */
async function readHeldSlots(tx: Tx, meetingId: string, memberId: string) {
	const all = await tx
		.select({
			id: roleSlots.id,
			assigneeId: roleSlots.assignedMemberId,
			slotIndex: roleSlots.slotIndex,
			roleName: roleDefinitions.name,
			sortOrder: roleDefinitions.sortOrder,
			slotsUnordered: roleDefinitions.slotsUnordered,
			speechTitle: speeches.title,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.leftJoin(speeches, eq(speeches.id, roleSlots.speechId))
		.where(eq(roleSlots.meetingId, meetingId));
	return {
		roleCounts: buildRoleCounts(all),
		before: new Map(
			all
				.filter((s) => s.assigneeId === memberId)
				.map((s) => [s.id, s] as const),
		),
	};
}

type HeldRead = Awaited<ReturnType<typeof readHeldSlots>>;

/** The set both release UPDATEs write: the slot goes back to the open pool. The
 *  speech row is unlinked, never deleted (ADR-0009). */
const FREE_SLOT = {
	assignedMemberId: null,
	assignedGuestId: null,
	status: "open",
	claimedAt: null,
	speechId: null,
} as const;

type ReleaseContext = {
	meetingId: string;
	memberId: string;
	proof: WriteProof;
	cause: "not_coming" | "absent";
	/** The owning club and the credited actor, for the activity rows. */
	clubId: string;
	actorMemberId: string | null;
};

/** Label, order and log what an UPDATE's RETURNING rows actually freed. */
async function reportFreed(
	tx: Tx,
	read: HeldRead,
	released: { id: string }[],
	args: ReleaseContext,
): Promise<ReleasedSlot[]> {
	const freed: (ReleasedSlot & { sortOrder: number; slotIndex: number })[] = [];
	for (const row of released) {
		const was = read.before.get(row.id);
		// A slot assigned to the member between the read and the UPDATE (a claim
		// that committed in the gap): freed, with a label worked out from the
		// plain role name. Not reachable behind `lockMemberAttendance` for a
		// claim, and still better than dropping the activity row.
		freed.push({
			slotId: row.id,
			label: was ? slotLabel(was, read.roleCounts) : "A role",
			speechTitle: was?.speechTitle ?? null,
			sortOrder: was?.sortOrder ?? 0,
			slotIndex: was?.slotIndex ?? 0,
		});
	}
	freed.sort((a, b) => a.sortOrder - b.sortOrder || a.slotIndex - b.slotIndex);

	for (const slot of freed) {
		await logActivity(tx, {
			clubId: args.clubId,
			actorMemberId: args.actorMemberId,
			action: "release",
			targetType: "slot",
			targetId: slot.slotId,
			detail: {
				fromMemberId: args.memberId,
				proof: args.proof,
				cause: args.cause,
				// A release a token owner made through their agent (#1283).
				...(args.proof === "connector" ? { via: "connector" } : {}),
			},
		});
	}
	return freed.map(({ slotId, label, speechTitle }) => ({
		slotId,
		label,
		speechTitle,
	}));
}

/**
 * Free every slot `memberId` holds in `meetingId`, under the PLAN write class,
 * inside the CALLER's transaction. Not coming's release (#1135).
 *
 * The class is a literal in THIS statement, one writer per class, so the meeting
 * writers guard can read it (a class passed as a parameter it cannot). The UPDATE
 * re-checks `assigned_member_id`, so a slot reassigned since the read is neither
 * freed nor reported. Labels come from `readHeldSlots`: numbered off every slot
 * in the meeting, never off the member's own.
 */
export async function releaseHeldSlotsForPlan(
	tx: Tx,
	args: ReleaseContext,
): Promise<ReleasedSlot[]> {
	const read = await readHeldSlots(tx, args.meetingId, args.memberId);
	const released = await tx
		.update(roleSlots)
		.set(FREE_SLOT)
		.where(
			and(
				eq(roleSlots.meetingId, args.meetingId),
				eq(roleSlots.assignedMemberId, args.memberId),
				meetingAcceptsWrite(tx, "plan", roleSlots.meetingId),
			),
		)
		.returning({ id: roleSlots.id });
	return reportFreed(tx, read, released, args);
}

/**
 * Free the slots `slotIds` that `memberId` STILL holds in `meetingId`, under the
 * RECORD write class (#1256: roll Absent), inside the caller's transaction.
 *
 * `slotIds` is what the officer was shown and confirmed, and it is the ceiling:
 * a replayed or stale release frees nothing the officer did not see, because a
 * slot the member was given since is not in the list. The UPDATE still re-checks
 * `assigned_member_id`, so a listed slot reassigned away is left alone too.
 */
export async function releaseHeldSlotsForRecord(
	tx: Tx,
	args: ReleaseContext & { slotIds: readonly string[] },
): Promise<ReleasedSlot[]> {
	if (args.slotIds.length === 0) return [];
	const read = await readHeldSlots(tx, args.meetingId, args.memberId);
	const released = await tx
		.update(roleSlots)
		.set(FREE_SLOT)
		.where(
			and(
				inArray(roleSlots.id, [...args.slotIds]),
				eq(roleSlots.meetingId, args.meetingId),
				eq(roleSlots.assignedMemberId, args.memberId),
				meetingAcceptsWrite(tx, "record", roleSlots.meetingId),
			),
		)
		.returning({ id: roleSlots.id });
	return reportFreed(tx, read, released, args);
}

/**
 * The actor of a `connector` write (#1283): the token owner's own membership,
 * never a resolved ladder arm. The claim must be the subject itself; a token
 * call has no cookie session for `resolveActor` to read, and no arm of the
 * ladder may be granted to it (a token owner is not "an officer" here, whatever
 * their standing). Throws `SELF_ONLY_MESSAGE` for anything else.
 */
export function connectorActor(
	memberId: string,
	claimedActorMemberId: string | undefined,
): ResolvedActor {
	if (!isConnectorSelf("connector", claimedActorMemberId ?? null, memberId)) {
		throw new Error(SELF_ONLY_MESSAGE);
	}
	return {
		actorMemberId: memberId,
		viaManager: false,
		via: "self",
		proof: "connector",
	};
}

/**
 * Release every role a member holds in a meeting and record them `not_coming`,
 * in one transaction (#204). Pure db logic so it's directly testable; the server
 * fn (`markUnavailableReleasing`) wraps it with the meeting-lock + membership
 * guards. Release mirrors `releaseSlot`: slot → open, assignee + speech
 * unlinked (the speech persists, ADR-0009).
 *
 * ## The two gates below are the WRITE's authorization, and they live HERE
 *
 * #675. This used to take an already-resolved `actorMemberId` and trust it, so
 * the handler's ladder was `requireMemberInClub` (the SUBJECT is on the roster)
 * plus `requestWriteActor` (who to CREDIT — it authorizes nothing) and nothing
 * proved the caller was the subject. `setPlannedAttendance` ended its own ladder
 * with a subject check and this one did not, so of the two writes the product
 * offers a session-less member, the DESTRUCTIVE one was the unguarded one:
 * `assigned_member_id = null`, `status = open`, `speech_id = null` on every slot
 * the member holds, with no undo.
 *
 * They live in this seam rather than in the handler for the reason
 * CODING_STANDARDS.md gives ("WRITES are closed too"): a `createServerFn`
 * handler body cannot be invoked from vitest, so a handler-gated write is
 * covered by a source grep and nothing else, while a seam is reachable and
 * therefore provable. `availability.integration.test.ts` executes all four
 * outcomes against a real database.
 *
 * ## And the ladder is not enough on its own (#762, ADR-0026)
 *
 * The ladder above answers WHICH arm, not HOW the identity was established, and
 * two of its three arms admit a caller who merely typed a member id into the
 * payload — the self arm's last fallback admitting one who typed nothing at
 * all. So the gate it restored still left the whole of #699 reachable here:
 * every role a member holds, back to `open` with `speech_id = null`, from a
 * request carrying no session, credited to the victim.
 *
 * This fn releases UNCONDITIONALLY — that is the difference between it and the
 * rail's decline — so there is no first-answer case to preserve and no ceiling
 * to negotiate with. A `proof` that is not `"session"` is refused outright,
 * before the transaction opens, so nothing partial lands.
 *
 * The archive assert is this arm's OWN, not a duplicate for its own sake. This
 * path takes a self-asserted member id with no session, so `requireMembership`'s
 * archive check (#186) — the choke point every authed write inherits — never
 * runs for it, and neither does `requireClubRole`'s. The handler keeps its
 * `assertClubNotArchived(meeting.clubId)` too: that one runs FIRST, before the
 * lock and membership checks, so an archived club cannot be probed through their
 * differing errors (the existence oracle of #544), and it is pinned by
 * `delegate-rungs.guard.test.ts`. This one is what makes the refusal testable.
 */
export async function releaseSlotsAndMarkUnavailable(
	database: DbOrTx,
	args: {
		/** The member being marked unavailable (whose roles are released). */
		memberId: string;
		/** The actor the CLIENT asserted, if any — an assertion, not proof, so it
		 *  is handed to `resolveActor` rather than believed. Omitted ⇒ the
		 *  anonymous self-service path, where the ladder's last arm resolves the
		 *  caller to the subject.
		 *
		 *  It deliberately replaced a resolved `actorMemberId` (#675). A caller
		 *  that could hand this seam a finished actor id could hand it the SUBJECT's
		 *  id and satisfy the subject check by construction, which is precisely the
		 *  hole — so the raw claim is the only thing this signature accepts, and
		 *  `availability-authz.guard.test.ts` pins that the handler passes
		 *  `data.actorMemberId` rather than defaulting it to `data.memberId`. */
		claimedActorMemberId?: string;
		meetingId: string;
		/** ALWAYS the OWNING club, read off the meeting row by the caller (#396) —
		 *  never the `clubId` the request payload carries. */
		clubId: string;
		/** How the change happened, recorded in `activity_log.detail` only.
		 *
		 *  Added by #663, when `setPlannedAttendance` started declining through
		 *  this seam and carried a `via` its two older callers never had. Optional,
		 *  so the season grid and the personal meeting page need no change and keep
		 *  `setPlanStatus`'s own `"manual"` default — but a caller that HAS the
		 *  provenance must pass it, or the destructive path records less of it than
		 *  the harmless rung write beside it. */
		via?: "nudge" | "manual" | "connector";
		/** `"connector"` (#1283): a token owner freeing their OWN roles. The ladder
		 *  is skipped (it reads a cookie session a token call does not have) and
		 *  `claimedActorMemberId` must equal `memberId`, else `SELF_ONLY_MESSAGE`.
		 *  Omitted by every other caller, which resolves its proof exactly as
		 *  before. */
		proof?: WriteProof;
		/** The slot ids the caller previewed and hashed (#1283). Given, the held
		 *  set read under `lockMemberAttendance` must equal it, else
		 *  {@link HeldSlotsChangedError} and nothing is written: an assign or claim
		 *  that landed after the preview is never freed unseen. Omitted by every
		 *  other caller, whose behaviour is unchanged. */
		expectedHeldSlotIds?: readonly string[];
	},
): Promise<{ released: number; releasedSlots: ReleasedSlot[] }> {
	// Takedown outranks every other reason to refuse (ADR-0016), so it runs
	// before the ladder — an archived club must not answer differently for an
	// authorized caller than for an unauthorized one.
	await assertClubNotArchived(args.clubId);
	// A club officer or this meeting's Toastmaster may release anyone's roles
	// (the season grid's act-on-behalf-of path); everyone else may release only
	// their own. `actorMemberId` comes back null for an impersonated write
	// (#396/#246) — a decision, not an omission: `logActivity` stamps the real
	// superadmin for it, so it must NOT fall back to the member or the write
	// lands under their name.
	const { actorMemberId, via, proof } =
		args.proof === "connector"
			? connectorActor(args.memberId, args.claimedActorMemberId)
			: await resolveActor({
					clubId: args.clubId,
					meetingId: args.meetingId,
					memberId: args.memberId,
					claimedActorMemberId: args.claimedActorMemberId,
				});
	// ADR-0026, and the reason the ladder alone was never enough here: see the
	// header. Before the transaction, so a refusal leaves nothing behind.
	if (
		!(
			proof === "session" ||
			isConnectorSelf(proof, actorMemberId, args.memberId)
		)
	) {
		throw new Error(SIGN_IN_REQUIRED_MESSAGE);
	}
	return (database as Database).transaction(async (tx) => {
		// The membership merge lock (#1035), SHARED, before any other lock (#1217).
		// The bulk UPDATE below has no ORDER BY, so with two slots it can lock them
		// in the opposite order to a removal (which takes them in id order), and
		// `setPlanStatus` key-shares the member row the removal holds: 40P01. A
		// member removed meanwhile is refused with `CLUB_BUSY_MESSAGE`.
		await lockMembershipsAgainstMerge(tx, [args.memberId]);
		// Before the release, not before the `not_coming` write: an unverified
		// claim that checked this member's answer must finish before we look for
		// the roles to free, or its slot flips after we have looked.
		await lockMemberAttendance(tx, args.meetingId, args.memberId);
		if (args.expectedHeldSlotIds) {
			const held = [
				...(
					await readHeldSlots(tx, args.meetingId, args.memberId)
				).before.keys(),
			].sort();
			const expected = [...args.expectedHeldSlotIds].sort();
			if (
				held.length !== expected.length ||
				held.some((id, i) => id !== expected[i])
			) {
				throw new HeldSlotsChangedError();
			}
		}
		// The writer's own refusal, by write class (#1135), where it used to rest on
		// each caller (the handler's lock check; the decline's `isMeetingOver`).
		// `plan`: freeing someone's roles rewrites the agenda, so a completed
		// meeting says locked and a cancelled one says cancelled, BEFORE anything is
		// released. A cancelled meeting was already refused as a whole, one step
		// later, by the `not_coming` write below (`setPlanStatus`), whose throw
		// rolls the release back (`decline-release-cancelled.integration.test.ts`);
		// this says the same sentence, and says it from this writer.
		//
		// A plain read, with no meeting lock: one would sit after the attendance
		// lock taken above, against the order every slot editor takes them in. A
		// complete committing between this read and the release is the window the
		// callers' own checks always had.
		const [meeting] = await tx
			.select({ status: meetings.status })
			.from(meetings)
			.where(eq(meetings.id, args.meetingId))
			.limit(1);
		if (!meeting) throw new Error("Meeting not found.");
		assertMeetingAccepts(meeting.status, "plan");
		const releasedSlots = await releaseHeldSlotsForPlan(tx, {
			meetingId: args.meetingId,
			memberId: args.memberId,
			proof,
			cause: "not_coming",
			clubId: args.clubId,
			actorMemberId,
		});
		if (releasedSlots.length === 0) {
			// Nothing released is ordinary (the member held nothing), and also what a
			// freeze after the read leaves: tell them apart, so a locked or cancelled
			// meeting is refused here rather than given a `not_coming` answer.
			const [now] = await tx
				.select({ status: meetings.status })
				.from(meetings)
				.where(eq(meetings.id, args.meetingId))
				.limit(1);
			if (now) assertMeetingAccepts(now.status, "plan");
		}

		// Inside the caller's transaction, which is why the seam takes a `DbOrTx`:
		// the release and the "not coming" answer commit together or not at all.
		// It logs its own `plan_set` activity, so there is no separate
		// availability_set row here any more.
		await setPlanStatus(tx, {
			memberId: args.memberId,
			meetingId: args.meetingId,
			clubId: args.clubId,
			status: "not_coming",
			actorMemberId,
			via: args.via,
			// WHICH arm admitted the write, persisted as `activity_log.detail.
			// grantedVia`. Optional on the seam, so a caller with a ladder that
			// forgets it drops the distinction silently — and a grant defended as
			// "auditable afterwards" is not auditable while an honour-system TMOD
			// release and an officer's look identical in the feed.
			grantedVia: via,
			// Always `"session"` past the gate above, and recorded anyway, so a
			// feed reader is not left inferring it from which writers happen to be
			// gated this month. It is a one-way signal and not a discriminator:
			// `proof` is optional on the seam and the three remaining session-less
			// plan writers pass none, so an ABSENT value means "no ladder to read
			// it off, or written before #762" — never "not asserted".
			proof,
		});

		return { released: releasedSlots.length, releasedSlots };
	});
}
