// @vitest-environment jsdom
//
// #1017: tenure on every VPE dashboard row ("11 mo", "1 yr") was counted with
// `new Date()` at render on the runtime's own calendar. Two ways that split
// the SSR pass from the hydration pass, both at a MONTH boundary, which the
// route gate deliberately avoids (it runs mid-month):
//
//   - the clock: SSR at 23:59:59 on Sep 30 in the club's zone and hydration a
//     moment later on Oct 1 count a different number of months;
//   - the zone: at 03:30 UTC on Oct 1 it is October on the server and still
//     Sep 30 in a Los Angeles browser.
//
// The page now counts from the loader's pinned `now`, on the club's calendar.
// Each pass below moves BOTH the process clock (fake `Date`) and the runtime's
// zone (`TZ` for the Date getters, `pinIntlTo` for `Intl`).
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatTenure } from "#/lib/members";
import type { SpeakerRotationRow } from "#/server/reporting-logic";
import {
	hydrateAcrossRuntimes,
	pinIntlTo,
	restoreIntl,
} from "#/test/hydration-across-runtimes";

vi.mock("#/server/reporting", () => ({
	getSpeakerRotation: vi.fn(),
	getOverdueMembers: vi.fn(),
	getAttendanceLapse: vi.fn(),
	getEvaluatorPairings: vi.fn(),
	getLevelProximity: vi.fn(),
}));

// A `Link` needs a router, and `renderToString` cannot wait for one to
// resolve. The rows' hrefs are not what this file is about.
vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		Link: ({
			children,
			className,
		}: {
			children?: React.ReactNode;
			className?: string;
		}) => (
			<a href="#row" className={className}>
				{children}
			</a>
		),
	};
});

import { Route } from "./vpe-dashboard";

const ORIGINAL_TZ = process.env.TZ;

afterEach(() => {
	restoreIntl();
	vi.useRealTimers();
	vi.restoreAllMocks();
	if (ORIGINAL_TZ === undefined) delete process.env.TZ;
	else process.env.TZ = ORIGINAL_TZ;
});

const CLUB_ZONE = "America/Los_Angeles";
/** Mid-October 2025: 11 months to Sep 30 2026, 12 to Oct 1. */
const JOINED = new Date("2025-10-15T18:00:00Z");

const rotation: SpeakerRotationRow = {
	memberId: "33333333-3333-4333-8333-333333333333",
	name: "Sam Speaker",
	clubRole: "member",
	timesSpoken: 1,
	lastSpokenAt: null,
	joinedAt: JOINED,
	latestPathwayPath: null,
	latestProjectName: null,
	latestProjectLevel: null,
};

function runtime(at: string, timeZone: string, locale: string) {
	return () => {
		vi.setSystemTime(new Date(at));
		process.env.TZ = timeZone;
		pinIntlTo(locale, timeZone);
	};
}

/** The route component, its loader stubbed with the instant it pinned. */
function page(loaderNow: number) {
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		rotation: [rotation],
		overdue: [],
		lapse: [],
		pairings: [],
		proximity: [],
		orientation: [],
		timezone: CLUB_ZONE,
		now: loaderNow,
		clubName: "Downtown Club",
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	const Component = Route.options.component as () => React.ReactElement;
	return <Component />;
}

/** What the page did before: the clock read at render. */
function RenderClock() {
	return (
		<span>
			{formatTenure(JOINED, { now: new Date(), timeZone: CLUB_ZONE })}
		</span>
	);
}

describe("VPE dashboard tenure across a month boundary (#1017)", () => {
	// 23:59:59 and 00:00:01 in Los Angeles, either side of the club's midnight.
	const SERVER = runtime("2026-10-01T06:59:59Z", "UTC", "en-US");
	const BROWSER = runtime("2026-10-01T07:00:01Z", CLUB_ZONE, "es-ES");

	it("CONTROL: a clock read at render mismatches across midnight", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		expect(
			hydrateAcrossRuntimes(<RenderClock />, SERVER, BROWSER),
			"the harness no longer reproduces a clock-boundary mismatch",
		).not.toEqual([]);
	});

	it("SSR before midnight, hydration after: one tenure", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const el = page(Date.parse("2026-10-01T06:59:59Z"));
		expect(hydrateAcrossRuntimes(el, SERVER, BROWSER)).toEqual([]);
	});

	it("at 03:30 UTC on the 1st, counts the LA club's month on both passes", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const at = "2026-10-01T03:30:00Z";
		const el = page(Date.parse(at));
		expect(
			hydrateAcrossRuntimes(
				el,
				runtime(at, "UTC", "en-US"),
				runtime(at, CLUB_ZONE, "es-ES"),
			),
		).toEqual([]);
		runtime(at, "UTC", "en-US")();
		const html = renderToString(page(Date.parse(at)));
		expect(html).toContain("11 mo");
		expect(html).not.toContain("1 yr");
	});
});
