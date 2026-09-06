import { useEffect, useState } from "react";

/**
 * The date stamp on a dashboard speech-log row (#608).
 *
 * Same defect as the greeting beside it, ~90 lines down the same route and
 * missed on the first pass. `dayMon` called `new Intl.DateTimeFormat(undefined,
 * …)` during render, and BOTH of those arguments resolve against the runtime:
 *
 *   - the timezone, so a Los Angeles member's 19:00 Aug 20 speech printed
 *     `21 AUG` in the UTC container and `20 AUG` in their browser;
 *   - the locale, so a Spanish-locale browser printed `AGO` against the
 *     server's `AUG` — a mismatch even for a member sitting in UTC.
 *
 * Both were measured, and either one alone is enough to make React throw the
 * server markup away.
 */

/** Day-of-month and short month, in the RUNTIME's zone and locale. */
function dayMon(value: Date | string) {
	const d = new Date(value);
	return {
		day: new Intl.DateTimeFormat(undefined, { day: "numeric" }).format(d),
		mon: new Intl.DateTimeFormat(undefined, { month: "short" })
			.format(d)
			.toUpperCase(),
	};
}

/**
 * The box the date sits in, empty. Non-breaking spaces rather than empty
 * strings so the two lines keep their height and the 64px grid column does not
 * collapse and reflow the row when the real date lands.
 */
const BLANK = "\u00A0";

export function SpeechLogDate({ value }: { value: Date | string }) {
	// Same pre-mount guard as `DashboardGreeting`. The server pass and every
	// first client render see `mounted === false`, so both emit the empty box and
	// hydration has nothing to reconcile; the effect then fills it in from the
	// viewer's own runtime.
	//
	// The POST-mount output is byte-identical to what this route shipped before:
	// the viewer's zone and locale are what the browser was already resolving to.
	// Only the server pass changes, and it changes from "a guess that is wrong
	// for most of the planet" to "nothing".
	//
	// Blank rather than a placeholder date, which is the other way to make the
	// two passes agree. UTC is not neutral for an INSTANT the way it is for the
	// stored calendar day `formatCalendarDay` pins: rendering `21 AUG` and then
	// correcting it to `20 AUG` shows a concrete, authoritative, wrong date
	// first. #608 chose the generic-but-never-wrong first paint for the greeting
	// and this follows it.
	//
	// And deliberately NOT `suppressHydrationWarning`, which is React's
	// documented escape hatch for timestamps and looks like a one-word fix here.
	// It suppresses the WARNING without repairing the mismatch: React keeps the
	// SERVER's text for a suppressed text node and does not re-render it, so the
	// member would be left looking at the UTC date until something unrelated
	// re-rendered the row. That satisfies the letter of "no hydration mismatch is
	// logged" by making the data silently wrong, which is worse than the bug.
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	const parts = mounted ? dayMon(value) : null;

	return (
		<div className="text-center leading-[1.1]">
			<div className="font-display text-lg font-semibold">
				{parts ? parts.day : BLANK}
			</div>
			<div className="text-xs font-bold tracking-[0.05em] text-[var(--sea-ink-soft)]">
				{parts ? parts.mon : BLANK}
			</div>
		</div>
	);
}
