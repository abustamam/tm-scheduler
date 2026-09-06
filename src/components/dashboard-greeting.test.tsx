// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	atLocalHour,
	everyHourOfTheDay,
	hydrateAcrossRuntimes,
	serverMarkupAcross,
} from "#/test/hydration-across-runtimes";
import {
	DashboardGreeting,
	greetingPeriod,
	greetingText,
} from "./dashboard-greeting";

// `toFake: ["Date"]` and nothing else — React's scheduler runs on real timers
// and `act` deadlocks if those are faked out from under it. The harness the
// assertions below use is `src/test/hydration-across-runtimes.ts`; its header
// explains why moving the runtime between the two passes is the only way a
// single-process runner can see this bug at all.
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

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
		const recovered = hydrateAcrossRuntimes(
			<LegacyGreeting name="Nina Patel" />,
			() => atLocalHour(3),
			() => atLocalHour(19),
		);
		expect(
			recovered.join("\n"),
			"the harness no longer reproduces #608, so nothing below can fail",
		).toMatch(/hydrat/i);
	});

	it("hydrates clean across the same two clocks", () => {
		const recovered = hydrateAcrossRuntimes(
			<DashboardGreeting name="Nina Patel" />,
			() => atLocalHour(3),
			() => atLocalHour(19),
		);
		expect(recovered).toEqual([]);
	});

	// The invariant, stated directly rather than sampled at two hours: the server
	// pass does not depend on the clock AT ALL. A version that read the hour but
	// happened to agree at 03:00/19:00 — say one bucketing on the club timezone —
	// would pass the test above and fail here.
	it("renders one and the same markup at every hour of the day, server-side", () => {
		const distinct = serverMarkupAcross(everyHourOfTheDay(), () => (
			<DashboardGreeting name="Nina Patel" />
		));
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

	// A plain first-token split, NOT `#/lib/person-name`'s `firstNameOf`, which
	// is the obvious-looking cleanup and is wrong for this field. It reads the
	// first comma as a `Last, First` separator, and the likeliest comma on a
	// display name is a Toastmasters designation — so it greets "DTM" and "ACB".
	// This suite is the only thing standing between that swap and production.
	it.each([
		["Nina Patel, DTM", "Nina"],
		["John Smith, ACB, ALB", "John"],
		["Rasheed Bustamam, DTM, PDG", "Rasheed"],
	])("greets %p by the given name, not the designation", (name, expected) => {
		expect(greetingText(name, 9)).toBe(`Good morning, ${expected}`);
	});

	it("greets a single-token name by that token", () => {
		expect(greetingText("Prince", null)).toBe("Welcome back, Prince");
	});

	// The route passes `authUser.name || authUser.email`, so an account whose
	// name was never filled in greets by the email. Unlovely, unchanged, and
	// pinned so nobody "fixes" it into a blank. (Nothing in `src/` writes
	// `user.name` today — Better-Auth's magic-link plugin stores `name || ""`
	// and neither call site passes one — so this is in fact the path EVERY real
	// user takes. Out of scope here; being filed separately.)
	it("passes an email through as-is", () => {
		expect(greetingText("nina@example.com", 9)).toBe(
			"Good morning, nina@example.com",
		);
	});

	// The `||` arm: a name with no tokens at all keeps its original value rather
	// than greeting nobody.
	it("keeps an untokenizable name rather than greeting nobody", () => {
		expect(greetingText("   ", null)).toBe("Welcome back,    ");
	});
});
