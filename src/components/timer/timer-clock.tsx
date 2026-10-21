// src/components/timer/timer-clock.tsx
//
// The clock/display half of the Timer, split out of `meeting-timer.tsx` (#1248)
// so the public `/timer` page can render the SAME clock the meeting timer does.
//
// ## The boundary this file exists to hold
//
// NOTHING in here may import `#/server/*` or `#/db`. `MeetingTimer` keeps the run
// sheet and `recordTiming`; the public page has no club, no meeting and no
// write, and `timer-route.guard.test.ts` asserts the route's import graph
// reaches neither. The band comes from `timerSignal` and the state from
// `timer-state`, never re-implemented here.
import { useEffect, useRef } from "react";
import { Button } from "#/components/ui/button";
import type { TimingMarks } from "#/lib/agenda-runsheet";
import type { TableTopicsLimits } from "#/lib/table-topics-limits";
import { timingNotRecordableMessage } from "#/lib/timeable-roles";
import {
	TIMER_BAND_LABEL,
	type TimerBand,
	type TimerKind,
	timerSignal,
} from "#/lib/timer-signal";
import {
	elapsedMs,
	formatElapsedSeconds,
	formatStopwatch,
	type TimerAction,
	type TimerState,
} from "#/lib/timer-state";
import {
	formatTimingClock,
	qualifyingWindowForMarks,
} from "#/lib/timing-window";
import { cn } from "#/lib/utils";

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
	/**
	 * WHY not, when `recordable` is false — because the two reasons are
	 * different facts and telling a Timer the wrong one mid-meeting is worse
	 * than telling them nothing.
	 *
	 * `not-timeable` is a fact about the ROLE: the Table Topics row is
	 * slot-backed, but its slot is the Table Topics MASTER's, so one stored
	 * number would cover a segment with four to eight speakers.
	 * `no-single-slot` is a fact about the ROW: #732 leaves `slotId` null on an
	 * event beat, a `renderUnowned` row, a beat whose `roleKey` is null (the
	 * editor's "Nobody"), and a non-repeating role beat bound to two or more
	 * slots. A Speaker row on that last arm is emphatically a speech, and
	 * telling its Timer it "isn't a speech" would send them looking for an
	 * agenda mistake that is not there.
	 *
	 * Null when the caller passed no slot columns at all (#729's ephemeral
	 * shape): this surface then has nothing to judge by, and saying so would be
	 * a guess. Nothing is rendered for it.
	 */
	unrecordableReason: UnrecordableReason | null;
};

/** See `TimerSegment.unrecordableReason`. */
export type UnrecordableReason = "not-timeable" | "no-single-slot";

/**
 * Why a row with no single slot cannot be recorded (#732's four null-`slotId`
 * arms). Not `timingNotRecordableMessage`, which is about the ROLE: on the
 * two-or-more-slots arm the role is often Speaker, and "isn't a speech" would
 * be flatly untrue.
 */
const NO_SINGLE_SLOT_MESSAGE =
	"This row isn't one person's turn, so there's no one speaker to record a time against. The clock still works.";

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

/** `screen` variant (#1248): the band as a background, with an ink that holds
 *  contrast on it. The four hues are the four cards a Toastmasters timer raises;
 *  `over` is a deeper red, separated by its label, as in `BAND_CLASS`. */
const SCREEN_BG_CLASS: Record<TimerBand, string> = {
	under: "bg-background",
	green: "bg-[#1f7a46]",
	yellow: "bg-[#f2c230]",
	red: "bg-[#c0262d]",
	over: "bg-[#7a1218]",
};
const SCREEN_TEXT_CLASS: Record<TimerBand, string> = {
	under: "text-foreground",
	green: "text-white",
	yellow: "text-[#1a1405]",
	red: "text-white",
	over: "text-white",
};
/** `screen` variant's primary button (Start / Pause / Resume): drawn in the
 *  band's ink so it stays the one solid thing on any of the four colours,
 *  where the theme's teal would clash with green and vanish on yellow. */
const SCREEN_SOLID_CLASS: Record<TimerBand, string> = {
	under: "",
	green: "bg-white text-[#1f7a46] hover:bg-white/90",
	yellow: "bg-[#1a1405] text-[#f2c230] hover:bg-[#1a1405]/90",
	red: "bg-white text-[#c0262d] hover:bg-white/90",
	over: "bg-white text-[#7a1218] hover:bg-white/90",
};
/** `screen` variant's secondary buttons: an outline in the band's own ink. */
const SCREEN_QUIET_CLASS =
	"border-current/40 bg-transparent text-inherit shadow-none hover:bg-black/10 hover:text-inherit dark:border-current/40 dark:bg-transparent dark:hover:bg-black/10";

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
export function useWakeLock(active: boolean): void {
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

/** A card's colour beside its mark on the `screen` variant. Off the dark idle
 *  ground it gets a ring in the band's ink, so a green dot still reads on the
 *  green screen. */
function MarkDot({ band, className }: { band: TimerBand; className: string }) {
	return (
		<span
			aria-hidden
			className={cn(
				"inline-block size-2.5 rounded-full",
				band !== "under" && "ring-2 ring-current/70",
				className,
			)}
		/>
	);
}

/** What happened to a segment's record attempt. Kept per segment rather than
 *  as one page-level flag: the Timer stops eight clocks over an evening, and a
 *  single banner would say nothing about WHICH one failed. */
export type RecordOutcome =
	| { status: "saving" }
	| { status: "saved"; elapsedSeconds: number; verdict: string }
	| { status: "error"; message: string };

export function SegmentClock({
	segment,
	state,
	now,
	limits,
	outcome,
	canRecord,
	onAction,
	variant = "card",
	showClock = true,
	startDisabled = false,
}: {
	/** Disables Start and Resume (the public page's invalid marks, #1248). */
	startDisabled?: boolean;
	/** `screen` (#1248) fills its box with the band's colour, for the public
	 *  page held in landscape; `card` is the meeting timer's. */
	variant?: "card" | "screen";
	/** False hides the digits only. The band, the label and the clock itself
	 *  carry on: the Timer can watch the colour without the number. */
	showClock?: boolean;
	segment: TimerSegment;
	state: TimerState;
	now: number;
	limits: TableTopicsLimits | null;
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

	const screen = variant === "screen";
	const text = screen ? SCREEN_TEXT_CLASS[band] : BAND_CLASS[band];
	// `screen` buttons: one solid primary in the band's ink, the rest quiet
	// outlines, all on one centred row a thumb can reach.
	const solid = screen
		? cn("min-h-14 flex-1 text-base", SCREEN_SOLID_CLASS[band])
		: "min-h-11 flex-1";
	const quiet = screen
		? cn("min-h-14 flex-1 text-base", SCREEN_QUIET_CLASS)
		: "min-h-11 flex-1";

	return (
		<div
			data-band={band}
			className={
				screen
					? cn(
							// `@container` so the digits size to this box, not the window:
							// idle it is a card inside the page's column, running it is the
							// whole screen.
							"@container flex flex-col items-center justify-center gap-3 px-4 py-5 text-center transition-colors sm:gap-6 sm:py-8",
							state.phase === "idle"
								? "rounded-2xl border border-[var(--line)]"
								: "min-h-svh",
							SCREEN_BG_CLASS[band],
						)
					: "space-y-3 rounded-lg border border-[var(--line)] p-3"
			}
		>
			{/* The public page has no role and no holder: its h1 already says what
			    this is, so the label is for screen readers only. */}
			<div className={screen ? "sr-only" : undefined}>
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
			<p
				className={
					screen
						? `flex flex-wrap items-center justify-center gap-x-4 gap-y-1 font-medium text-sm tabular-nums ${text}`
						: "text-xs text-muted-foreground"
				}
			>
				<span
					className={
						screen ? "inline-flex items-center gap-1.5" : "text-success"
					}
				>
					{screen ? <MarkDot band={band} className="bg-[#1f7a46]" /> : null}
					Green {formatTimingClock(segment.marks.green)}
				</span>
				{screen ? null : " · "}
				<span
					className={
						screen
							? "inline-flex items-center gap-1.5"
							: "text-warning-foreground"
					}
				>
					{screen ? <MarkDot band={band} className="bg-[#f2c230]" /> : null}
					Yellow {formatTimingClock(segment.marks.yellow)}
				</span>
				{screen ? null : " · "}
				<span
					className={
						screen ? "inline-flex items-center gap-1.5" : "text-destructive"
					}
				>
					{screen ? <MarkDot band={band} className="bg-[#c0262d]" /> : null}
					Red {formatTimingClock(segment.marks.red)}
				</span>
				{window ? (
					screen ? (
						<span className="opacity-80">Qualifies {window.range}</span>
					) : (
						<> · Qualifies {window.range}</>
					)
				) : null}
			</p>

			<div
				className={
					screen
						? "flex flex-col items-center gap-2"
						: "flex items-baseline gap-3"
				}
			>
				{/* `tabular-nums` so the digits do not shift width as they change —
				    a clock that jitters is hard to read at a glance from a chair. */}
				{showClock ? (
					<output
						aria-live="off"
						className={`font-display font-semibold tabular-nums ${
							!screen
								? "text-4xl"
								: // Idle it shares the page with the settings and must leave
									// Start above the fold (#1270); running it owns the screen.
									state.phase === "idle"
									? "text-[min(24cqw,20svh)] leading-none"
									: "text-[min(30cqw,38svh)] leading-none"
						} ${text}`}
					>
						{formatStopwatch(elapsed)}
					</output>
				) : null}
				{/* The colour is the signal, and colour alone is not a signal — this
				    is what a screen reader and a colour-blind Timer read instead. */}
				<span
					className={`font-medium ${screen ? "text-xl sm:text-2xl" : "text-sm"} ${text}`}
				>
					{TIMER_BAND_LABEL[band]}
				</span>
			</div>

			{/* `min-h-11` for the 44px tap floor, same as the personal page: this is
			    a thumb on a phone in a dim room, mid-speech. */}
			<div
				className={
					screen
						? `flex w-full max-w-md flex-wrap justify-center gap-2 ${text}`
						: "flex flex-wrap gap-2"
				}
			>
				{state.phase === "idle" ? (
					<Button
						className={solid}
						disabled={startDisabled}
						onClick={() => onAction({ type: "start", now: Date.now() })}
					>
						Start
					</Button>
				) : null}
				{running ? (
					<Button
						className={screen ? solid : quiet}
						variant={screen ? "default" : "outline"}
						onClick={() => onAction({ type: "pause", now: Date.now() })}
					>
						Pause
					</Button>
				) : null}
				{state.phase === "paused" ? (
					<Button
						className={solid}
						disabled={startDisabled}
						onClick={() => onAction({ type: "resume", now: Date.now() })}
					>
						Resume
					</Button>
				) : null}
				{state.phase === "running" || state.phase === "paused" ? (
					<Button
						className={quiet}
						variant="outline"
						onClick={() => onAction({ type: "stop", now: Date.now() })}
					>
						Stop
					</Button>
				) : null}
				{state.phase !== "idle" ? (
					<Button
						className={
							screen
								? cn(
										"min-h-14 text-base",
										SCREEN_QUIET_CLASS,
										"border-transparent",
									)
								: "min-h-11"
						}
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
			{canRecord && segment.unrecordableReason !== null ? (
				// Said once, on the card it is about, and only to someone who can
				// record the others. Otherwise a Timer with eight cards and seven
				// receipts is left guessing why one has none.
				//
				// The two reasons are DIFFERENT sentences. The role one is the
				// server's own — imported rather than re-worded, so the refusal a
				// hand-made request gets and the explanation the surface gives are
				// one string. The row one has no server equivalent to share: a
				// slot-less row sends no `slotId` at all, so the server never sees
				// it and never has to name it.
				<p className="text-muted-foreground text-xs">
					{segment.unrecordableReason === "not-timeable"
						? timingNotRecordableMessage(segment.roleLabel)
						: NO_SINGLE_SLOT_MESSAGE}
				</p>
			) : null}
			{outcome?.status === "saving" ? (
				<p className="text-muted-foreground text-xs">Saving…</p>
			) : null}
			{outcome?.status === "saved" ? (
				<p className="text-xs text-success">
					Recorded {formatElapsedSeconds(outcome.elapsedSeconds)} ·{" "}
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
