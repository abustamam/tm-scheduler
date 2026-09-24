import { useState } from "react";

/**
 * Scene 4 of `/tour` (#867), left half: the timing light. Each tap moves it
 * green → yellow → red → off, the order a Timer raises the cards in.
 *
 * The caption names the colour in words on every state, so the demo does not
 * depend on telling the three fills apart. Fills are theme tokens: the green
 * and yellow pairs `meeting-timer.tsx` uses, and the destructive fill with the
 * white-text recipe `season-grid.tsx` uses (and styles.css measures) for red.
 */
export const TIMER_STATES = ["off", "green", "yellow", "red"] as const;
export type TimerState = (typeof TIMER_STATES)[number];

const FILL: Record<TimerState, string> = {
	off: "bg-muted text-muted-foreground",
	green: "bg-success text-success-foreground",
	yellow: "bg-warning-strong text-on-accent-fill",
	red: "bg-destructive text-white dark:bg-destructive/60",
};

const CAPTION: Record<TimerState, string> = {
	off: "Off. Tap to show green.",
	green: "Green: minimum time reached.",
	yellow: "Yellow: time to start wrapping up.",
	red: "Red: that's the limit.",
};

export function TimerDemo() {
	const [i, setI] = useState(0);
	const state = TIMER_STATES[i];

	return (
		<section
			aria-label="Try it: the Timer's timing light"
			className="flex flex-col gap-3"
		>
			<button
				type="button"
				onClick={() => setI((n) => (n + 1) % TIMER_STATES.length)}
				data-state={state}
				className={`flex aspect-[4/3] w-full cursor-pointer flex-col items-center justify-center gap-1 rounded-2xl border border-[var(--line)] ${FILL[state]} motion-safe:transition-colors motion-safe:duration-200 motion-safe:ease-out`}
			>
				<span className="font-extrabold text-[11.5px] uppercase tracking-[0.08em] opacity-80">
					Speaker 2 · 5–7 min
				</span>
				<span className="font-display font-semibold text-3xl capitalize">
					{state}
				</span>
				<span className="sr-only">Tap to change the light.</span>
			</button>
			<p aria-live="polite" className="text-sm text-[var(--sea-ink-soft)]">
				{CAPTION[state]}
			</p>
		</section>
	);
}
