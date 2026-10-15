/**
 * The browser half of `print-paginate.test.tsx` (#1227): mounts Timing in a
 * CLIENT React root in headless Chrome, so `FitPage`'s measuring effect and
 * `TimingMeasure`'s pagination really run, and reports what the sheets came to.
 *
 * Bundled by `client-bundle-chrome.ts`; not a test file. Reads its scenarios from
 * `window.__INPUT__`.
 *
 *   sheets   `MeetingAgendaPrint`, layout timing, no caller: every sheet's height,
 *            scale, footer, header, run-of-show text and the stamps it carries.
 *            What it is compared against is NOT read here: it is the snapshot
 *            main wrote (`print-paginate-main-ref.tsx`), because anything read
 *            through this branch's own `TimingEntry` would move with it.
 *   copies   `AgendaCopies` (2 copies, duplex): the blank sheets in the DOM, each
 *            copy's sheets, and the settled markup, which the test prints to a PDF.
 */
import { createRoot } from "react-dom/client";
import { AgendaCopies } from "#/components/agenda/agenda-copies";
import { MeetingAgendaPrint } from "#/components/agenda/meeting-agenda-print";
import { VISITING_TOASTMASTER_LEGEND } from "#/lib/agenda";
import {
	type PrintCompactFixtureId,
	printCompactAgenda,
} from "#/test/print-compact-fixtures";
import { THR_HEADER, THR_OFFICERS, thrAgenda } from "#/test/thr-agenda-fixture";

export type PaginateScenario = {
	id: string;
	kind: "sheets" | "copies";
	/** `thr`: the plain THR agenda (`thrAgenda`), which `print-compact-fixtures`
	 *  has no id for (it has the overflow variant, `thrLong`). */
	fixture: PrintCompactFixtureId | "thr";
	/** Indices into the fixture's rows to mark as a visiting Toastmaster. */
	visiting?: number[];
	/** The fixture's rows this many times over: a longer run than any one contest
	 *  has, to reach a sheet count the fixtures alone cannot. */
	repeat?: number;
};

export type PaginatedSheet = {
	height: number;
	scale: number;
	/** `[data-print-footer]` count on the sheet. */
	footers: number;
	footerText: string;
	/** The continuation header's text, null on sheets 1 and 2. */
	continuation: string | null;
	/** Its rendered height in px. */
	continuationHeight: number | null;
	/** innerText of `[data-run-of-show]`, null where the sheet has none (page 1). */
	region: string | null;
	/** The `data-row-time` stamps, in order. */
	times: string[];
	/** The text of the last element child of the run-of-show box. */
	lastText: string | null;
	/** Whether the sheet's footer prints the (V) key. */
	legend: boolean;
	/** The tail (announcements or notes) is on this sheet. */
	tail: boolean;
};

export type SheetsSnapshot = {
	sheets: PaginatedSheet[];
	/** How many timeline rows the scenario's agenda has (`a.rows.length`, sections
	 *  and hand-offs included), for the failure messages. */
	rows: number;
};

export type CopiesSnapshot = {
	blanks: number;
	/** `.agenda-page` per copy, blanks excluded. */
	perCopy: number[];
	heights: number[];
	/** The settled document, scripts removed: what the person would print. */
	html: string;
};

declare global {
	interface Window {
		__report: (v: unknown) => void;
	}
}

const QR = "https://example.test/meeting";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const host = () => document.getElementById("root") as HTMLElement;

/** Until the DOM stops changing for a few turns: the font wait, the measurement,
 *  the remount at compact, the pagination pass and its own measurement are each a
 *  separate turn, and there is no one event to await. */
async function settle() {
	const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } })
		.fonts;
	let last = "";
	let quiet = 0;
	for (let i = 0; i < 60 && quiet < 4; i++) {
		await sleep(100);
		await fonts?.ready;
		const now = host().innerHTML;
		if (now === last) quiet += 1;
		else {
			quiet = 0;
			last = now;
		}
	}
}

function baseAgenda(fixture: PaginateScenario["fixture"]) {
	if (fixture !== "thr") return printCompactAgenda(fixture);
	const { roles, rows } = thrAgenda({ veena: "Guest", david: "Guest" });
	return { header: THR_HEADER, roles, officers: THR_OFFICERS, rows };
}

function agenda(s: PaginateScenario) {
	const a = baseAgenda(s.fixture);
	const mark = new Set(s.visiting ?? []);
	const rows = Array.from({ length: s.repeat ?? 1 }, () => a.rows)
		.flat()
		.map((r, i) => (mark.has(i) ? { ...r, visiting: true as const } : r));
	return {
		header: a.header,
		roles: a.roles,
		officers: a.officers,
		explainers: [],
		rows,
		qrUrl: QR,
	};
}

function report(sheet: HTMLElement): PaginatedSheet {
	const inner = sheet.querySelector<HTMLElement>("[data-fit-inner]");
	const m = /scale\(([\d.]+)\)/.exec(inner?.style.transform ?? "");
	const region = sheet.querySelector<HTMLElement>("[data-run-of-show]");
	const footer = sheet.querySelector<HTMLElement>("[data-print-footer]");
	return {
		height: sheet.offsetHeight,
		scale: m ? Number(m[1]) : 1,
		footers: sheet.querySelectorAll("[data-print-footer]").length,
		footerText: footer?.innerText ?? "",
		continuation:
			sheet.querySelector<HTMLElement>("[data-continuation-header]")
				?.innerText ?? null,
		continuationHeight:
			sheet
				.querySelector<HTMLElement>("[data-continuation-header]")
				?.getBoundingClientRect().height ?? null,
		region: region?.innerText ?? null,
		times: [...sheet.querySelectorAll<HTMLElement>("[data-row-time]")].map(
			(e) => e.textContent ?? "",
		),
		lastText: region?.lastElementChild
			? deepLast(region.lastElementChild as HTMLElement)
			: null,
		legend: (footer?.innerText ?? "").includes(VISITING_TOASTMASTER_LEGEND),
		tail: sheet.querySelector("[data-run-tail]") !== null,
	};
}

/** The text of the last thing drawn in a unit: its last descendant chain. */
function deepLast(el: HTMLElement): string {
	let cur = el;
	while (cur.lastElementChild) cur = cur.lastElementChild as HTMLElement;
	// The deepest last element may be a cell; the entry is what a person reads as
	// "the last row", so report the unit's last direct child's text too.
	const entry = el.lastElementChild as HTMLElement | null;
	return (entry?.innerText ?? cur.innerText ?? "").trim();
}

async function sheetsScenario(s: PaginateScenario): Promise<SheetsSnapshot> {
	const a = agenda(s);
	const root = createRoot(host());
	root.render(<MeetingAgendaPrint layout="timing" {...a} />);
	await settle();
	const sheets = [...document.querySelectorAll<HTMLElement>(".agenda-page")];
	const out = { sheets: sheets.map(report), rows: a.rows.length };
	root.unmount();
	return out;
}

async function copiesScenario(s: PaginateScenario): Promise<CopiesSnapshot> {
	const a = agenda(s);
	const root = createRoot(host());
	root.render(<AgendaCopies layout="timing" copies={2} duplex={true} {...a} />);
	await settle();
	const copies = [
		...document.querySelectorAll<HTMLElement>("[data-agenda-copy]"),
	];
	const all = [
		...document.querySelectorAll<HTMLElement>(
			".agenda-page:not([data-agenda-blank])",
		),
	];
	const out: CopiesSnapshot = {
		blanks: document.querySelectorAll("[data-agenda-blank]").length,
		perCopy: copies.map((c) => c.querySelectorAll(".agenda-page").length),
		heights: all.map((e) => e.offsetHeight),
		html: "",
	};
	for (const el of [...document.querySelectorAll("script")]) el.remove();
	out.html = document.documentElement.outerHTML;
	root.unmount();
	return out;
}

async function main() {
	const all: Record<string, SheetsSnapshot | CopiesSnapshot> = {};
	for (const s of (
		window as unknown as { __INPUT__: { scenarios: PaginateScenario[] } }
	).__INPUT__.scenarios) {
		host().replaceChildren();
		all[s.id] =
			s.kind === "sheets" ? await sheetsScenario(s) : await copiesScenario(s);
	}
	window.__report(all);
}

main().catch((e) =>
	document.documentElement.setAttribute(
		"data-error",
		encodeURIComponent(String(e?.stack ?? e)),
	),
);
