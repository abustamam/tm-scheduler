// @vitest-environment jsdom
/**
 * The digital agenda does not scroll sideways at 375px (#1335, AC 11).
 *
 * jsdom does no layout, so this renders the real `MeetingRunOfShow` in jsdom to
 * get its markup, compiles the app's real Tailwind for exactly those classes,
 * and lays the page out in headless Chrome inside a 375px IFRAME (headless
 * Chrome will not size a window below 500px). Content is deliberately hostile:
 * long unbroken names, a long speech title, a long location and theme, a wide
 * logo, an opened role description, two evaluators, the "You" badge on a
 * long-named row, and a multi-holder templated row.
 *
 * protects=no horizontal scroll on a phone for the run of show;
 * fails_when=any element is wider than the viewport (a fixed width, a
 * `whitespace-nowrap`, an unbroken string with no wrap);
 * no_claim=says nothing about the real router shell around the page; the
 * CONTROL below proves the probe can fail.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/auth-client", () => ({
	authClient: {
		useSession: vi.fn(() => ({
			data: { user: { id: "u1" } },
			isPending: false,
		})),
	},
}));
// The viewer is the long-named Toastmaster, so the "You" badge is drawn on a hostile row.
vi.mock("#/server/ballot-session-voter", () => ({
	getBallotSessionVoter: vi.fn(async () => ({ id: "m-1", name: "viewer" })),
}));

import { type FrameCase, measureInFrames } from "#/test/iframe-batch";
import { buildAppCss, candidatesIn } from "#/test/pinned-column-scroll";
import { CHROME_TEST_TIMEOUT_MS, findChrome } from "#/test/print-page-count";
import {
	MeetingRunOfShow,
	type MeetingRunOfShowProps,
	type RunOfShowSlot,
} from "./meeting-run-of-show";

const hasChrome = findChrome() !== null;
const LONG = "Wolfeschlegelsteinhausenbergerdorff".repeat(2);

function slot(over: Partial<RunOfShowSlot>): RunOfShowSlot {
	return {
		id: "s",
		roleName: "Timer",
		category: "functionary",
		isSpeakerRole: false,
		slotIndex: 0,
		assigneeName: null,
		assigneeId: null,
		speechTitle: null,
		projectLevel: null,
		minMinutes: null,
		maxMinutes: null,
		evaluatesSlotId: null,
		evaluates: null,
		...over,
	};
}

// A wide logo: the page must scale it down to its max width, not overflow.
const WIDE_LOGO = `data:image/svg+xml;utf8,${encodeURIComponent(
	'<svg xmlns="http://www.w3.org/2000/svg" width="900" height="100"><rect width="900" height="100" fill="teal"/></svg>',
)}`;
const MEETING_ID = "22222222-2222-4222-8222-222222222222";

const BASE: MeetingRunOfShowProps = {
	clubParam: "downtown",
	meetingParam: "2026-07-31",
	meeting: {
		id: MEETING_ID,
		scheduledAt: "2026-07-31T18:45:00Z",
		lengthMinutes: 60,
		location: `${LONG} Community Center, Room 4`,
		theme: LONG,
		wordOfTheDay: LONG,
		wodDefinition: "Lasting for a very short time. ".repeat(6),
		wodExample: "The applause was ephemeral. ".repeat(6),
	},
	slots: [],
	timezone: "UTC",
	clubName: `${LONG} Toastmasters`,
	logoUrl: WIDE_LOGO,
	cancelled: false,
	roleDescriptions: {
		speaker: `${LONG} gives a prepared speech. `.repeat(3),
		toastmaster_of_the_day: "Runs the meeting. ".repeat(10),
		contestant: `${LONG} `.repeat(3),
	},
	geIntroducesFunctionaries: false,
	tableTopicsMinSeconds: null,
	tableTopicsMaxSeconds: null,
	template: null,
};

const STANDARD: MeetingRunOfShowProps = {
	...BASE,
	slots: [
		slot({
			id: "tm",
			roleKey: "toastmaster_of_the_day",
			roleName: "Toastmaster of the Day",
			category: "leadership",
			assigneeName: LONG,
			// The viewer: the "You" badge lands on this long-named row.
			assigneeId: "m-1",
		}),
		slot({
			id: "sp",
			roleKey: "speaker",
			roleName: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			assigneeName: "Jagpal",
			assigneeId: "m-2",
			speechTitle: LONG,
			projectLevel: `Level 1 ${LONG}`,
			minMinutes: 5,
			maxMinutes: 7,
		}),
		slot({
			id: "ev",
			roleKey: "evaluator",
			roleName: "Evaluator",
			category: "evaluator",
			assigneeName: LONG,
			assigneeId: "m-3",
			evaluatesSlotId: "sp",
		}),
		slot({
			id: "ev2",
			roleKey: "evaluator",
			roleName: "Evaluator",
			category: "evaluator",
			slotIndex: 1,
			assigneeName: `${LONG}Two`,
			assigneeId: "m-4",
			evaluatesSlotId: "sp",
		}),
		slot({
			id: "ge",
			roleKey: "general_evaluator",
			roleName: "General Evaluator",
		}),
	],
};

const TEMPLATED: MeetingRunOfShowProps = {
	...BASE,
	slots: [0, 1].map((i) =>
		slot({
			id: `c${i}`,
			roleKey: "contestant",
			roleName: "Contestant",
			category: "speaker",
			isSpeakerRole: true,
			slotIndex: i,
			assigneeName: `${LONG}${i}`,
			assigneeId: `m-c${i}`,
		}),
	),
	template: {
		roles: [{ key: "contestant", name: "Contestant", isSpeakerRole: true }],
		beats: [
			{
				id: "b0",
				sortOrder: 0,
				kind: "section",
				label: `${LONG} Contest`,
				detail: null,
				minutes: 0,
				roleKey: null,
				repeatsRoleKey: null,
				flex: false,
				handoff: false,
				markGreen: null,
				markYellow: null,
				markRed: null,
				clubGoverned: false,
			},
			{
				id: "b1",
				sortOrder: 1,
				kind: "role",
				label: `${LONG} speeches`,
				detail: null,
				minutes: 20,
				roleKey: "contestant",
				repeatsRoleKey: null,
				flex: false,
				handoff: false,
				markGreen: null,
				markYellow: null,
				markRed: null,
				clubGoverned: false,
			},
		],
	} as never,
};

/** The page's markup once the viewer's "You" badge has resolved, every
 *  description <details> opened so its body is laid out. */
async function markup(p: MeetingRunOfShowProps): Promise<string> {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const rootRoute = createRootRoute({
		component: () => (
			<QueryClientProvider client={qc}>
				<MeetingRunOfShow {...p} />
			</QueryClientProvider>
		),
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	const { container } = render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
	await screen.findByRole("heading", { level: 1 });
	if (p === STANDARD) await screen.findAllByText("You", {}, { timeout: 5000 });
	const html = container.innerHTML.replaceAll("<details", "<details open");
	cleanup();
	return html;
}

type Frame = {
	who?: string;
	clientWidth: number;
	scrollWidth: number;
	widest: number;
};

const PROBE = `<script>
addEventListener("load", function () {
	var de = document.documentElement, widest = 0;
	document.querySelectorAll("body *").forEach(function (el) {
		var r = el.getBoundingClientRect().right; if (r > widest) { widest = r; window.__w = el.tagName + "." + el.className; }
	});
	parent.postMessage({ id: location.hash.slice(1), frame: {
		clientWidth: de.clientWidth, scrollWidth: de.scrollWidth, widest: widest, who: window.__w
	} }, "*");
});
</script>`;

describe("run of show geometry harness availability", () => {
	it("has a browser to measure with when running in CI", () => {
		if (!process.env.CI) return;
		expect(hasChrome, "CI has no Chrome; the 375px gate would skip.").toBe(
			true,
		);
	});
});

describe.skipIf(!hasChrome)(
	"the digital agenda fits a 375px phone (#1335)",
	{ timeout: CHROME_TEST_TIMEOUT_MS * 2 },
	() => {
		let cache: Map<string, Frame>;
		beforeAll(async () => {
			const standard = await markup(STANDARD);
			const templated = await markup(TEMPLATED);
			// Each fixture is a real run of the thing the test claims to cover.
			expect(standard).toContain("You</span>");
			expect(standard).toContain("<details open");
			expect(standard).toContain("data:image/svg+xml");
			expect(standard).toContain("Evaluated by");
			expect(templated).toContain(`${LONG}0, ${LONG}1`);
			const css = await buildAppCss(candidatesIn(`${standard}${templated}`));
			const doc = (body: string) =>
				`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>${body}</body></html>`;
			const cases: FrameCase[] = [
				{ id: "standard", html: doc(standard), width: 375 },
				{ id: "templated", html: doc(templated), width: 375 },
				// CONTROL 1: a 600px block in flow. scrollWidth must flag it.
				{
					id: "control-scroll",
					html: doc(`${standard}<div style="width:600px;height:10px"></div>`),
					width: 375,
				},
				// CONTROL 2: a 600px block clipped by an overflow:hidden parent. It does
				// not scroll the page, so only the `widest` probe can see it.
				{
					id: "control-widest",
					html: doc(
						`${standard}<div style="overflow:hidden;width:100%"><div style="width:600px;height:10px"></div></div>`,
					),
					width: 375,
				},
			];
			cache = measureInFrames<Frame>(cases, { probe: PROBE, frameHeight: 812 });
		}, CHROME_TEST_TIMEOUT_MS * 2);

		it("CONTROL: a 600px block makes scrollWidth report overflow", () => {
			const f = cache.get("control-scroll");
			expect(f?.scrollWidth).toBeGreaterThan(f?.clientWidth ?? 0);
		});

		it("CONTROL: a clipped 600px block is caught by the widest probe, not by scrollWidth", () => {
			const f = cache.get("control-widest");
			if (!f) throw new Error("no measurement");
			expect(f.scrollWidth).toBeLessThanOrEqual(f.clientWidth);
			expect(f.widest).toBeGreaterThan(f.clientWidth + 1);
		});

		it.each([
			"standard",
			"templated",
		])("no horizontal scroll and no element past the right edge at 375px (%s)", (id) => {
			const f = cache.get(id);
			if (!f) throw new Error("no measurement");
			expect(f.clientWidth).toBeGreaterThan(300);
			expect(f.scrollWidth, f.who).toBeLessThanOrEqual(f.clientWidth);
			expect(f.widest, f.who).toBeLessThanOrEqual(f.clientWidth + 1);
		});
	},
);
