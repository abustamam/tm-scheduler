import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireVoteCounterCapability } from "./guards";
import { assertMeetingNotLocked } from "./meeting-authz-logic";
import {
	castVote,
	closeVote,
	joinBallotAsGuest,
	loadBallot,
	loadParticipation,
	loadTableTopicsForConsole,
	loadTally,
	openVote,
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
				candidate: voterRef,
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
