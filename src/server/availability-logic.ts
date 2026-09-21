import { and, eq } from "drizzle-orm";
import type { db } from "#/db";
import { roleSlots } from "#/db/schema";
import { SIGN_IN_REQUIRED_MESSAGE } from "#/lib/write-proof";
import { logActivity } from "./activity";
import { resolveActor } from "./attendance-actor-logic";
import { setPlanStatus } from "./attendance-plan-logic";
import { assertClubNotArchived } from "./guards";

type Database = typeof db;

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
	database: Database,
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
		via?: "nudge" | "manual";
	},
): Promise<{ released: number }> {
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
	const { actorMemberId, via, proof } = await resolveActor({
		clubId: args.clubId,
		meetingId: args.meetingId,
		memberId: args.memberId,
		claimedActorMemberId: args.claimedActorMemberId,
	});
	// ADR-0026, and the reason the ladder alone was never enough here: see the
	// header. Before the transaction, so a refusal leaves nothing behind.
	if (proof !== "session") throw new Error(SIGN_IN_REQUIRED_MESSAGE);
	return database.transaction(async (tx) => {
		const released = await tx
			.update(roleSlots)
			.set({
				assignedMemberId: null,
				assignedGuestId: null,
				status: "open",
				claimedAt: null,
				speechId: null,
			})
			.where(
				and(
					eq(roleSlots.meetingId, args.meetingId),
					eq(roleSlots.assignedMemberId, args.memberId),
				),
			)
			.returning({ id: roleSlots.id });

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

		for (const slot of released) {
			await logActivity(tx, {
				clubId: args.clubId,
				actorMemberId,
				action: "release",
				targetType: "slot",
				targetId: slot.id,
				detail: { fromMemberId: args.memberId, proof },
			});
		}
		return { released: released.length };
	});
}
