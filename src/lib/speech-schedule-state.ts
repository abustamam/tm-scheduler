/**
 * The derived state of one **speech-log row**, in one place (#656).
 *
 * ## Why this module exists
 *
 * `speeches` stores no status column and that is deliberate: ADR-0009 keeps
 * scheduling state (unscheduled / scheduled / delivered) DERIVED from slot
 * linkage plus the meeting date, so it cannot drift. Deriving it is therefore
 * every reader's job — and the dashboard's speech log never did it. It rendered
 * the green "Completed" pill unconditionally, with no predicate of any kind, so
 * a speech booked into next month's meeting was badged as already delivered
 * while the "My upcoming roles" card beside it called the same slot "Signed up".
 * Two cards on one screen contradicting each other about one row.
 *
 * The member profile route got it right, inline. That is the shape of the bug:
 * one payload (`SpeechLogRow`), two surfaces, and the derivation copy-pasted
 * into a route file where vitest cannot reach it. So it lives here instead —
 * pure, `#/db`-free and therefore importable by a client route AND assertable
 * without a session, a router or a database.
 *
 * ## The comparison instant is a PARAMETER, never the wall clock
 *
 * Nothing in here calls `Date.now()`. Reading the clock during render is the
 * hydration hazard #608 records on this very dashboard: the server renders with
 * one clock and the browser hydrates with another. It bites far more softly
 * here than in #608 (both sides compare absolute instants, so they can only
 * disagree for a meeting whose start falls inside the SSR-to-hydration gap,
 * rather than for every non-UTC reader), but a third copy of the pattern is not
 * worth adding. Both routes pin the instant in their LOADER and pass it down,
 * which makes the SSR pass and the hydration pass agree by construction and
 * lets a test drive both sides of the boundary with no clock mocking at all.
 */
import { isRealSpeechTitle } from "#/lib/speech-title";

/**
 * ADR-0009's own vocabulary for a row that HAS a slot. (Its third state,
 * `unscheduled`, is a speech with no slot at all — a different query and a
 * different card, `UnscheduledSpeeches`, so it cannot appear here.)
 *
 * `delivered` rather than `completed` because that is the word ADR-0009 uses
 * for the derived state; "Completed" is only what the pill SAYS. The two are
 * kept apart deliberately — see {@link SPEECH_SCHEDULE_STATE_LABELS}.
 */
export type SpeechScheduleState = "scheduled" | "delivered";

/**
 * The pill wording, so the two surfaces cannot drift into calling one state two
 * different things. Both routes render these constants rather than a literal;
 * hardcoding the word again on either surface is what this record exists to
 * stop, and the wiring guard in the sibling test fails on it.
 */
export const SPEECH_SCHEDULE_STATE_LABELS: Record<SpeechScheduleState, string> =
	{
		scheduled: "Scheduled",
		delivered: "Completed",
	};

/**
 * Epoch milliseconds for an instant that may already have crossed the wire.
 *
 * A server fn serializes `Date` to a string, so a loader field typed `Date` is
 * a real `Date` during the SSR pass and a `string` after hydration — the union
 * `personal-meeting-logic.ts` documents at length for the same reason. `null`
 * for anything unusable, including an unparseable string (`new Date(x)` yields
 * an Invalid Date whose `getTime()` is `NaN`, and every comparison against
 * `NaN` is false, which would silently pick a side).
 */
function instantMs(value: Date | string | number | null | undefined) {
	if (value === null || value === undefined) return null;
	const ms =
		value instanceof Date ? value.getTime() : new Date(value).getTime();
	return Number.isNaN(ms) ? null : ms;
}

/**
 * Has this speech been delivered yet, as of `now`?
 *
 * **Instant axis, not club-local day.** `meetingDatePassed` / `isMeetingOver`
 * (`meeting-lifecycle.ts`) answer a different question — "is the planning
 * window closed" — at day granularity in the club's timezone, and that file
 * explicitly says not to unify the two. This one is the past/upcoming LISTING
 * split, and it must be the exact complement of the query that fills the card
 * next to it: `loadMyCommitments` selects `scheduledAt >= now`, so a meeting
 * that has not started yet is `scheduled` here and shows as an upcoming role
 * there, and a meeting that started an hour ago is `delivered` here and has
 * already dropped out of there. Every row is in exactly one of the two, which
 * is the contradiction #656 was filed about.
 *
 * Boundary: a meeting whose start instant is exactly `now` is still
 * `scheduled`, matching the `gte` above. Strictly earlier is `delivered`.
 *
 * An absent or unparseable instant reads as `scheduled`. The failure is
 * asymmetric — claiming a talk was delivered when we cannot tell is the exact
 * false statement this module was written to remove, while calling an
 * undatable row "Scheduled" merely says nothing has happened yet.
 */
export function speechScheduleState(input: {
	scheduledAt: Date | string | number | null | undefined;
	now: Date | number;
}): SpeechScheduleState {
	const at = instantMs(input.scheduledAt);
	if (at === null) return "scheduled";
	const now = input.now instanceof Date ? input.now.getTime() : input.now;
	return at < now ? "delivered" : "scheduled";
}

/**
 * The headline both speech-log surfaces show for a row: the speech's title, or
 * the role's name when the speaker has not named it yet.
 *
 * **`speeches.title` is `NOT NULL`, so "undecided" is stored as the literal
 * `"TBA"`** — the sentinel `speech-title.ts` exists to describe. Both surfaces
 * used to write `l.speechTitle ?? l.roleName`, which only catches a row with no
 * speech attached at all and renders the placeholder verbatim for the single
 * most common way a speaker leaves a title open: a row headlined `TBA`, with
 * the project name it was created from sitting on the line below.
 *
 * `isRealSpeechTitle` is the one predicate that knows about the sentinel
 * (`normalizeSpeech`'s own `hasRealTitle` rule, lifted to `#/lib` so a client
 * route can import it). It is delegated to here, never re-derived — a local
 * "is it non-blank" test is precisely the bug that rule was written down after.
 */
export function speechLogHeadline(input: {
	speechTitle: string | null | undefined;
	roleName: string;
}): string {
	return isRealSpeechTitle(input.speechTitle)
		? (input.speechTitle?.trim() ?? input.roleName)
		: input.roleName;
}
