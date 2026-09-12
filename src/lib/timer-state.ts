/**
 * The Timer's stopwatch, as a pure reducer (#729).
 *
 * ## Why the state is two numbers and not an elapsed count
 *
 * The obvious shape — `elapsedMs`, incremented by a `setInterval` — drifts, and
 * it drifts in exactly the conditions this surface runs in. The Timer holds a
 * phone through a seven-minute speech; the tab is backgrounded when they glance
 * at a message, the browser throttles a background interval to once a minute or
 * stops it outright, and every dropped tick is time the clock silently loses.
 * A speech measured that way reads short, and reading short is the failure that
 * matters: it turns a disqualified speech into a qualifying one.
 *
 * So the state stores what cannot drift — the sum of CLOSED intervals plus the
 * instant the open one started — and `elapsedMs(state, now)` computes the
 * answer from the wall clock every time it is asked. A tick then carries no
 * state at all: it exists only to force a re-render, so dropping one costs a
 * stale pixel and never a stale measurement.
 *
 * ## Pure, and db-free by construction
 *
 * `now` is a PARAMETER on every action rather than a `Date.now()` call inside
 * the reducer, which is what makes the boundary instants — the whole point of a
 * timing test — assertable without faking timers. The module imports nothing.
 */

/**
 * `idle` is before the first start and after a reset; `stopped` is a finished
 * measurement, which is a different thing from `paused` and must be, because
 * #730 records a STOP and never a pause.
 */
export type TimerPhase = "idle" | "running" | "paused" | "stopped";

export type TimerState = {
	phase: TimerPhase;
	/**
	 * Sum of completed run intervals, in ms. NEVER includes the interval that is
	 * currently open — that is what `startedAt` is for, and folding the open one
	 * in here is precisely the drifting-counter shape this module avoids.
	 */
	accumulatedMs: number;
	/** Epoch ms when the current run interval opened; null unless running. */
	startedAt: number | null;
};

export type TimerAction =
	| { type: "start"; now: number }
	| { type: "pause"; now: number }
	| { type: "resume"; now: number }
	| { type: "stop"; now: number }
	| { type: "reset" };

/** A clock that has not been started. Frozen: one module-level constant is
 *  handed to every row's initial state, and a mutation would be shared. */
export const IDLE_TIMER: TimerState = Object.freeze({
	phase: "idle" as const,
	accumulatedMs: 0,
	startedAt: null,
});

/** Close the open interval, folding it into `accumulatedMs`. Zero when nothing
 *  is open, so it is safe to call on any phase. */
function closeInterval(state: TimerState, now: number): number {
	if (state.startedAt === null) return state.accumulatedMs;
	// `Math.max(0, …)` because `now` is wall-clock: an NTP correction or a manual
	// clock change mid-speech can move it BACKWARDS, and a negative interval
	// would subtract time from a measurement that only ever grew.
	return state.accumulatedMs + Math.max(0, now - state.startedAt);
}

/**
 * The phase machine. Every action is a NO-OP from a phase it does not apply to,
 * rather than a throw: the buttons are on a phone held by someone watching a
 * speaker, and a double-tapped Start must not restart the clock they are timing.
 *
 * The transitions, and what each no-op protects:
 *
 * - `start` from `idle` opens the first interval. From `running` it is ignored
 *   (a second tap would reset `startedAt` and silently drop the seconds already
 *   run). From `paused` it is ignored too — `resume` is the action for that, and
 *   treating `start` as a resume would make a mis-tap indistinguishable from an
 *   intended restart. From `stopped` it is ignored; `reset` first.
 * - `pause` from `running` closes the interval. Ignored everywhere else.
 * - `resume` from `paused` opens a new interval on top of what is banked.
 *   Ignored everywhere else — notably from `stopped`, so a finished measurement
 *   cannot quietly start growing again after #730 has recorded it.
 * - `stop` from `running` or `paused` closes the measurement. Ignored from
 *   `idle` (there is nothing to stop, and a `stopped` clock at 0:00 would offer
 *   #730 a zero-second speech to record) and from `stopped`.
 * - `reset` returns to `idle` from ANY phase, including `running`. That is the
 *   deliberate exception to "no destructive action while running": the Timer
 *   who started the wrong row needs one tap to fix it, and the alternative is a
 *   stop-then-reset that #730 would record on the way past.
 */
export function timerReducer(
	state: TimerState,
	action: TimerAction,
): TimerState {
	switch (action.type) {
		case "start":
			if (state.phase !== "idle") return state;
			return { phase: "running", accumulatedMs: 0, startedAt: action.now };
		case "pause":
			if (state.phase !== "running") return state;
			return {
				phase: "paused",
				accumulatedMs: closeInterval(state, action.now),
				startedAt: null,
			};
		case "resume":
			if (state.phase !== "paused") return state;
			return {
				phase: "running",
				accumulatedMs: state.accumulatedMs,
				startedAt: action.now,
			};
		case "stop":
			if (state.phase !== "running" && state.phase !== "paused") return state;
			return {
				phase: "stopped",
				accumulatedMs: closeInterval(state, action.now),
				startedAt: null,
			};
		case "reset":
			return { phase: "idle", accumulatedMs: 0, startedAt: null };
		default: {
			// Exhaustiveness guard — a new action must extend this switch.
			const _never: never = action;
			void _never;
			return state;
		}
	}
}

/**
 * Elapsed ms at `now`, the open interval included.
 *
 * This is what the surface renders and what #730 records, and it is a FUNCTION
 * rather than a field for the reason in the module header: read at render time
 * from the wall clock, it cannot be made wrong by a tick that never fired.
 */
export function elapsedMs(state: TimerState, now: number): number {
	return closeInterval(state, now);
}

/** Elapsed WHOLE seconds — the unit `meeting_timings.elapsed_seconds` stores
 *  (#730), rounded once, here, so the recorded number and the number the Timer
 *  read off the screen cannot differ by a rounding rule. */
export function elapsedSeconds(state: TimerState, now: number): number {
	return Math.round(elapsedMs(state, now) / 1000);
}

/** `mm:ss`, zero-padded, for the big clock. Minutes are NOT wrapped at 60 — a
 *  segment that ran 63 minutes reads "63:00", never "3:00". */
export function formatStopwatch(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const mins = Math.floor(total / 60);
	const secs = total % 60;
	return `${mins}:${String(secs).padStart(2, "0")}`;
}

/**
 * Whole SECONDS → `m:ss` — the ONE formatter for a stored measurement (#730).
 *
 * Every surface that renders a `meeting_timings.elapsed_seconds` goes through
 * this: the Timer's receipt, the minutes card and the minutes PDF. It exists as
 * its own name rather than as three `formatStopwatch(seconds * 1000)` call
 * sites so there is one thing to grep and one place to change.
 *
 * NOT `formatTimingClock`, and the distinction is the reason this is here.
 * That one formats a MARK — float minutes, where 6.5 is exactly what an admin
 * typed — so it ROUNDS to the nearest second and carries 60 into the next
 * minute. This formats a MEASUREMENT, which is already whole seconds, and
 * floors. The two agree for every value that can actually be stored, which is
 * precisely what makes using them interchangeably dangerous: a divergence would
 * be silent. One input type, one formatter.
 */
export function formatElapsedSeconds(seconds: number): string {
	return formatStopwatch(seconds * 1000);
}

/**
 * `mm:ss` → whole seconds, or null when the text is not a clock (#730).
 *
 * The inverse of `formatStopwatch`, for the one place a measured time is TYPED
 * rather than measured: an officer correcting a mistyped number on the minutes
 * screen.
 *
 * STRICTLY the clock form, and a bare number is refused. `parseTableTopicsClock`
 * next door accepts bare digits above a floor because no club's speaking LIMIT
 * is under twenty seconds — but a measured time genuinely can be, and the same
 * leniency here would read an officer typing "6" as six seconds instead of six
 * minutes and store it with every downstream check passing. The clock is
 * explicit about its units; someone who writes 0:06 means it.
 *
 * Minutes are not capped at 60 and seconds are, mirroring `formatStopwatch`: a
 * 63-minute segment is "63:00", and "6:75" is a typo rather than 7:15.
 */
export function parseStopwatch(text: string): number | null {
	const m = /^(\d{1,3}):([0-5]\d)$/.exec(text.trim());
	if (!m) return null;
	return Number(m[1]) * 60 + Number(m[2]);
}
