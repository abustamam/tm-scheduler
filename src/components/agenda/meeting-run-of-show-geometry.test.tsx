// @vitest-environment jsdom
/**
 * The digital agenda does not scroll sideways at 375px (#1335, AC 11).
 *
 * jsdom does no layout, so this renders the real `MeetingRunOfShow` in jsdom to
 * get its markup, compiles the app's real Tailwind for exactly those classes,
 * and lays the page out in headless Chrome inside a 375px IFRAME (headless
 * Chrome will not size a window below 500px). Content is deliberately hostile:
 * long unbroken names, a long speech title, a long location and theme.
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
	authClient: { useSession: vi.fn(() => ({ data: null, isPending: false })) },
}));
vi.mock("#/server/ballot-session-voter", () => ({
	getBallotSessionVoter: vi.fn(),
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

const PROPS: MeetingRunOfShowProps = {
	clubParam: "downtown",
	meetingParam: "2026-07-31",
	meeting: {
		id: "22222222-2222-4222-8222-222222222222",
		scheduledAt: "2026-07-31T18:45:00Z",
		lengthMinutes: 60,
		location: `${LONG} Community Center, Room 4`,
		theme: LONG,
		wordOfTheDay: LONG,
		wodDefinition: "Lasting for a very short time. ".repeat(6),
		wodExample: "The applause was ephemeral. ".repeat(6),
	},
	slots: [
		slot({
			id: "tm",
			roleKey: "toastmaster_of_the_day",
			roleName: "Toastmaster of the Day",
			category: "leadership",
			assigneeName: LONG,
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
			assigneeName: "Sudheer",
			assigneeId: "m-3",
			evaluatesSlotId: "sp",
		}),
		slot({
			id: "ge",
			roleKey: "general_evaluator",
			roleName: "General Evaluator",
		}),
	],
	timezone: "UTC",
	clubName: `${LONG} Toastmasters`,
	logoUrl: null,
	cancelled: false,
	roleDescriptions: {},
	geIntroducesFunctionaries: false,
	tableTopicsMinSeconds: null,
	tableTopicsMaxSeconds: null,
	template: null,
};

async function markup(): Promise<string> {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const rootRoute = createRootRoute({
		component: () => (
			<QueryClientProvider client={qc}>
				<MeetingRunOfShow {...PROPS} />
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
	const html = container.innerHTML;
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
			const html = await markup();
			const css = await buildAppCss(candidatesIn(html));
			const doc = (body: string, extra = "") =>
				`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}${extra}</style></head><body>${body}</body></html>`;
			const cases: FrameCase[] = [
				{ id: "page", html: doc(html), width: 375 },
				// CONTROL: the same page plus a 600px-wide block. The probe must flag it.
				{
					id: "control",
					html: doc(`${html}<div style="width:600px;height:10px"></div>`),
					width: 375,
				},
			];
			cache = measureInFrames<Frame>(cases, { probe: PROBE, frameHeight: 812 });
		}, CHROME_TEST_TIMEOUT_MS * 2);

		it("CONTROL: a 600px block makes the probe report overflow", () => {
			const f = cache.get("control");
			expect(f?.scrollWidth).toBeGreaterThan(f?.clientWidth ?? 0);
		});

		it("no horizontal scroll and no element past the right edge at 375px", () => {
			const f = cache.get("page");
			if (!f) throw new Error("no measurement");
			expect(f.clientWidth).toBeGreaterThan(300);
			expect(f.scrollWidth, f.who).toBeLessThanOrEqual(f.clientWidth);
			expect(f.widest).toBeLessThanOrEqual(f.clientWidth + 1);
		});
	},
);
