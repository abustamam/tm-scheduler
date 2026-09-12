/**
 * The public write surface for the Timer's measured times (#730).
 *
 * Wrapper only. Every decision — the archive gate, the meeting window, the
 * timeable-role refusal, the three-arm actor ladder and the overwrite floor —
 * lives in `timings-logic.ts`, because a `createServerFn` handler cannot be
 * invoked from vitest and a rule that lives in one is unreachable by any test
 * or guard (CODING_STANDARDS, "Server modules must keep `pg` out of the client
 * bundle", second motive).
 *
 * PUBLIC and session-less by design: the Timer taps a link out of a chat
 * thread and has no session at all. `actorMemberId` is therefore an ASSERTION
 * rather than proof — the same honour-system identity model the rest of this
 * product runs on (#317) — which is why the arm that admitted the write is
 * persisted on the row and in `activity_log`.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { recordMeetingTiming } from "./timings-logic";

const uuid = z.string().uuid();

/**
 * A measured duration in WHOLE SECONDS.
 *
 * Bounded on BOTH sides at the edge, not only by the database's non-negative
 * check. This endpoint takes a number off a public request with no session, and
 * the column is an `integer`: a value past 2^31 makes Postgres throw a range
 * error the caller sees as a 500 rather than as "that is not a time". Twelve
 * hours is far past any meeting this app describes and still leaves a
 * pathological-but-honest measurement recordable.
 */
const MAX_ELAPSED_SECONDS = 12 * 60 * 60;

/** A mark, in MINUTES, as the printed agenda states it. `.nullable()` because a
 *  beat can legitimately carry a partial trio, and the row records that
 *  honestly rather than inventing an edge. */
const mark = z.number().finite().min(0).max(600).nullable();

const recordTimingSchema = z.object({
	meetingId: uuid,
	/** The agenda slot timed. REQUIRED: a hand-made request carrying no slot id
	 *  is rejected here, before it can reach a row whose subject is nothing. */
	slotId: uuid,
	elapsedSeconds: z.number().int().min(0).max(MAX_ELAPSED_SECONDS),
	/** The marks in force when the clock stopped. OMITTED on a correction, which
	 *  must leave the stored copy alone — an officer fixing a mistyped number is
	 *  not re-deciding the window it was judged against. */
	marks: z
		.object({ green: mark, yellow: mark, red: mark })
		.partial()
		.optional(),
	/** Self-asserted roster member id (#317). Club-scoped server-side; a real
	 *  session wins over it. */
	actorMemberId: uuid.optional(),
});

/**
 * Record — or correct — one segment's measured time.
 *
 * POST, and it stays POST: a `createServerFn`'s URL is derived from its file
 * and export name, so flipping the method later is a breaking change for every
 * tab already open (CLAUDE.md's note on #504).
 */
export const recordTiming = createServerFn({ method: "POST" })
	.validator((input: unknown) => recordTimingSchema.parse(input))
	.handler(async ({ data }) =>
		recordMeetingTiming({
			meetingId: data.meetingId,
			slotId: data.slotId,
			elapsedSeconds: data.elapsedSeconds,
			marks: data.marks,
			// The RAW claim, handed to the seam under the name the resolver uses.
			// Spelled out rather than spread, because the rename is the whole
			// point: what arrives is what a client SAID, and `resolveWriteActor`
			// club-scopes it before anything is credited to it (#396).
			claimedActorMemberId: data.actorMemberId,
		}),
	);
