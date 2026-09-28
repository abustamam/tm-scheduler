// @vitest-environment jsdom
//
// #1000: `/admin/vpe-dashboard` threw React #418 on every direct load in
// production. Four dates on the page were formatted with no zone, so each pass
// printed the day in ITS OWN runtime's zone: "Jul 18" from Railway's UTC
// container, "Jul 17" in a browser in Los Angeles, for a meeting held on the
// evening of the 17th in the club's own zone. React threw the server markup
// away and re-rendered the whole route on the client.
//
// The four sites, each its own case below because React stops at the FIRST
// text node that disagrees, so one test over the whole page would only ever
// see whichever site renders first and would stay green with the other three
// broken:
//
//   - Stopped attending: "last seen <day>"      (LapseRow)
//   - Overdue for a role: "last: <day>"         (OverdueRow)
//   - Speaker queue: the last-spoken day        (RotationRow)
//   - Evaluator pairings: each chip's day       (PairingChip)
//
// Every one now takes the club's zone from the loader, like the Booked and
// Speaking markers beside them already did (#898). The runtime is shifted
// between the two passes with `pinIntlTo`, which is the seam these formatters
// read: `timeZone` omitted resolves to the runtime's zone. See
// `src/test/hydration-across-runtimes.ts`.
//
// Tenure is deliberately kept out of it (`joinedAt: null`): `formatTenure`
// reads the process clock and the runtime's local calendar, which this harness
// does not move, and it is not one of the four.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttendanceLapseRow } from "#/lib/attendance-lapse";
import type { EvaluatorPairingRow } from "#/lib/evaluator-pairing";
import type {
	OverdueMemberRow,
	SpeakerRotationRow,
} from "#/server/reporting-logic";
import {
	assortedIntlRuntimes,
	hydrateAcrossRuntimes,
	pinIntlTo,
	restoreIntl,
	serverMarkupAcross,
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

afterEach(() => {
	restoreIntl();
	vi.restoreAllMocks();
});

const CLUB_ZONE = "America/Chicago";

/**
 * 02:00 UTC on Jul 18 is 21:00 on Jul 17 in the club's zone, which is when the
 * meeting was. The UTC day and the club's day differ, so a render in the
 * wrong zone prints a different day and not merely a different hour.
 */
const EVENING = new Date("2026-07-18T02:00:00.000Z");

const SERVER = () => pinIntlTo("en-US", "UTC");
const BROWSER = () => pinIntlTo("es-ES", "America/Los_Angeles");

const lapse: AttendanceLapseRow = {
	memberId: "11111111-1111-4111-8111-111111111111",
	name: "Dana Drift",
	joinedAt: null,
	streak: 4,
	presentCount: 2,
	eligibleCount: 8,
	rate: 0.25,
	lastSeenAt: EVENING,
	isLapsed: true,
};

const overdue: OverdueMemberRow = {
	memberId: "22222222-2222-4222-8222-222222222222",
	name: "Omar Overdue",
	clubRole: "member",
	joinedAt: null,
	lastAnyRoleAt: EVENING,
	daysSinceLastRole: 71,
	isOverdue: true,
};

const rotation: SpeakerRotationRow = {
	memberId: "33333333-3333-4333-8333-333333333333",
	name: "Sam Speaker",
	clubRole: "member",
	timesSpoken: 1,
	lastSpokenAt: EVENING,
	joinedAt: null,
	latestPathwayPath: null,
	latestProjectName: null,
	latestProjectLevel: null,
};

const pairing: EvaluatorPairingRow = {
	memberId: "44444444-4444-4444-8444-444444444444",
	name: "Pat Paired",
	joinedAt: null,
	recent: [
		{
			evaluatorKey: "55555555-5555-4555-8555-555555555555",
			evaluatorName: "Eve Evaluator",
			isGuest: false,
			meetingId: "66666666-6666-4666-8666-666666666666",
			scheduledAt: EVENING,
			repeat: false,
		},
	],
	distinctEvaluators: 1,
	hasRepeat: false,
};

interface Sections {
	lapse?: AttendanceLapseRow[];
	overdue?: OverdueMemberRow[];
	rotation?: SpeakerRotationRow[];
	pairings?: EvaluatorPairingRow[];
}

const ALL: Sections = {
	lapse: [lapse],
	overdue: [overdue],
	rotation: [rotation],
	pairings: [pairing],
};

/** The route component with its loader stubbed to `sections`. */
function page(sections: Sections, timezone: string | undefined) {
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		rotation: sections.rotation ?? [],
		overdue: sections.overdue ?? [],
		lapse: sections.lapse ?? [],
		pairings: sections.pairings ?? [],
		proximity: [],
		timezone,
		clubName: "Downtown Club",
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	const Component = Route.options.component as () => React.ReactElement;
	return <Component />;
}

describe("the VPE dashboard hydrates under a shifted runtime (#1000)", () => {
	it("CONTROL: with no zone to format in, the same page mismatches", () => {
		// What every one of the four sites did before #1000. If the harness
		// stopped reporting, this goes green along with the cases below.
		const recovered = hydrateAcrossRuntimes(
			page(ALL, undefined),
			SERVER,
			BROWSER,
		);
		expect(
			recovered.join("\n"),
			"the harness no longer reproduces a zone-only mismatch on this page",
		).toMatch(/hydrat/i);
	});

	it.each<[string, Sections]>([
		["Stopped attending: last seen", { lapse: [lapse] }],
		["Overdue for a role: last role", { overdue: [overdue] }],
		["Speaker queue: last spoken", { rotation: [rotation] }],
		["Evaluator pairings: the chip's day", { pairings: [pairing] }],
	])("%s", (_site, sections) => {
		expect(
			hydrateAcrossRuntimes(page(sections, CLUB_ZONE), SERVER, BROWSER),
		).toEqual([]);
	});

	it("prints the club's day, the same under every runtime", () => {
		const distinct = serverMarkupAcross(assortedIntlRuntimes(), () =>
			page(ALL, CLUB_ZONE),
		);
		expect(distinct.size).toBe(1);
		const [html] = [...distinct];
		// Four sites, all on the 17th: the evening the meeting was held in
		// Chicago, not the UTC date the server would otherwise print.
		expect(html.match(/Jul 17/g)).toHaveLength(4);
		expect(html).not.toMatch(/Jul 18/);
	});
});
