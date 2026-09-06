// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DashboardGreeting,
	greetingPeriod,
	greetingText,
} from "./dashboard-greeting";

/**
 * #608's defect cannot reproduce in the way it reaches production. There the
 * two disagreeing renders happen in two PROCESSES in two timezones — a UTC
 * container and a browser in Los Angeles — and vitest has one process and one
 * timezone, which is exactly why the 4,780-test suite was structurally blind
 * to it and why local QA could not see it either.
 *
 * So drive the narrow interface the bug actually reads instead of trying to
 * reproduce its trigger: the disagreement is not really about timezones, it is
 * about the two passes calling `new Date().getHours()` and getting different
 * answers. Move the clock BETWEEN the server render and the hydration and the
 * same disagreement appears in one process, in any timezone, on any machine.
 *
 * `toFake: ["Date"]` and nothing else — React's scheduler runs on real timers
 * and `act` deadlocks if those are faked out from under it.
 */
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	// `act` outside @testing-library/react's own `render` needs this set; RTL
	// sets it for its calls only.
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/**
 * Put the process clock at a chosen LOCAL hour. The multi-argument `Date`
 * constructor builds a local time, so `getHours()` answers `hour` whatever
 * `TZ` the runner happens to have — which keeps this suite honest on a
 * developer's machine and on CI's UTC runner alike.
 */
function atLocalHour(hour: number) {
	vi.setSystemTime(new Date(2026, 7, 20, hour, 30, 0));
}

/**
 * Renders `element` the way the two runtimes actually run it: `renderToString`
 * with the clock at `serverHour`, then `hydrateRoot` over that markup with the
 * clock at `clientHour`. Returns whatever React reported as recoverable.
 *
 * A hydration mismatch surfaces through `onRecoverableError` and essentially
 * nowhere else a test can reach: React recovers by throwing the server markup
 * away and re-rendering on the client, so by the time any DOM assertion runs
 * the text is CORRECT and the bug has already happened. Asserting on the
 * rendered output would pass on the broken version.
 *
 * `console.error` is silenced because React prints the mismatch diff there too;
 * the assertion reads the structured channel, so the noise is pure output cost.
 */
function hydrateAcrossClocks(
	element: ReactElement,
	serverHour: number,
	clientHour: number,
): string[] {
	atLocalHour(serverHour);
	const html = renderToString(element);

	const container = document.createElement("div");
	container.innerHTML = html;
	document.body.appendChild(container);

	atLocalHour(clientHour);
	const recovered: string[] = [];
	vi.spyOn(console, "error").mockImplementation(() => {});
	let root: ReturnType<typeof hydrateRoot> | undefined;
	act(() => {
		root = hydrateRoot(container, element, {
			onRecoverableError: (error) => recovered.push(String(error)),
		});
	});
	act(() => root?.unmount());
	container.remove();
	return recovered;
}

/**
 * The shipped code as it stood before this change, kept as the harness's own
 * control.
 *
 * Without it the suite below is unfalsifiable: every assertion would pass just
 * as happily against a harness that had quietly stopped reporting (a React
 * release that routes mismatches elsewhere, a fake-timer option that stops
 * reaching `renderToString`, an `act` that swallows the error). This asserts
 * the harness still SEES the bug, so the tests next to it are able to fail.
 */
function LegacyGreeting({ name }: { name: string }) {
	const h = new Date().getHours();
	const period = h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
	const first = name.trim().split(/\s+/)[0] || name;
	return <h1>{`Good ${period}, ${first}`}</h1>;
}

describe("DashboardGreeting hydration (#608)", () => {
	// 03:00 and 19:00 are the concrete production case: a Los Angeles member
	// loading the page at 19:00 local is 03:00 the next day in the UTC container
	// Railway runs, so the server said "morning" and the browser said "evening".
	it("CONTROL: the pre-#608 greeting mismatches when the two passes disagree on the hour", () => {
		const recovered = hydrateAcrossClocks(
			<LegacyGreeting name="Nina Patel" />,
			3,
			19,
		);
		expect(
			recovered.join("\n"),
			"the harness no longer reproduces #608, so nothing below can fail",
		).toMatch(/hydrat/i);
	});

	it("hydrates clean across the same two clocks", () => {
		const recovered = hydrateAcrossClocks(
			<DashboardGreeting name="Nina Patel" />,
			3,
			19,
		);
		expect(recovered).toEqual([]);
	});

	// The invariant, stated directly rather than sampled at two hours: the server
	// pass does not depend on the clock AT ALL. A version that read the hour but
	// happened to agree at 03:00/19:00 — say one bucketing on the club timezone —
	// would pass the test above and fail here.
	it("renders one and the same markup at every hour of the day, server-side", () => {
		const distinct = new Set<string>();
		for (let hour = 0; hour < 24; hour++) {
			atLocalHour(hour);
			distinct.add(renderToString(<DashboardGreeting name="Nina Patel" />));
		}
		expect(distinct.size).toBe(1);
		expect([...distinct][0]).toContain("Welcome back, Nina");
	});

	it("says nothing about the time of day before mount", () => {
		atLocalHour(19);
		const html = renderToString(<DashboardGreeting name="Nina Patel" />);
		// The point of the neutral first paint: a viewer on a slow connection reads
		// a greeting that is generic, never one that is WRONG.
		expect(html).not.toMatch(/morning|afternoon|evening/);
	});

	it("switches to the viewer's own time of day once mounted", () => {
		atLocalHour(19);
		render(<DashboardGreeting name="Nina Patel" />);
		// RTL's `render` flushes the mount effect, so this is the post-hydration
		// state — the one the user actually ends up looking at.
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"Good evening, Nina",
		);
	});

	it("keeps the greeting in the H1 the page's wayfinding depends on", () => {
		atLocalHour(9);
		render(<DashboardGreeting name="Nina Patel" />);
		const h1 = screen.getByRole("heading", { level: 1 });
		expect(h1.textContent).toBe("Good morning, Nina");
		// The display treatment moved out of the route with the markup; a dropped
		// class here is a silent typographic regression on the landing page.
		expect(h1.className).toContain("font-display");
		expect(h1.className).toContain("text-3xl");
	});
});

describe("greetingPeriod", () => {
	// Both edges of both boundaries. `hour < 12` and `hour < 18` are the whole
	// function, so an off-by-one is the only way it can be wrong.
	it.each([
		[0, "morning"],
		[11, "morning"],
		[12, "afternoon"],
		[17, "afternoon"],
		[18, "evening"],
		[23, "evening"],
	])("reads hour %i as %s", (hour, period) => {
		expect(greetingPeriod(hour)).toBe(period);
	});
});

describe("greetingText", () => {
	it("greets by the time of day when it has been given an hour", () => {
		expect(greetingText("Nina Patel", 9)).toBe("Good morning, Nina");
		expect(greetingText("Nina Patel", 13)).toBe("Good afternoon, Nina");
		expect(greetingText("Nina Patel", 21)).toBe("Good evening, Nina");
	});

	it("falls back to a time-neutral greeting with no hour", () => {
		expect(greetingText("Nina Patel", null)).toBe("Welcome back, Nina");
	});

	// `firstNameOf` rather than a whitespace split. The Toastmasters membership
	// export emits this shape (see `members-csv.test.ts`), and the split the
	// route used to carry would have put "Khan," in the H1 — the member's family
	// name, with the comma.
	it("reads the given name out of a 'Last, First' stored name", () => {
		expect(greetingText("Khan, Zabihullah", 9)).toBe(
			"Good morning, Zabihullah",
		);
	});

	it("greets a single-token name by that token", () => {
		expect(greetingText("Prince", null)).toBe("Welcome back, Prince");
	});

	// The route passes `authUser.name || authUser.email`, so an account whose
	// name was never filled in greets by the email. Unlovely, unchanged, and
	// pinned so nobody "fixes" it into a blank.
	it("passes an email through as-is", () => {
		expect(greetingText("nina@example.com", 9)).toBe(
			"Good morning, nina@example.com",
		);
	});

	// `firstNameOf` returns "" for a name with no tokens at all, and a greeting
	// that trails off after the comma is worse than one that reads oddly. This is
	// the `||` arm.
	it("keeps an untokenizable name rather than greeting nobody", () => {
		expect(greetingText("   ", null)).toBe("Welcome back,    ");
	});
});
