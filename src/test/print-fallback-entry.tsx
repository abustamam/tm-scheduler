/**
 * The browser half of `print-fallback.test.tsx` (#1225): mounts the print
 * route's real `PrintAgendaView` in a CLIENT React root, in headless Chrome, so
 * `FitPage`'s measuring effect really runs (after fonts load) and its
 * scale-or-flow decision really happens. `renderToStaticMarkup` never runs that
 * effect, which is how #1179 passed and #1181 shipped.
 *
 * Bundled by `client-bundle-chrome.ts`; not a test file. Reads its scenarios
 * from `window.__INPUT__` and reports a snapshot after every step.
 */
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
	useSearch,
} from "@tanstack/react-router";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	type AgendaLayout,
	MeetingAgendaPrint,
} from "#/components/agenda/meeting-agenda-print";
import { AGENDA_LAYOUT_LABELS } from "#/lib/agenda-layouts";
import { PrintAgendaView } from "#/routes/club.$clubId_.meeting.$meetingId.print";
import {
	MCF_EXPLAINERS,
	MCF_HEADER,
	MCF_OFFICERS,
	MCF_ROLES,
	MCF_ROWS,
} from "#/test/mcf-agenda-fixture";
import { printCompactAgenda } from "#/test/print-compact-fixtures";
import {
	THR_EXPLAINERS,
	THR_HEADER,
	THR_OFFICERS,
	thrAgenda,
	thrAgendaLong,
} from "#/test/thr-agenda-fixture";

export type FixtureId = "thr" | "thrLong" | "mcf" | `contestDense${number}`;

export type Step =
	| { kind: "tab"; layout: AgendaLayout }
	| { kind: "fixture"; fixture: FixtureId };

/** The URL's query, as the print route parses it. */
export type ScenarioSearch = {
	layout: AgendaLayout;
	copies?: number;
	duplex?: 1;
	chrome?: "none";
};

export type Scenario = {
	id: string;
	fixture: FixtureId;
	search: ScenarioSearch;
	/** `bare` renders `MeetingAgendaPrint` alone, with no view and no fallback: the
	 *  control that shows what the same agenda did before this change. */
	mode: "view" | "bare";
	steps: Step[];
};

export type Snapshot = {
	step: string;
	/** Every `.agenda-page` that is not a blank duplex filler, by `offsetHeight`. */
	pages: number[];
	/** The same sheets' natural height, `[data-fit-inner].scrollHeight`: what
	 *  `FitPage` weighs against the flow cliff. */
	natural: number[];
	blanks: number;
	/** "Run of Show — Detailed Timing" is on Timing's page 2 and on no other layout. */
	timing: boolean;
	notice: string | null;
	/** The tab drawn as active (the layout the person picked), or null in `bare`. */
	activeTab: string | null;
	/** `FitPage` measurements (reads of a sheet's `[data-fit-inner].scrollHeight`)
	 *  since the last snapshot, by the layout the measured sheet belongs to. */
	reads: Partial<Record<AgendaLayout, number>>;
};

declare global {
	interface Window {
		__INPUT__: { scenarios: Scenario[] };
		__report: (v: unknown) => void;
		__setFixture?: (f: FixtureId) => void;
	}
}

const GUESTS = { veena: "Guest", david: "Guest" };

const STATIC_FIXTURES = {
	thr: (() => {
		const { roles, rows } = thrAgenda(GUESTS);
		return {
			header: THR_HEADER,
			roles,
			officers: THR_OFFICERS,
			explainers: THR_EXPLAINERS,
			rows,
		};
	})(),
	thrLong: (() => {
		const { header, roles, rows } = thrAgendaLong(GUESTS);
		return {
			header,
			roles,
			officers: THR_OFFICERS,
			explainers: THR_EXPLAINERS,
			rows,
		};
	})(),
	mcf: {
		header: MCF_HEADER,
		roles: MCF_ROLES,
		officers: MCF_OFFICERS,
		explainers: MCF_EXPLAINERS,
		rows: MCF_ROWS,
	},
};

type Fixture = (typeof STATIC_FIXTURES)[keyof typeof STATIC_FIXTURES];

/** `contestDenseN` is the seeded speech-contest template at N contestants with
 *  long member names (`print-compact-fixtures.ts`); any N works. */
const dense = new Map<FixtureId, Fixture>();
const fixtureOf = (id: FixtureId): Fixture => {
	if (!id.startsWith("contestDense"))
		return STATIC_FIXTURES[id as keyof typeof STATIC_FIXTURES];
	// Cached: the route's reset effect is keyed on the rows' identity, so a fresh
	// array on every render would reset it forever.
	let f = dense.get(id);
	if (!f) {
		f = {
			...printCompactAgenda(id as `contestDense${number}`),
			explainers: [],
		};
		dense.set(id, f);
	}
	return f;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Long enough for the font wait, the measurement, the state change it causes
 *  and the re-render, all of which are separate turns of the event loop. */
async function settle() {
	const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } })
		.fonts;
	for (let i = 0; i < 4; i++) {
		await sleep(150);
		await fonts?.ready;
	}
}

/** Which layout a sheet belongs to, from what it prints. Verified by the `bare`
 *  scenarios, each of which must see only its own layout's measurements. */
function layoutOf(sheet: Element | null): AgendaLayout {
	const text = sheet?.textContent ?? "";
	if (text.includes("Detailed Timing") || text.includes("Timing Signals"))
		return "timing";
	// Grid and Editorial put the roster and the run of show on ONE sheet; only
	// Editorial prints the club mission. Spacious splits them across two.
	if (text.includes("Meeting Roles") && text.includes("Run of Show"))
		return text.includes("Club Mission") ? "editorial" : "grid";
	return "spacious";
}

let reads: Partial<Record<AgendaLayout, number>> = {};
const scrollHeight = Object.getOwnPropertyDescriptor(
	Element.prototype,
	"scrollHeight",
);
let counting = true;
Object.defineProperty(Element.prototype, "scrollHeight", {
	configurable: true,
	get(this: Element) {
		if (counting && this.hasAttribute("data-fit-inner")) {
			const l = layoutOf(this.closest(".agenda-page"));
			reads[l] = (reads[l] ?? 0) + 1;
		}
		return scrollHeight?.get?.call(this) ?? 0;
	},
});

function snapshot(step: string): Snapshot {
	const sheets = [...document.querySelectorAll<HTMLElement>(".agenda-page")];
	const active = document.querySelector<HTMLElement>('a[aria-current="page"]');
	const measured = reads;
	reads = {};
	// Reading the natural height below is not a FitPage measurement.
	counting = false;
	const real = sheets.filter((s) => !s.hasAttribute("data-agenda-blank"));
	const out: Snapshot = {
		step,
		pages: real.map((s) => s.offsetHeight),
		natural: real.map(
			(s) =>
				s.querySelector<HTMLElement>("[data-fit-inner]")?.scrollHeight ?? 0,
		),
		blanks: sheets.filter((s) => s.hasAttribute("data-agenda-blank")).length,
		timing: document.body.textContent?.includes("Detailed Timing") ?? false,
		notice:
			document.querySelector('[data-testid="print-fallback-notice"]')
				?.textContent ?? null,
		activeTab: active?.textContent?.replace(/Club default$/, "") ?? null,
		reads: measured,
	};
	counting = true;
	return out;
}

/** The agenda the route renders. Context, because the route component is built
 *  once per scenario and a "new loader data" step has to reach it. */
const AgendaCtx = createContext<{
	f: Fixture;
	source: object;
} | null>(null);

type HarnessSearch = ScenarioSearch;

/** The route's component: what `PrintAgenda` does with loader data, minus the
 *  loader, which is what `AgendaCtx` stands in for. */
function PrintPage() {
	const search = useSearch({ strict: false }) as HarnessSearch;
	const ctx = useContext(AgendaCtx);
	if (!ctx) throw new Error("no agenda context");
	const { f, source } = ctx;
	return (
		<PrintAgendaView
			layout={search.layout}
			source={source}
			bare={search.chrome === "none"}
			requestedCopies={search.copies}
			duplex={search.duplex}
			clubId="thr-speaking-club"
			meetingId="2026-10-10"
			defaultPrintLayout="grid"
			cancelled={false}
			flexBanner={null}
			header={f.header}
			roles={f.roles}
			officers={f.officers}
			explainers={f.explainers}
			rows={f.rows}
			qrUrl={undefined}
		/>
	);
}

function Harness({ scenario }: { scenario: Scenario }) {
	const [fixture, setFixture] = useState<FixtureId>(scenario.fixture);
	useEffect(() => {
		window.__setFixture = setFixture;
	}, []);
	// The loader's data object: a new agenda is a new object, as in the app.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the fixture is the trigger
	const source = useMemo(() => ({}), [fixture]);
	const f = fixtureOf(fixture);
	const rootRoute = useMemo(() => createRootRoute(), []);
	const router = useMemo(() => {
		const print = createRoute({
			getParentRoute: () => rootRoute,
			path: "/club/$clubId/meeting/$meetingId/print",
			validateSearch: (s: Record<string, unknown>) => ({
				layout: s.layout as AgendaLayout,
				copies: s.copies === undefined ? undefined : Number(s.copies),
				duplex: s.duplex === 1 || s.duplex === "1" ? (1 as const) : undefined,
				chrome: s.chrome === "none" ? ("none" as const) : undefined,
			}),
			component: PrintPage,
		});
		const qs = new URLSearchParams();
		qs.set("layout", scenario.search.layout);
		if (scenario.search.copies)
			qs.set("copies", String(scenario.search.copies));
		if (scenario.search.duplex) qs.set("duplex", "1");
		if (scenario.search.chrome) qs.set("chrome", "none");
		return createRouter({
			routeTree: rootRoute.addChildren([print]),
			history: createMemoryHistory({
				initialEntries: [
					`/club/thr-speaking-club/meeting/2026-10-10/print?${qs}`,
				],
			}),
		});
	}, [rootRoute, scenario]);
	return (
		<AgendaCtx.Provider value={{ f, source }}>
			<RouterProvider router={router} />
		</AgendaCtx.Provider>
	);
}

async function run(scenario: Scenario): Promise<Snapshot[]> {
	const host = document.getElementById("root") as HTMLElement;
	host.replaceChildren();
	const root = createRoot(host);
	const out: Snapshot[] = [];
	if (scenario.mode === "bare") {
		const f = fixtureOf(scenario.fixture);
		root.render(<MeetingAgendaPrint layout={scenario.search.layout} {...f} />);
		await settle();
		out.push(snapshot("bare"));
		root.unmount();
		return out;
	}
	root.render(<Harness scenario={scenario} />);
	await settle();
	out.push(snapshot("start"));
	for (const step of scenario.steps) {
		if (step.kind === "tab") {
			const tab = [...document.querySelectorAll<HTMLElement>("a")].find((a) =>
				a.textContent?.startsWith(AGENDA_LAYOUT_LABELS[step.layout]),
			);
			if (!tab) throw new Error(`no ${step.layout} tab`);
			tab.click();
		} else {
			window.__setFixture?.(step.fixture);
		}
		await settle();
		out.push(
			snapshot(
				step.kind === "tab" ? `tab:${step.layout}` : `fixture:${step.fixture}`,
			),
		);
	}
	root.unmount();
	return out;
}

async function main() {
	const all: Record<string, Snapshot[]> = {};
	for (const s of window.__INPUT__.scenarios) all[s.id] = await run(s);
	window.__report(all);
}

main().catch((e) =>
	document.documentElement.setAttribute(
		"data-error",
		encodeURIComponent(String(e?.stack ?? e)),
	),
);
