import { useEffect, useRef, useState } from "react";
import {
	MarkDot,
	SCREEN_BG_CLASS,
	SCREEN_QUIET_CLASS,
	SCREEN_SOLID_CLASS,
	SCREEN_TEXT_CLASS,
} from "#/components/timer/timer-clock";
import { Button } from "#/components/ui/button";
import { TIMER_BAND_LABEL, timerSignal } from "#/lib/timer-signal";
import { formatElapsedSeconds, formatStopwatch } from "#/lib/timer-state";
import { TIMING_VERDICT_LABEL, timingVerdict } from "#/lib/timing-verdict";
import {
	formatTimingClock,
	qualifyingWindowForMarks,
} from "#/lib/timing-window";
import { cn } from "#/lib/utils";

/**
 * Scene 4 of `/tour`, left half: the Timer's clock, a facsimile of the
 * `screen` variant of `SegmentClock` (`timer-clock.tsx`). The card fills with
 * the band's colour, and the band, the marks and the "Qualifies" window all
 * come from the same modules the real clock reads (`timer-signal.ts`,
 * `timing-window.ts`, `timing-verdict.ts`) and the band colours, button inks
 * and mark dots are imported from `timer-clock.tsx`, so a change to any of
 * them reaches this demo too. What is NOT shared is the layout and the state
 * machine (the real clock is driven by `timer-state`'s reducer and wall time).
 *
 * Local state only; nothing is recorded. It runs at {@link SPEED}x so a visitor
 * reaches green in 15 seconds instead of five minutes, and says so on the card.
 * Nothing time-based happens at render: the interval exists only after Start.
 *
 * The band hues are the real clock's own (a Toastmasters timer's cards), not
 * theme tokens, so they read the same in both themes. The colour change is
 * `motion-safe:` only, and the band is named in words, so colour is never the
 * only signal. A polite live region says the band only when it CHANGES, not on
 * every tick.
 */
export const TIMER_DEMO_SPEED = 20;
const MARKS = { green: 5, yellow: 6, red: 7 };
const TICK_MS = 100;

type Phase = "idle" | "running" | "paused" | "stopped";

export function TimerDemo() {
	const [phase, setPhase] = useState<Phase>("idle");
	// Demo milliseconds banked by earlier runs (before the last pause).
	const [banked, setBanked] = useState(0);
	// Real clock readings while running.
	const [startedAt, setStartedAt] = useState(0);
	const [now, setNow] = useState(0);
	const primaryRef = useRef<HTMLButtonElement>(null);
	// Set by a button press; the effect below then moves focus to the new
	// primary button. A ref, so the first render never steals focus.
	const refocus = useRef(false);

	useEffect(() => {
		if (phase !== "running") return;
		const id = setInterval(() => setNow(Date.now()), TICK_MS);
		return () => clearInterval(id);
	}, [phase]);

	// The button that held focus is replaced by a different one on every phase
	// change, so focus follows to the new primary button.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `phase` is the trigger.
	useEffect(() => {
		if (!refocus.current) return;
		refocus.current = false;
		primaryRef.current?.focus();
	}, [phase]);

	const elapsedMs =
		phase === "running"
			? banked + Math.max(0, now - startedAt) * TIMER_DEMO_SPEED
			: banked;
	const band = timerSignal(elapsedMs, MARKS, "speech");
	const qualifying = qualifyingWindowForMarks(MARKS);

	function start() {
		const t = Date.now();
		setStartedAt(t);
		setNow(t);
		setPhase("running");
		refocus.current = true;
	}
	function pause() {
		setBanked(elapsedMs);
		setPhase("paused");
		refocus.current = true;
	}
	function stop() {
		setBanked(elapsedMs);
		setPhase("stopped");
		refocus.current = true;
	}
	function reset() {
		setBanked(0);
		setPhase("idle");
		refocus.current = true;
	}

	const seconds = Math.floor(elapsedMs / 1000);
	const verdict = timingVerdict(
		seconds,
		{ markGreen: MARKS.green, markRed: MARKS.red },
		"speech",
	);
	const text = SCREEN_TEXT_CLASS[band];
	const solid = cn(SCREEN_SOLID_CLASS[band], "min-h-11 flex-1");
	const quiet = cn(SCREEN_QUIET_CLASS, "min-h-11 flex-1");

	return (
		<section
			aria-label="Try it: the Timer's clock"
			className="flex flex-col gap-2"
		>
			<div
				data-band={band}
				className={`flex min-h-[22rem] flex-col items-center justify-center gap-3 rounded-2xl border border-[var(--line)] px-4 py-6 text-center motion-safe:transition-colors motion-safe:duration-300 motion-safe:ease-out ${SCREEN_BG_CLASS[band]} ${text}`}
			>
				<h3 className="font-extrabold text-[11.5px] uppercase tracking-[0.08em] opacity-80">
					Speaker 2 · Priya Nair
				</h3>
				<p
					className={`flex flex-wrap items-center justify-center gap-x-4 gap-y-1 font-medium text-sm tabular-nums ${text}`}
				>
					<span className="inline-flex items-center gap-1.5">
						<MarkDot band={band} className="bg-[#1f7a46]" />
						Green {formatTimingClock(MARKS.green)}
					</span>
					<span className="inline-flex items-center gap-1.5">
						<MarkDot band={band} className="bg-[#f2c230]" />
						Yellow {formatTimingClock(MARKS.yellow)}
					</span>
					<span className="inline-flex items-center gap-1.5">
						<MarkDot band={band} className="bg-[#c0262d]" />
						Red {formatTimingClock(MARKS.red)}
					</span>
					{qualifying ? (
						<span className="opacity-80">Qualifies {qualifying.range}</span>
					) : null}
				</p>
				<div className="flex flex-col items-center gap-1">
					<span className="font-display font-semibold text-6xl tabular-nums leading-none">
						{formatStopwatch(elapsedMs)}
					</span>
					<span className="font-medium text-lg">{TIMER_BAND_LABEL[band]}</span>
				</div>
				<div className="flex w-full max-w-xs flex-wrap justify-center gap-2">
					{phase === "idle" ? (
						<Button ref={primaryRef} className={solid} onClick={start}>
							Start
						</Button>
					) : null}
					{phase === "running" ? (
						<Button ref={primaryRef} className={solid} onClick={pause}>
							Pause
						</Button>
					) : null}
					{phase === "paused" ? (
						<Button ref={primaryRef} className={solid} onClick={start}>
							Resume
						</Button>
					) : null}
					{phase === "running" || phase === "paused" ? (
						<Button variant="outline" className={quiet} onClick={stop}>
							Stop
						</Button>
					) : null}
					{phase === "stopped" ? (
						<Button ref={primaryRef} className={solid} onClick={reset}>
							Reset
						</Button>
					) : null}
				</div>
				<p className="min-h-5 font-medium text-sm">
					{phase === "stopped"
						? `Recorded ${formatElapsedSeconds(seconds)} · ${TIMING_VERDICT_LABEL[verdict]}`
						: null}
				</p>
			</div>
			<p className="text-[var(--sea-ink-soft)] text-xs">
				Running at {TIMER_DEMO_SPEED}× speed, so green arrives in 15 seconds.
			</p>
			{/* Says the band only when it changes, never per tick. */}
			<output aria-live="polite" className="sr-only">
				{phase === "idle" ? "" : TIMER_BAND_LABEL[band]}
			</output>
		</section>
	);
}
