/**
 * The browser half of `print-compact.test.tsx` (#1226): mounts
 * `MeetingAgendaPrint` in a CLIENT React root in headless Chrome, so `FitPage`'s
 * measuring effect really runs and the density ladder really climbs.
 * `renderToStaticMarkup` never runs that effect.
 *
 * Bundled by `client-bundle-chrome.ts`; not a test file. Reads its scenarios from
 * `window.__INPUT__`.
 *
 *   climb   mount at the default density with a `onWouldFlow` spy, let the real
 *           measurement settle, report the sheets.
 *   text    mount at `regular` and at `compact` and read each sheet's innerText
 *           IMMEDIATELY, before `FitPage`'s font wait resolves, so neither read
 *           has already climbed.
 */
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
	type AgendaLayout,
	MeetingAgendaPrint,
} from "#/components/agenda/meeting-agenda-print";
import {
	type PrintCompactFixtureId,
	printCompactAgenda,
} from "#/test/print-compact-fixtures";

export type CompactScenario = {
	id: string;
	fixture: PrintCompactFixtureId;
	layout: AgendaLayout;
	kind: "climb" | "text";
};

export type SheetReport = {
	/** `.agenda-page` offsetHeight: 1056 for a sheet that fits or scales. */
	height: number;
	/** `[data-fit-inner]`'s natural scrollHeight, what FitPage weighs. */
	natural: number;
	/** The scale FitPage applied, 1 when it applied none. */
	scale: number;
};

export type ClimbSnapshot = {
	/** `onWouldFlow` calls the caller received. */
	calls: number;
	/** Whether any row is drawn compact (`data-row-block`). */
	compact: boolean;
	sheets: SheetReport[];
};

export type TextSnapshot = { regular: string[]; compact: string[] };

declare global {
	interface Window {
		__report: (v: unknown) => void;
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Long enough for the font wait, the measurement, the state change it causes,
 *  the remount at the next density and its own measurement: separate turns. */
async function settle() {
	const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } })
		.fonts;
	for (let i = 0; i < 6; i++) {
		await sleep(150);
		await fonts?.ready;
	}
}

const host = () => document.getElementById("root") as HTMLElement;

function sheetReports(): SheetReport[] {
	return [...document.querySelectorAll<HTMLElement>(".agenda-page")].map(
		(sheet) => {
			const inner = sheet.querySelector<HTMLElement>("[data-fit-inner]");
			const m = /scale\(([\d.]+)\)/.exec(inner?.style.transform ?? "");
			return {
				height: sheet.offsetHeight,
				natural: inner?.scrollHeight ?? 0,
				scale: m ? Number(m[1]) : 1,
			};
		},
	);
}

function innerTexts(): string[] {
	return [...document.querySelectorAll<HTMLElement>("[data-fit-inner]")].map(
		(el) => el.innerText,
	);
}

async function climb(s: CompactScenario): Promise<ClimbSnapshot> {
	const a = printCompactAgenda(s.fixture);
	let calls = 0;
	const root = createRoot(host());
	root.render(
		<MeetingAgendaPrint
			layout={s.layout}
			header={a.header}
			roles={a.roles}
			officers={a.officers}
			explainers={[]}
			rows={a.rows}
			onWouldFlow={() => {
				calls += 1;
			}}
		/>,
	);
	await settle();
	const out: ClimbSnapshot = {
		calls,
		compact: document.querySelector("[data-row-block]") !== null,
		sheets: sheetReports(),
	};
	root.unmount();
	return out;
}

function textAt(s: CompactScenario, density: "regular" | "compact"): string[] {
	const a = printCompactAgenda(s.fixture);
	const root = createRoot(host());
	flushSync(() =>
		root.render(
			<MeetingAgendaPrint
				layout={s.layout}
				header={a.header}
				roles={a.roles}
				officers={a.officers}
				explainers={[]}
				rows={a.rows}
				initialDensity={density}
			/>,
		),
	);
	const out = innerTexts();
	root.unmount();
	return out;
}

async function run(s: CompactScenario): Promise<ClimbSnapshot | TextSnapshot> {
	host().replaceChildren();
	if (s.kind === "climb") return climb(s);
	return { regular: textAt(s, "regular"), compact: textAt(s, "compact") };
}

async function main() {
	const all: Record<string, ClimbSnapshot | TextSnapshot> = {};
	for (const s of (
		window as unknown as { __INPUT__: { scenarios: CompactScenario[] } }
	).__INPUT__.scenarios)
		all[s.id] = await run(s);
	window.__report(all);
}

main().catch((e) =>
	document.documentElement.setAttribute(
		"data-error",
		encodeURIComponent(String(e?.stack ?? e)),
	),
);
