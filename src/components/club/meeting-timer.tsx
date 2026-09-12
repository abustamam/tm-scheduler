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
import type { AgendaRow, AgendaSlot, TimingMarks } from "#/lib/agenda-runsheet";
import {
	hasTableTopicsLimits,
	TABLE_TOPICS_ROLE_KEY,
	type TableTopicsLimits,
} from "#/lib/table-topics-limits";
import {
	isTimeableRole,
	timingNotRecordableMessage,
} from "#/lib/timeable-roles";
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
import { TIMING_VERDICT_LABEL, timingVerdict } from "#/lib/timing-verdict";
import {
	formatTimingClock,
	qualifyingWindowForMarks,
} from "#/lib/timing-window";
import { recordTiming } from "#/server/timings";

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
	/**
	 * Whether stopping this clock can be RECORDED (#730): the row is backed by
	 * one slot AND that slot's role is timeable.
	 *
	 * Decided with `isTimeableRole`, the same predicate `recordMeetingTiming`
	 * asks on the server, so the affordance and the mutation cannot disagree —
	 * the #464/#510 rule. False is the honest answer for the Table Topics row
	 * (its slot is the Table Topics MASTER's, so a stored number would be one
	 * time for a segment with four to eight speakers) and for every row with no
	 * single slot. Such a row still gets a working clock; what it does not get is
	 * a button that would fail.
	 */
	recordable: boolean;
};

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
		segments.push({
			key: slotId ?? `row-${index}`,
			slotId,
			// `roleLabel`/`holder` rather than splitting `who`: that string is
			// genuinely ambiguous (#463) and its own docblock says so.
			roleLabel: row.roleLabel ?? row.who,
			holder: row.holder ?? null,
			marks: row.marks,
			kind: row.roleKey === TABLE_TOPICS_ROLE_KEY ? "tableTopics" : "speech",
			// `slot` is undefined when the row names no slot AND when the caller
			// passed no slots at all — #729's shape, where nothing is recordable
			// because nothing can be.
			recordable: slot !== undefined && isTimeableRole(slot),
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

/** What happened to a segment's record attempt. Kept per segment rather than
 *  as one page-level flag: the Timer stops eight clocks over an evening, and a
 *  single banner would say nothing about WHICH one failed. */
type RecordOutcome =
	| { status: "saving" }
	| { status: "saved"; elapsedSeconds: number; verdict: string }
	| { status: "error"; message: string };

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
			setStates((prev) => {
				const next = timerReducer(prev[key] ?? IDLE_TIMER, action);
				// Read the elapsed time off the state the reducer just produced, not
				// off a fresh `Date.now()` a tick later: a stop is a closed interval,
				// and re-measuring afterwards would record whatever the render loop
				// happened to see.
				if (action.type === "stop" && next.phase === "stopped") {
					void record(segment, Math.round(next.accumulatedMs / 1000));
				}
				return { ...prev, [key]: next };
			});
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
								outcome={outcomes[segment.key]}
								canRecord={recording?.canRecord ?? false}
								onAction={(action) => dispatch(segment, action)}
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
	outcome,
	canRecord,
	onAction,
}: {
	segment: TimerSegment;
	state: TimerState;
	now: number;
	limits: { maxSeconds: number } | null;
	outcome: RecordOutcome | undefined;
	/** Whether this VIEWER may record at all. Separate from
	 *  `segment.recordable`, which is about the ROW — a Timer looking at the
	 *  Table Topics card needs to be told why that one is different, and a
	 *  visitor who may record nothing needs to be told nothing. */
	canRecord: boolean;
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

			{/* The RECEIPT (#730). Stopping the clock is the record — there is no
			    second "save" tap, because the Timer's hands are already busy and a
			    measurement that needs confirming is one that gets lost. */}
			{canRecord && !segment.recordable ? (
				// Said once, on the card it is about, and only to someone who can
				// record the others. Otherwise a Timer with eight cards and seven
				// receipts is left guessing why one has none.
				<p className="text-muted-foreground text-xs">
					{timingNotRecordableMessage(segment.roleLabel)}
				</p>
			) : null}
			{outcome?.status === "saving" ? (
				<p className="text-muted-foreground text-xs">Saving…</p>
			) : null}
			{outcome?.status === "saved" ? (
				<p className="text-xs text-success">
					Recorded {formatStopwatch(outcome.elapsedSeconds * 1000)} ·{" "}
					{outcome.verdict}
				</p>
			) : null}
			{outcome?.status === "error" ? (
				// The clock keeps its reading, and the copy says so: the measurement
				// is not lost just because the write was refused, and a Timer who
				// thinks it is will stop trusting the surface mid-meeting.
				<p className="text-xs text-destructive">{outcome.message}</p>
			) : null}
		</div>
	);
}
