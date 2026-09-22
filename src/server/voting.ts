import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	requireSignedInVoteCounter,
	requireVoteCounterCapability,
} from "./guards";
import { assertMeetingNotLocked } from "./meeting-authz-logic";
import {
	castVote,
	closeVote,
	disqualifyCandidate,
	joinBallotAsGuest,
	loadBallot,
	loadParticipation,
	loadTableTopicsForConsole,
	loadTally,
	openVote,
	undoDisqualification,
} from "./voting-logic";

// The db-touching logic lives in `voting-logic.ts` (never imported by client
// routes) so it can't drag `#/db` → `pg` into the browser bundle. This module
// exports ONLY createServerFns + types — see `server-modules.guard.test.ts`.
// `CategoryTally` / `TableTopicsSpeakerRef` / `TallyResult` / `VoterRef` are
// NOT re-exported (#510 review finding 5): nothing outside this module and
// `voting-logic.ts` imports them, and `noUnusedLocals` does not catch a dead
// re-export the way it catches a dead local.
export type { BallotData } from "./voting-logic";

const uuid = z.string().uuid();
const category = z.enum([
	"best_speaker",
	"best_evaluator",
	"best_table_topics",
]);
const voterRef = z.object({ kind: z.enum(["member", "guest"]), id: uuid });

/**
 * A candidate is either a roster row or a typed name (#582).
 *
 * The name arm carries NO length bound here on purpose — `castVote` owns that,
 * through `writeInNameSchema`, so the cap has exactly one definition and a unit
 * test can reach it without going through a `createServerFn` it cannot invoke.
 * Duplicating a `.max()` here would be a second number to keep in agreement.
 */
const candidateRef = z.union([
	voterRef,
	z.object({ kind: z.literal("writeIn"), name: z.string() }),
]);

/**
 * Declared BEFORE the exports below (rather than at file end, as hoisting
 * would otherwise allow) so `voting-authz.guard.test.ts`'s source-grep for
 * `getVoteTally` — the last GATED export in the file — is bounded by EOF and
 * does not accidentally sweep in this function's own declaration text (which,
 * as `async function requireVoteCounter(...`, literally contains the
 * substring the guard asserts on). With the helper below `getVoteTally`, that
 * boundary swallowed the declaration and the guard could not fail even when
 * the real call was removed from the handler — caught by mutation testing.
 *
 * Delegates to `requireVoteCounterCapability` (`guards.ts`) rather than
 * calling `resolveVoteCounterAuthz` directly (#510 review finding 4). This
 * function used to skip the elected-officer retry that capability wraps
 * around the resolver, so an officer with an open term could `setMinutesAward`
 * (gated by `requireVoteCounterCapability` in `minutes.ts`) but not
 * `openVote`/`closeVote`/read the tally — two gates disagreeing about the same
 * person for the same feature. This wrapper stays (rather than every export
 * below calling `requireVoteCounterCapability` directly) purely for the
 * guard-test slice-ordering reason above: the source-grep needs ONE stable
 * substring, `requireVoteCounter(`, that cannot bleed into a neighboring
 * export's body.
 *
 * THREE exports use it now, not five. `disqualifyCandidateFn` and
 * `undoDisqualificationFn` call `requireSignedInVoteCounter` from `guards.ts`
 * directly (#752), and that needs no local wrapper for the reason above: the
 * name is DECLARED in another module, so the only text of it in this file is
 * the import at the top, which is outside every export's slice. The two gate
 * names are disjoint as substrings — `requireSignedInVoteCounter(` does not
 * contain `requireVoteCounter(` — which is what lets `voting-authz.guard.test.ts`
 * assert each export's gate in BOTH directions. Do not rename either toward the
 * other.
 */
async function requireVoteCounter(data: {
	meetingId: string;
	selfMemberId?: string | null;
}) {
	return requireVoteCounterCapability(data);
}

/** The public ballot (#510). PUBLIC — no session, mirroring `submitGuestBook`.
 *  Names and ids only; never contact details. */
export const getBallot = createServerFn({ method: "GET" })
	.validator((input: unknown) => z.object({ meetingId: uuid }).parse(input))
	.handler(async ({ data }) => loadBallot(data.meetingId));

/** How many ballots are in, per category. PUBLIC — this is the projector badge.
 *  Bare counts only; per-candidate numbers live behind `getVoteTally`. */
export const getVoteParticipation = createServerFn({ method: "GET" })
	.validator((input: unknown) => z.object({ meetingId: uuid }).parse(input))
	.handler(async ({ data }) => loadParticipation(data.meetingId));

/** Cast or change one ballot. PUBLIC. Every trust boundary is inside
 *  `castVote`: candidate eligibility, voter club-scoping, and the open window. */
export const submitVote = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		z
			.object({
				meetingId: uuid,
				category,
				voter: voterRef,
				candidate: candidateRef,
			})
			.parse(input),
	)
	.handler(async ({ data }) => {
		await castVote(data);
		return { ok: true as const };
	});

/** Register a visitor so they can vote. PUBLIC — bounded inside
 *  `joinBallotAsGuest` on both name length and rows-per-meeting. */
export const joinBallot = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		z
			.object({ meetingId: uuid, name: z.string().min(1).max(400) })
			.parse(input),
	)
	.handler(async ({ data }) => joinBallotAsGuest(data));

const operateSchema = z.object({
	meetingId: uuid,
	category,
	selfMemberId: uuid.nullable().optional(),
});

/** Open a category's vote. GATED — Ballot Counter or club admin. */
export const openVoteFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => operateSchema.parse(input))
	.handler(async ({ data }) => {
		const authz = await requireVoteCounter(data);
		assertMeetingNotLocked(authz.meetingStatus);
		await openVote({
			meetingId: data.meetingId,
			clubId: authz.clubId,
			category: data.category,
			actorMemberId: authz.actorMemberId,
		});
		return { ok: true as const };
	});

/** Close a category's vote. GATED — Ballot Counter or club admin. */
export const closeVoteFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => operateSchema.parse(input))
	.handler(async ({ data }) => {
		const authz = await requireVoteCounter(data);
		assertMeetingNotLocked(authz.meetingStatus);
		await closeVote({
			meetingId: data.meetingId,
			clubId: authz.clubId,
			category: data.category,
			actorMemberId: authz.actorMemberId,
		});
		return { ok: true as const };
	});

/** The window operations above plus WHO. `candidateRef` is the same union
 *  `submitVote` takes — a write-in can be ruled out too, once it has been cast
 *  and the Vote Counter can see it on their console. */
const disqualifySchema = operateSchema.extend({ candidate: candidateRef });

/**
 * Rule a candidate out of one award (#723). GATED — and SINCE #752 the gate is
 * `requireSignedInVoteCounter` rather than the `requireVoteCounter` its
 * neighbours call: the Ballot Counter capability PLUS a session.
 *
 * This is the only capability in the whole self-assert set that publishes free
 * text about a NAMED THIRD PARTY, rendered on every polling phone beside their
 * name as an official ruling — and its attribution outlives it, because
 * `logActivity` records `vote_disqualify` with the asserted actor and the reason
 * text, and `undoDisqualificationFn` below deletes the disqualification row but
 * NOT that log entry. So a forged ruling leaves a permanent record naming an
 * innocent member as its author, and nothing in the product can remove it. The
 * argument in full, including why the other five #510 capabilities stay
 * anonymous, is on `requireSignedInVoteCounter` (`guards.ts`).
 *
 * The officer retry comes along inside that gate, so the refusal's "ask an
 * officer to sign in on this device" is true; `disqualify-session-gate.integration.test.ts`
 * asserts each of the four callers it names.
 *
 * The lock assert is deliberate and matches open/close rather than
 * `getVoteTally`: disqualifying is an operation on a LIVE vote, not a read of
 * the record, so a completed meeting refuses it for the same reason it refuses
 * re-opening the window.
 */
export const disqualifyCandidateFn = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		// The reason carries NO length bound here, exactly as `candidateRef`
		// carries none for the write-in name and for the same stated reason:
		// `disqualifyCandidate` owns it through `disqualificationReasonSchema`, so
		// the cap has one definition and a unit test can reach it without going
		// through a `createServerFn` it cannot invoke. An outer "request-size"
		// number here would be a second value to keep in agreement, which is the
		// thing that comment exists to refuse.
		disqualifySchema.extend({ reason: z.string() }).parse(input),
	)
	.handler(async ({ data }) => {
		const authz = await requireSignedInVoteCounter(data);
		assertMeetingNotLocked(authz.meetingStatus);
		await disqualifyCandidate({
			meetingId: data.meetingId,
			clubId: authz.clubId,
			category: data.category,
			candidate: data.candidate,
			reason: data.reason,
			actorMemberId: authz.actorMemberId,
		});
		return { ok: true as const };
	});

/** Undo a disqualification (#723) — the candidate returns to the ballot and
 *  their prior votes to the tally. Same gate, same lock, same reasons, and
 *  since #752 that includes the session: undoing is itself a ruling ON a named
 *  member's record, it writes its own `vote_disqualify_undo` activity entry under
 *  the asserted actor, and leaving it anonymous would let the same caller the
 *  gate above refuses simply erase a legitimate Ballot Counter's ruling. */
export const undoDisqualificationFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => disqualifySchema.parse(input))
	.handler(async ({ data }) => {
		const authz = await requireSignedInVoteCounter(data);
		assertMeetingNotLocked(authz.meetingStatus);
		await undoDisqualification({
			meetingId: data.meetingId,
			clubId: authz.clubId,
			category: data.category,
			candidate: data.candidate,
			actorMemberId: authz.actorMemberId,
		});
		return { ok: true as const };
	});

/** The running count, plus the meeting's Table Topics speakers (#510) — the
 *  Ballot Counter console's ONE source for that list, since `getMinutes` hides
 *  it from a non-admin Vote Counter until the meeting completes and widening
 *  `getMinutes` instead would hand over attendance and guest contact data to
 *  get at it (see `loadTableTopicsForConsole`). GATED — Ballot Counter or club
 *  admin. Deliberately does NOT assert the lock: the tally must stay readable
 *  after the meeting is completed, which is exactly when the winner gets
 *  confirmed. */
export const getVoteTally = createServerFn({ method: "GET" })
	.validator((input: unknown) =>
		z
			.object({ meetingId: uuid, selfMemberId: uuid.nullable().optional() })
			.parse(input),
	)
	.handler(async ({ data }) => {
		await requireVoteCounter(data);
		const [categories, tableTopicsSpeakers] = await Promise.all([
			loadTally(data.meetingId),
			loadTableTopicsForConsole(data.meetingId),
		]);
		return { categories, tableTopicsSpeakers };
	});
