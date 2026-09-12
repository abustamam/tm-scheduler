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
import { Button } from "#/components/ui/button";
import type { AgendaRow, TimingMarks } from "#/lib/agenda-runsheet";
import {
	hasTableTopicsLimits,
	TABLE_TOPICS_ROLE_KEY,
	type TableTopicsLimits,
} from "#/lib/table-topics-limits";
import {
	TIMER_BAND_LABEL,
	type TimerBand,
	type TimerKind,
	timerSignal,
} from "#/lib/timer-signal";
import {
	elapsedMs,
	formatStopwatch,
	IDLE_TIMER,
	type TimerAction,
	type TimerState,
	timerReducer,
} from "#/lib/timer-state";
import {
	formatTimingClock,
	qualifyingWindowForMarks,
} from "#/lib/timing-window";

/** One timed row, reduced to what a clock needs. */
export type TimerSegment = {
	/** Stable render + state key. The slot id where there is one; otherwise the
	 *  run-sheet position, which is all a slot-less row has. */
	key: string;
	/** `AgendaRow.slotId` — null on a row that is about no single slot. #730
	 *  refuses to record those, and says so; this surface still clocks them. */
	slotId: string | null;
	roleLabel: string;
	holder: string | null;
	marks: TimingMarks;
	/** Which disqualification rule applies — see `timer-signal.ts`. */
	kind: TimerKind;
};

/**
 * The timed rows of a run sheet, in order.
 *
 * `marks !== null` is the ONLY filter, deliberately: the printed agenda decides
 * which rows carry a trio of marks, and this surface must clock exactly those.
 * Adding a second condition here (only slot-backed rows, only speeches) would
 * put the phone and the paper into disagreement about what the Timer is timing.
 */
export function buildTimerSegments(rows: readonly AgendaRow[]): TimerSegment[] {
	const segments: TimerSegment[] = [];
	rows.forEach((row, index) => {
		if (!row.marks) return;
		segments.push({
			key: row.slotId ?? `row-${index}`,
			slotId: row.slotId ?? null,
			// `roleLabel`/`holder` rather than splitting `who`: that string is
			// genuinely ambiguous (#463) and its own docblock says so.
			roleLabel: row.roleLabel ?? row.who,
			holder: row.holder ?? null,
			marks: row.marks,
			kind: row.roleKey === TABLE_TOPICS_ROLE_KEY ? "tableTopics" : "speech",
		});
	});
	return segments;
}

/** Band → the colour the number is drawn in. `over` shares red's hue with the
 *  red card on purpose — it is a worse red, not a different signal — and is
 *  separated by weight and by its own label rather than by a fifth colour
 *  nobody has been taught. */
const BAND_CLASS: Record<TimerBand, string> = {
	under: "text-muted-foreground",
	green: "text-success",
	yellow: "text-warning-foreground",
	red: "text-destructive",
	over: "text-destructive",
};

/**
 * Hold the screen awake while any clock is running (#729).
 *
 * Feature-detected and silent on failure: `navigator.wakeLock` is partial on
 * Safari, and a Timer whose browser does not support it must still get a
 * working stopwatch rather than an error. RELEASED on pause, stop and unmount —
 * a lock left held drains the phone for the rest of the evening, and this
 * surface is open for the whole meeting.
 *
 * The sentinel is kept in a ref rather than in state because releasing it must
 * not depend on a render happening: the unmount path runs in a cleanup, and by
 * then there is no render left.
 */
function useWakeLock(active: boolean): void {
	const sentinel = useRef<{ release: () => Promise<void> } | null>(null);
	useEffect(() => {
		// Narrowed here rather than via a global type augmentation: the API is not
		// in this project's lib and a `declare global` for one optional field is a
		// larger claim than the one call site needs.
		const nav = navigator as Navigator & {
			wakeLock?: { request: (type: "screen") => Promise<WakeLockLike> };
		};
		let cancelled = false;
		const release = () => {
			const held = sentinel.current;
			sentinel.current = null;
			// `.catch` and not `await`: a release that rejects (the lock was already
			// dropped when the tab was hidden) is not an error the Timer can act on.
			held?.release().catch(() => {});
		};
		if (!active || !nav.wakeLock) {
			release();
			return;
		}
		nav.wakeLock
			.request("screen")
			.then((lock) => {
				// The request is async, so `active` may already have gone false — and
				// on a fast pause it does. Without this the lock is acquired AFTER the
				// cleanup ran and is never released.
				if (cancelled) {
					lock.release().catch(() => {});
					return;
				}
				sentinel.current = lock;
			})
			.catch(() => {});
		return () => {
			cancelled = true;
			release();
		};
	}, [active]);
}

type WakeLockLike = { release: () => Promise<void> };

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
	 *  has no DQ — see `timerSignal`. */
	tableTopicsLimits: TableTopicsLimits | null;
};

export function MeetingTimer({
	when,
	backHref,
	rows,
	tableTopicsLimits,
}: MeetingTimerProps) {
	const segments = buildTimerSegments(rows);
	const [states, setStates] = useState<Record<string, TimerState>>({});
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

	const dispatch = useCallback((key: string, action: TimerAction) => {
		setStates((prev) => ({
			...prev,
			[key]: timerReducer(prev[key] ?? IDLE_TIMER, action),
		}));
		// Repaint immediately rather than waiting up to 200ms for the next tick —
		// a Start whose clock still reads 0:00 for a fifth of a second reads as a
		// tap that did not land, and the Timer taps again.
		setNow(Date.now());
	}, []);

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
				<p className="rounded-md border border-[var(--line)] p-3 text-muted-foreground text-sm">
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
								onAction={(action) => dispatch(segment.key, action)}
							/>
						</li>
					))}
				</ul>
			)}

			<Link
				to={backHref}
				className="inline-block text-sm text-primary hover:underline"
			>
				Back to your meeting page
			</Link>
		</div>
	);
}

function SegmentClock({
	segment,
	state,
	now,
	limits,
	onAction,
}: {
	segment: TimerSegment;
	state: TimerState;
	now: number;
	limits: { maxSeconds: number } | null;
	onAction: (action: TimerAction) => void;
}) {
	const elapsed = elapsedMs(state, now);
	const band = timerSignal(elapsed, segment.marks, segment.kind, limits);
	const window = qualifyingWindowForMarks(segment.marks);
	const running = state.phase === "running";

	return (
		<div className="space-y-3 rounded-lg border border-[var(--line)] p-3">
			<div>
				<h2 className="font-semibold text-base text-foreground">
					{segment.roleLabel}
				</h2>
				{segment.holder ? (
					<p className="text-muted-foreground text-sm">{segment.holder}</p>
				) : null}
			</div>

			{/* The three cards, as the SAME clock strings the printed agenda and the
			    Timer's role sheet print — `formatTimingClock` is the one formatter
			    all three go through, so the phone cannot read 6:30 beside a sheet
			    reading 6:29. */}
			<p className="text-muted-foreground text-xs">
				<span className="text-success">
					Green {formatTimingClock(segment.marks.green)}
				</span>
				{" · "}
				<span className="text-warning-foreground">
					Yellow {formatTimingClock(segment.marks.yellow)}
				</span>
				{" · "}
				<span className="text-destructive">
					Red {formatTimingClock(segment.marks.red)}
				</span>
				{window ? <> · Qualifies {window.range}</> : null}
			</p>

			<div className="flex items-baseline gap-3">
				{/* `tabular-nums` so the digits do not shift width as they change —
				    a clock that jitters is hard to read at a glance from a chair. */}
				<output
					aria-live="off"
					className={`font-display text-4xl font-semibold tabular-nums ${BAND_CLASS[band]}`}
				>
					{formatStopwatch(elapsed)}
				</output>
				{/* The colour is the signal, and colour alone is not a signal — this
				    is what a screen reader and a colour-blind Timer read instead. */}
				<span className={`text-sm font-medium ${BAND_CLASS[band]}`}>
					{TIMER_BAND_LABEL[band]}
				</span>
			</div>

			{/* `min-h-11` for the 44px tap floor, same as the personal page: this is
			    a thumb on a phone in a dim room, mid-speech. */}
			<div className="flex flex-wrap gap-2">
				{state.phase === "idle" ? (
					<Button
						className="min-h-11 flex-1"
						onClick={() => onAction({ type: "start", now: Date.now() })}
					>
						Start
					</Button>
				) : null}
				{running ? (
					<Button
						className="min-h-11 flex-1"
						variant="outline"
						onClick={() => onAction({ type: "pause", now: Date.now() })}
					>
						Pause
					</Button>
				) : null}
				{state.phase === "paused" ? (
					<Button
						className="min-h-11 flex-1"
						onClick={() => onAction({ type: "resume", now: Date.now() })}
					>
						Resume
					</Button>
				) : null}
				{state.phase === "running" || state.phase === "paused" ? (
					<Button
						className="min-h-11 flex-1"
						variant="outline"
						onClick={() => onAction({ type: "stop", now: Date.now() })}
					>
						Stop
					</Button>
				) : null}
				{state.phase !== "idle" ? (
					<Button
						className="min-h-11"
						variant="ghost"
						onClick={() => onAction({ type: "reset" })}
					>
						Reset
					</Button>
				) : null}
			</div>
		</div>
	);
}
