// src/components/club/meeting-timer.tsx
//
// The Timer's stopwatch (#729) — one clock per timed segment, on the phone of
// the person whose whole job is a measurement.
//
// ## Why the markup is here and not in the route
//
// `club.$clubId.meeting.$meetingId_.me_.timer.tsx` imports `#/server/meetings`,
// which reaches `#/db` and throws `DATABASE_URL is not set` on import — so
// anything left in the route file is untestable by construction. That is the
// same boundary `personal-meeting-editors.tsx` sits on, and the same reason:
// `personal-duty-routes.guard.test.ts` can only assert the route's WIRING
// against its source text, while everything below is an ordinary render test.
//
// ## What gets a clock
//
// Every row with `marks !== null`, in run-sheet order, including the rows whose
// `slotId` is null. An officer who put timing marks on an event beat wants to
// time it, and a null `slotId` costs only the ability to RECORD (#730) — never
// the ability to measure. `buildTimerSegments` below is that rule, exported so
// it is asserted rather than described.
//
// ## The clock is not a counter
//
// `timer-state.ts` holds the phase machine and computes elapsed time from the
// wall clock on every read; the interval here carries NO state and exists only
// to force a re-render. A dropped tick — a backgrounded tab, a throttled timer,
// a phone that dimmed — therefore costs a stale pixel and never a stale
// measurement. See that module's header for why the obvious shape drifts.
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type RecordOutcome,
	SegmentClock,
	type TimerSegment,
	type UnrecordableReason,
	useWakeLock,
} from "#/components/timer/timer-clock";
import type { AgendaRow, AgendaSlot } from "#/lib/agenda-runsheet";
import {
	hasTableTopicsLimits,
	TABLE_TOPICS_ROLE_KEY,
	type TableTopicsLimits,
} from "#/lib/table-topics-limits";
import { isTimeableRole } from "#/lib/timeable-roles";
import {
	elapsedSeconds,
	IDLE_TIMER,
	type TimerAction,
	type TimerState,
	timerReducer,
} from "#/lib/timer-state";
import { TIMING_VERDICT_LABEL, timingVerdict } from "#/lib/timing-verdict";
import { recordTiming } from "#/server/timings";

// The clock/display half lives in `#/components/timer/timer-clock` (#1248) so
// the public `/timer` page can render it without reaching `#/server`. These
// types stay importable from here for the callers that already do.
export type { TimerSegment, UnrecordableReason };

/** The columns `isTimeableRole` reads, per slot. A `Map` so the lookup is not
 *  a scan per row on an agenda that can carry dozens of slots. */
type SlotColumns = { isSpeakerRole: boolean; category: string };

/**
 * The timed rows of a run sheet, in order.
 *
 * `marks !== null` is the ONLY filter on WHICH ROWS APPEAR, deliberately: the
 * printed agenda decides which rows carry a trio of marks, and this surface
 * must clock exactly those. Adding a second condition here (only slot-backed
 * rows, only speeches) would put the phone and the paper into disagreement
 * about what the Timer is timing.
 *
 * `recordable` is a separate question with a separate answer, and keeping the
 * two apart is the whole shape of #729/#730: every marked row gets a CLOCK,
 * and only a slot-backed timeable one gets a RECORD.
 */
export function buildTimerSegments(
	rows: readonly AgendaRow[],
	slots: readonly Pick<AgendaSlot, "id" | "isSpeakerRole" | "category">[] = [],
): TimerSegment[] {
	const columns = new Map<string, SlotColumns>(
		slots.map((s) => [
			s.id,
			{ isSpeakerRole: s.isSpeakerRole, category: s.category },
		]),
	);
	const segments: TimerSegment[] = [];
	rows.forEach((row, index) => {
		if (!row.marks) return;
		const slotId = row.slotId ?? null;
		const slot = slotId ? columns.get(slotId) : undefined;
		// `slot` is undefined when the row names no slot AND when the caller
		// passed no slots at all — #729's shape, where nothing is recordable
		// because nothing can be. The two are told apart below by `slotId`.
		const recordable = slot !== undefined && isTimeableRole(slot);
		segments.push({
			key: slotId ?? `row-${index}`,
			slotId,
			// `roleLabel`/`holder` rather than splitting `who`: that string is
			// genuinely ambiguous (#463) and its own docblock says so.
			roleLabel: row.roleLabel ?? row.who,
			holder: row.holder ?? null,
			marks: row.marks,
			kind: row.roleKey === TABLE_TOPICS_ROLE_KEY ? "tableTopics" : "speech",
			recordable,
			unrecordableReason: recordable
				? null
				: slotId === null
					? "no-single-slot"
					: slot === undefined
						? null
						: "not-timeable",
		});
	});
	return segments;
}

export type MeetingTimerProps = {
	/** The meeting's date line, for the page's eyebrow. */
	when: string;
	/** Where "back to your meeting page" goes — the duty registry owns that
	 *  path (`personalMeetingHref`), so the route passes it in rather than this
	 *  component spelling a second copy of it. */
	backHref: string;
	/** The run sheet, already resolved by the caller through the SAME
	 *  `resolveAgendaRows` seam the printed agenda and the deck use. */
	rows: readonly AgendaRow[];
	/** The club's Table Topics window (#443), for the disqualification point.
	 *  Null when the club has stated none, in which case a Table Topics clock
	 *  runs the standard window and disqualifies after 2:30 — see `timerSignal`. */
	tableTopicsLimits: TableTopicsLimits | null;
	/** The meeting's slots, for the two `role_definitions` columns
	 *  `isTimeableRole` reads. Omit to get #729's pure stopwatch: with no slot
	 *  columns nothing is recordable, which is the honest default. */
	slots?: readonly Pick<AgendaSlot, "id" | "isSpeakerRole" | "category">[];
	/**
	 * Present when this surface may write (#730); absent for a viewer who cannot.
	 *
	 * `canRecord` is an AFFORDANCE, re-decided server-side on every request — the
	 * client computes it from the meeting's own slots (am I the Timer, the TMOD,
	 * or an officer) so a member who is none of those is not shown a control that
	 * would only produce an error. It grants nothing.
	 */
	recording?: {
		/** The meeting's UUID. NEVER the `$meetingId` URL segment — that is a
		 *  club-local date key and the writer validates a uuid. */
		meetingId: string;
		/** Self-asserted roster identity (#317). Club-scoped server-side. */
		actorMemberId: string;
		canRecord: boolean;
	};
};

export function MeetingTimer({
	when,
	backHref,
	rows,
	tableTopicsLimits,
	slots,
	recording,
}: MeetingTimerProps) {
	const segments = buildTimerSegments(rows, slots);
	const [states, setStates] = useState<Record<string, TimerState>>({});
	/**
	 * The authoritative clock store; `states` is its render mirror.
	 *
	 * INVARIANT: `setStates` is called from `dispatch` and nowhere else, and
	 * every call writes this ref first. Two sources of truth are worth it here
	 * for the reason `dispatch` sets out — the reducer has to run outside the
	 * state updater, so it needs a synchronous read of the current clocks that a
	 * render snapshot cannot give it.
	 */
	const statesRef = useRef<Record<string, TimerState>>({});
	const [outcomes, setOutcomes] = useState<Record<string, RecordOutcome>>({});
	// The tick. State, not a ref, because its only job is to make React render
	// again — see the module header on why it carries no measurement.
	const [now, setNow] = useState(() => Date.now());
	const running = segments.some(
		(s) => (states[s.key] ?? IDLE_TIMER).phase === "running",
	);

	useEffect(() => {
		if (!running) return;
		// 200ms rather than 1000ms: at one second the displayed number lags the
		// real one by up to a full second, which on a surface whose job is a
		// boundary instant is the difference between a red card and a green one.
		const id = setInterval(() => setNow(Date.now()), 200);
		return () => clearInterval(id);
	}, [running]);

	useWakeLock(running);

	/**
	 * Store what a stopped clock measured (#730).
	 *
	 * Fired from the STOP transition and from nowhere else — a pause is not a
	 * finished measurement, and `timer-state.ts` refuses to resume a stopped
	 * clock precisely so the surface cannot end up showing a number the stored
	 * row no longer matches.
	 *
	 * Everything it decides is an affordance: the server re-runs the timeable
	 * check and the whole actor ladder, and its refusal is what the Timer sees.
	 * Both refusals are shown VERBATIM, because they mean different things —
	 * "this segment has no one speaker" and "not you" send the Timer to two
	 * different places, which is why the server throws two named errors rather
	 * than one.
	 */
	const record = useCallback(
		async (segment: TimerSegment, elapsedSeconds: number) => {
			if (!recording?.canRecord || !segment.recordable || !segment.slotId) {
				return;
			}
			const slotId = segment.slotId;
			setOutcomes((prev) => ({ ...prev, [segment.key]: { status: "saving" } }));
			try {
				const saved = await recordTiming({
					data: {
						meetingId: recording.meetingId,
						slotId,
						elapsedSeconds,
						// The marks the clock was JUDGED against travel with the
						// measurement, so the row records the window in force at the time
						// and a later agenda edit cannot re-decide it.
						marks: {
							green: segment.marks.green,
							yellow: segment.marks.yellow,
							red: segment.marks.red,
						},
						actorMemberId: recording.actorMemberId,
					},
				});
				setOutcomes((prev) => ({
					...prev,
					[segment.key]: {
						status: "saved",
						elapsedSeconds: saved.elapsedSeconds,
						// Derived from what the SERVER stored, not from what this render
						// happens to hold: if the two ever differ, the record is the
						// truth and the Timer should be reading it.
						verdict:
							TIMING_VERDICT_LABEL[
								timingVerdict(saved.elapsedSeconds, saved, "speech")
							],
					},
				}));
			} catch (err) {
				setOutcomes((prev) => ({
					...prev,
					[segment.key]: {
						status: "error",
						message:
							err instanceof Error
								? err.message
								: "Couldn't save that time. The clock still shows it.",
					},
				}));
			}
		},
		[recording],
	);

	const dispatch = useCallback(
		(segment: TimerSegment, action: TimerAction) => {
			const key = segment.key;
			// The reducer runs OUTSIDE the state updater, against the ref.
			//
			// It used to run inside `setStates((prev) => …)` with the record fired
			// from there, which is a side effect in a place React is allowed to run
			// twice: StrictMode double-invokes updaters and a concurrent render can
			// replay them, so one Stop could send TWO `recordTiming` POSTs — a
			// duplicated measurement of a real speech. A test that renders outside
			// StrictMode cannot see it, which is why there is one below that does.
			//
			// This is an event handler, which React never double-invokes, so the
			// synchronous ref write here is safe — and it is also what makes two
			// dispatches inside one tick read each other rather than both seeing the
			// render's stale snapshot. `use-offline-minutes.ts` keeps `meetingIdRef`
			// and `drainingRef` for the same "a synchronous read the render cycle
			// cannot give me" reason.
			const next = timerReducer(statesRef.current[key] ?? IDLE_TIMER, action);
			statesRef.current = { ...statesRef.current, [key]: next };
			setStates(statesRef.current);
			// Read the elapsed time off the state the reducer just produced, not off
			// a fresh `Date.now()` a tick later: a stop is a closed interval, and
			// re-measuring afterwards would record whatever the render loop happened
			// to see. `action.now` is passed for form only — a `stopped` state has no
			// open interval, so `elapsedSeconds` does not read it — and it is the
			// stop instant rather than an arbitrary later one.
			if (action.type === "stop" && next.phase === "stopped") {
				void record(segment, elapsedSeconds(next, action.now));
			}
			// Clearing the clock clears its receipt too: leaving "Recorded 6:11"
			// under a 0:00 clock invites a re-read of a number that is no longer on
			// screen. The stored row is untouched — a reset is a display action, and
			// re-recording is what replaces the row.
			if (action.type === "reset") {
				setOutcomes((prev) => {
					if (!(key in prev)) return prev;
					const { [key]: _dropped, ...rest } = prev;
					return rest;
				});
			}
			// Repaint immediately rather than waiting up to 200ms for the next tick —
			// a Start whose clock still reads 0:00 for a fifth of a second reads as a
			// tap that did not land, and the Timer taps again.
			setNow(Date.now());
		},
		[record],
	);

	const limits = hasTableTopicsLimits(tableTopicsLimits)
		? tableTopicsLimits
		: null;

	return (
		<div className="mx-auto w-full max-w-reading space-y-4 p-4 pb-10">
			<header className="space-y-1 pt-2">
				<p className="text-muted-foreground text-xs font-semibold uppercase tracking-[0.04em]">
					{when}
				</p>
				<h1 className="font-display text-2xl font-semibold tracking-tight">
					Time the meeting
				</h1>
				<p className="text-muted-foreground text-sm">
					One clock per timed segment, with this meeting's own green, yellow and
					red. Everything runs on this device — it keeps going with no signal.
				</p>
			</header>

			{segments.length === 0 ? (
				// Explicit, never a blank page: an agenda with no timed row is a real
				// state (a club that has set no min/max on anything), and a Timer
				// staring at an empty screen cannot tell it from a broken link.
				<p className="rounded-md border border-border p-3 text-muted-foreground text-sm">
					Nothing on this agenda has timing marks yet, so there is nothing to
					time. Whoever edits the agenda can add a minimum and maximum to a
					segment.
				</p>
			) : (
				<ul className="space-y-3">
					{segments.map((segment) => (
						<li key={segment.key}>
							<SegmentClock
								segment={segment}
								state={states[segment.key] ?? IDLE_TIMER}
								now={now}
								limits={limits}
								outcome={outcomes[segment.key]}
								canRecord={recording?.canRecord ?? false}
								onAction={(action) => dispatch(segment, action)}
							/>
						</li>
					))}
				</ul>
			)}

			<div className="flex flex-wrap gap-x-4 gap-y-2">
				<Link
					to={backHref}
					className="inline-block text-sm text-primary hover:underline"
				>
					Back to your meeting page
				</Link>
				{/* The same clock with no meeting behind it (#1248): a contest
				    practice, another club's meeting, a speech rehearsed at home. */}
				<Link
					to="/timer"
					className="inline-block text-sm text-primary hover:underline"
				>
					Standalone timer
				</Link>
			</div>
		</div>
	);
}
