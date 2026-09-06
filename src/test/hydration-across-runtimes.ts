import type { ReactElement } from "react";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { vi } from "vitest";

/**
 * A harness for the class of bug #608 records: a render that consults the
 * RUNTIME — its clock, its timezone, its locale — and therefore answers one
 * thing on the server and another in the browser.
 *
 * It cannot reproduce that the way it reaches production. There the two
 * disagreeing renders happen in two PROCESSES with two runtimes — a UTC
 * container on Railway and a browser in Los Angeles reading Spanish — and
 * vitest has one process and one runtime. That is exactly why a 6,000-test
 * suite was structurally blind to it, and why local QA could not see it either:
 * on a dev machine both halves agree and the page hydrates clean.
 *
 * So drive the narrow interface the code actually reads instead of chasing the
 * trigger. Change the runtime BETWEEN the server render and the hydration and
 * the same disagreement appears in one process, on any machine. #608 turned out
 * to have two such interfaces on one route, and they are NOT the same seam:
 *
 *   - the greeting read the CLOCK (`new Date().getHours()`), so `atLocalHour`
 *     moves it;
 *   - the speech-log date read what the runtime resolves an `undefined` locale
 *     and timezone TO (`new Intl.DateTimeFormat(undefined, …)` over a fixed
 *     instant), which no amount of clock movement can shift — so `pinIntlTo`
 *     replaces that resolution instead.
 *
 * Generalise the shape, not the trick (the same move `dialog-keyboard-reach.ts`
 * makes for a soft keyboard headless Chrome cannot raise): when the runtime
 * cannot produce the input, find the narrow interface the code reads and drive
 * THAT.
 *
 * Every suite using this must carry a PRE-FIX CONTROL — the code as it stood,
 * asserted to still produce a mismatch here. Without one the assertions beside
 * it are unfalsifiable: they pass just as happily against a harness that has
 * quietly stopped reporting (a React release routing mismatches elsewhere, a
 * fake-timer option that stops reaching `renderToString`, an `act` that
 * swallows the error).
 */

/**
 * Put the process clock at a chosen LOCAL hour. Requires the caller to have
 * installed `vi.useFakeTimers({ toFake: ["Date"] })` — and `["Date"]` alone,
 * because React's scheduler runs on real timers and `act` deadlocks if those
 * are faked out from under it.
 *
 * The multi-argument `Date` constructor builds a LOCAL time, so `getHours()`
 * answers `hour` whatever `TZ` the runner happens to have. That keeps a suite
 * using this honest on a developer's machine and on CI's runner alike.
 */
export function atLocalHour(hour: number, day = 20) {
	vi.setSystemTime(new Date(2026, 7, day, hour, 30, 0));
}

const RealDateTimeFormat = Intl.DateTimeFormat;
let forcedLocale = "en-US";
let forcedTimeZone = "UTC";

/**
 * Make the runtime resolve an omitted locale and timezone to a chosen pair.
 *
 * This is the seam a date formatter actually reads: `Intl.DateTimeFormat`'s
 * first argument and its `timeZone` option BOTH fall back to the runtime, so a
 * `(undefined, { day: "numeric" })` call answers one thing in a UTC container
 * and another in a browser — differing on the day number across a date
 * boundary, and on the month's spelling in any non-English locale. Neither is
 * reachable by moving the clock: the instant being formatted is fixed.
 *
 * A CLASS, not a function expression: this double is invoked with `new`, and
 * Biome's `useArrowFunction` silently rewrites a function expression into an
 * arrow — which is not a constructor, so `new` throws, lands in whatever
 * `catch` is nearby, and the test passes for the wrong reason. That has already
 * happened once in this repo. Subclassing rather than reimplementing also keeps
 * `formatToParts`, `resolvedOptions` and the rest real.
 *
 * Call `restoreIntl()` in `afterEach`.
 */
export function pinIntlTo(locale: string, timeZone: string) {
	forcedLocale = locale;
	forcedTimeZone = timeZone;
	if (Intl.DateTimeFormat !== RealDateTimeFormat) return;
	class PinnedDateTimeFormat extends RealDateTimeFormat {
		constructor(
			locales?: Intl.LocalesArgument,
			options?: Intl.DateTimeFormatOptions,
		) {
			super(locales ?? forcedLocale, {
				...options,
				timeZone: options?.timeZone ?? forcedTimeZone,
			});
		}
	}
	Intl.DateTimeFormat =
		PinnedDateTimeFormat as unknown as typeof Intl.DateTimeFormat;
}

/** Undo `pinIntlTo`. Safe to call when nothing was pinned. */
export function restoreIntl() {
	Intl.DateTimeFormat = RealDateTimeFormat;
}

/**
 * Render `element` the way the two runtimes actually run it: `renderToString`
 * under `serverRuntime`, then `hydrateRoot` over that markup under
 * `clientRuntime`. Returns whatever React reported as recoverable.
 *
 * A hydration mismatch surfaces through `onRecoverableError` and essentially
 * nowhere else a test can reach. React recovers by throwing the server markup
 * away and re-rendering on the client, so by the time any DOM assertion runs
 * the text is CORRECT and the bug has already happened — asserting on rendered
 * output would pass on the broken version.
 *
 * `console.error` is silenced around the hydration because React prints the
 * mismatch diff there too, and the assertion reads the structured channel.
 * Saved and restored by hand rather than through `vi.spyOn` so it cannot leak
 * into a suite whose `afterEach` does not restore mocks.
 */
export function hydrateAcrossRuntimes(
	element: ReactElement,
	serverRuntime: () => void,
	clientRuntime: () => void,
): string[] {
	serverRuntime();
	const html = renderToString(element);

	const container = document.createElement("div");
	container.innerHTML = html;
	document.body.appendChild(container);

	clientRuntime();
	const recovered: string[] = [];

	// `act` outside @testing-library/react's own `render` needs this set; RTL
	// sets it around its own calls only.
	const globals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
	const priorActEnv = globals.IS_REACT_ACT_ENVIRONMENT;
	globals.IS_REACT_ACT_ENVIRONMENT = true;
	const priorConsoleError = console.error;
	console.error = () => {};

	try {
		let root: ReturnType<typeof hydrateRoot> | undefined;
		act(() => {
			root = hydrateRoot(container, element, {
				onRecoverableError: (error) => recovered.push(String(error)),
			});
		});
		act(() => root?.unmount());
	} finally {
		console.error = priorConsoleError;
		globals.IS_REACT_ACT_ENVIRONMENT = priorActEnv;
		container.remove();
	}

	return recovered;
}

/**
 * The distinct markup the SERVER emits across a set of runtimes.
 *
 * Separate from the hydration check because the two answer different questions:
 * hydration proves the two passes AGREE at one sampled pair, this proves the
 * server pass does not consult the runtime at all. A render that bucketed on,
 * say, a stored club timezone could agree at one sampled pair and still vary —
 * sweeping the space is what tells them apart. A size of 1 is the invariant.
 */
export function serverMarkupAcross(
	runtimes: Array<() => void>,
	render: () => ReactElement,
): Set<string> {
	const distinct = new Set<string>();
	for (const runtime of runtimes) {
		runtime();
		distinct.add(renderToString(render()));
	}
	return distinct;
}

/** Every hour of one local day, as runtimes for `serverMarkupAcross`. */
export function everyHourOfTheDay(day = 20): Array<() => void> {
	return Array.from({ length: 24 }, (_, hour) => () => atLocalHour(hour, day));
}

/**
 * A spread of locale/timezone pairs wide enough to move both halves of a date:
 * the day number (either side of a date boundary) and the month's spelling.
 */
export function assortedIntlRuntimes(): Array<() => void> {
	return (
		[
			["en-US", "UTC"],
			["en-US", "America/Los_Angeles"],
			["es-ES", "America/Los_Angeles"],
			["ja-JP", "Asia/Tokyo"],
			["de-DE", "Europe/Berlin"],
			["en-AU", "Australia/Sydney"],
		] as const
	).map(
		([locale, timeZone]) =>
			() =>
				pinIntlTo(locale, timeZone),
	);
}
