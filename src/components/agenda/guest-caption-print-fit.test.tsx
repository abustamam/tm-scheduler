/**
 * A guest speaker's caption on the printed agenda (#1059, criterion 3).
 *
 * Since #1059 a guest holding a role prints as "Name · Guest speaker, <home
 * club>" rather than "Name · Guest", and a home club is free text up to
 * `GUEST_TEXT_MAX` characters. The caption lands in two places on a sheet — the
 * roster entry and the speaker's own run-of-show row — and either can wrap. The
 * page COUNT cannot see that (a sheet is `overflow: hidden`, so it is one page
 * whatever it holds; see `print-page-count.test.tsx`'s header): what the caption
 * can actually do is push a sheet's natural height past `MIN_FIT_SCALE`'s
 * threshold, where `FitPage` stops scaling and lets it FLOW onto a second page.
 * So that threshold is what this measures, on every layout, with the caption at
 * the longest home club the app will store.
 *
 * The caption string is built by the SHIPPED formatters (`guestKindCaption` +
 * `assigneeDisplayName`), never restated, so a change to its shape is measured
 * rather than assumed. A no-caption control beside it must come out SHORTER on
 * at least one sheet, which is what proves the caption rendered at all — a
 * fixture that silently lost it would pass every ceiling below.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { assigneeDisplayName } from "#/lib/agenda";
import { GUEST_TEXT_MAX, guestKindCaption } from "#/lib/guest-profile";
import { meetingHubUrlFor } from "#/lib/meeting-hub";
import {
	MCF_EXPLAINERS,
	MCF_HEADER,
	MCF_OFFICERS,
	MCF_ROLES,
	MCF_ROWS,
} from "#/test/mcf-agenda-fixture";
import {
	CHROME_TEST_TIMEOUT_MS,
	findChrome,
	measuredHeights,
	printableDocument,
} from "#/test/print-page-count";
import { type AgendaLayout, MeetingAgendaPrint } from "./meeting-agenda-print";
import { MIN_FIT_SCALE, PAGE_H, PRINT_PAGE_CSS } from "./print-theme";

const GUEST = "Sudheer Isanaka";

/** Every printed agenda carries the meeting QR since #913, so the sheet
 *  measured here carries it too. */
const QR_URL = meetingHubUrlFor(
	{ clubKey: "mcf-toastmasters", meetingKey: "2026-08-13" },
	"https://gavelup.app",
);

/** A home club at the stored maximum, made of ordinary words so it wraps the
 *  way a real club name does rather than as one unbreakable token. */
const LONGEST_HOME_CLUB = "Downtown Metropolitan Professional Speakers "
	.repeat(4)
	.slice(0, GUEST_TEXT_MAX)
	.trim();

const CAPTIONED = assigneeDisplayName(
	GUEST,
	true,
	guestKindCaption("guest_speaker", LONGEST_HOME_CLUB),
) as string;

/** MCF's real agenda with Speaker 2 held by a guest speaker. */
function withGuest(display: string) {
	return {
		roles: MCF_ROLES.map((r) =>
			r.label === "Speaker 2" ? { ...r, name: display } : r,
		),
		rows: MCF_ROWS.map((r) =>
			r.who === `Speaker 2 · ${GUEST}`
				? // The halves the run-of-show builder writes beside `who` (#463),
					// which the timing layout prints from.
					{
						...r,
						who: `Speaker 2 · ${display}`,
						roleLabel: "Speaker 2",
						holder: display,
					}
				: r,
		),
	};
}

function sheetHtml(layout: AgendaLayout, display: string): string {
	const { roles, rows } = withGuest(display);
	return renderToStaticMarkup(
		<MeetingAgendaPrint
			layout={layout}
			header={MCF_HEADER}
			roles={roles}
			officers={MCF_OFFICERS}
			explainers={MCF_EXPLAINERS}
			rows={rows}
			qrUrl={QR_URL}
		/>,
	);
}

const LAYOUTS: readonly AgendaLayout[] = [
	"editorial",
	"grid",
	"timing",
	"spacious",
];

/**
 * The pre-fix control: the SAME string, the same length, with the label's
 * space swapped for a hyphen so `guestCaptionStart` does not see it and the
 * print layouts lay it out as they did before #1059 — free to wrap. It must
 * FLOW somewhere, or the cases below could not fail.
 */
const UNDETECTED = CAPTIONED.replace(" · Guest speaker", " · Guest-speaker");

/** A home club with line breaks in it. The profile schema trims and bounds a
 *  home club but keeps what is inside it, so this is a value an officer (or a
 *  paste) can store — and a caption laid out with `white-space: pre` would
 *  print every one of those lines. */
const MULTILINE = assigneeDisplayName(
	GUEST,
	true,
	guestKindCaption("guest_speaker", `${"A\n".repeat(50)}B`),
) as string;

const VARIANTS = {
	captioned: CAPTIONED,
	multiline: MULTILINE,
	plain: `${GUEST} · Guest`,
	control: UNDETECTED,
} as const;
type Variant = keyof typeof VARIANTS;

/** Every sheet of every layout, in every variant, in ONE browser launch. The
 *  two-sheet layouts are measured sheet by sheet: `[data-fit-inner]` alone
 *  matches only the first. */
function sheetSelectors(id: string, layout: AgendaLayout): string[] {
	return layout === "timing" || layout === "spacious"
		? [1, 2].map(
				(n) => `#${id} .agenda-page:nth-of-type(${n}) [data-fit-inner]`,
			)
		: [`#${id} [data-fit-inner]`];
}

/** Per sheet: its natural height, and how far its content overflows the sheet
 *  SIDEWAYS. A caption held to one line by `nowrap` but not allowed to shrink
 *  costs no height at all — it runs off the right edge of the paper instead,
 *  taking the timing marks with it — so height alone cannot see that half. */
type Sheet = { height: number; overflowX: number };
type Measured = Record<AgendaLayout, Record<Variant, Sheet[]>>;

/**
 * The harness reads back `scrollHeight` and nothing else, so the sideways
 * overflow is written into the HEIGHT of a marker div by a script that runs
 * before the harness's own probe — 1px plus the overflow, because a zero
 * height is refused as "not a measurement" below.
 */
function overflowProbe(sheets: readonly string[]): string {
	return `<script>
	(function () {
		${JSON.stringify(sheets)}.forEach(function (sel, i) {
			var el = document.querySelector(sel);
			var d = document.createElement("div");
			d.id = "ovf-" + i;
			d.style.height = (el ? 1 + Math.max(0, el.scrollWidth - el.clientWidth) : 0) + "px";
			document.body.appendChild(d);
		});
	})();
	</script>`;
}

let cached: Measured | null = null;
function measure(): Measured {
	if (cached) return cached;
	const variants = Object.keys(VARIANTS) as Variant[];
	const parts = LAYOUTS.flatMap((layout) =>
		variants.map((v) => ({ id: `${layout}-${v}`, layout, v })),
	);
	const sheets = parts.flatMap((p) => sheetSelectors(p.id, p.layout));
	const body =
		parts
			.map(
				(p) => `<div id="${p.id}">${sheetHtml(p.layout, VARIANTS[p.v])}</div>`,
			)
			.join("") + overflowProbe(sheets);
	const selectors = [...sheets, ...sheets.map((_, i) => `#ovf-${i}`)];
	const heights = measuredHeights(
		printableDocument(PRINT_PAGE_CSS, body),
		selectors,
	);
	for (const [i, h] of heights.entries()) {
		if (!h || h <= 0)
			throw new Error(`Measured ${h} for ${selectors[i]} — not a measurement.`);
	}
	let at = 0;
	const out = {} as Measured;
	for (const p of parts) {
		const n = sheetSelectors(p.id, p.layout).length;
		out[p.layout] ??= {} as Record<Variant, Sheet[]>;
		out[p.layout][p.v] = Array.from({ length: n }, (_, k) => ({
			height: heights[at + k] ?? 0,
			overflowX: (heights[sheets.length + at + k] ?? 1) - 1,
		}));
		at += n;
	}
	cached = out;
	return out;
}

const fits = (h: number) => (PAGE_H - 2) / h >= MIN_FIT_SCALE;

const hasChrome = findChrome() !== null;

describe("guest caption print-fit harness availability", () => {
	it("has a browser to measure with when running in CI", () => {
		if (!process.env.CI) return;
		expect(
			hasChrome,
			"CI has no Chrome, so the caption's print fit would skip and read green.",
		).toBe(true);
	});
});

describe("the captioned fixture", () => {
	it("carries the full caption into both the roster and the speaker's row", () => {
		expect(CAPTIONED).toBe(`${GUEST} · Guest speaker, ${LONGEST_HOME_CLUB}`);
		expect(LONGEST_HOME_CLUB.length).toBeGreaterThan(GUEST_TEXT_MAX - 5);
		expect(UNDETECTED.length).toBe(CAPTIONED.length);
		for (const layout of LAYOUTS) {
			const html = sheetHtml(layout, CAPTIONED);
			// The FULL string is in the markup — truncation is CSS only — in both
			// the roster entry and the run-of-show row.
			expect(html.split(LONGEST_HOME_CLUB).length - 1, layout).toBe(2);
			expect(html, layout).toContain("text-overflow:ellipsis");
			expect(sheetHtml(layout, UNDETECTED), layout).not.toContain(
				"text-overflow:ellipsis",
			);
		}
	});
});

describe.skipIf(!hasChrome)(
	"a guest speaker's caption on the printed agenda",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		it("measures the one-page layouts on one page before any caption", () => {
			// Without this the ceilings below would be vacuous on a fixture that
			// already flowed.
			const m = measure();
			for (const layout of ["editorial", "grid"] as const)
				expect(fits(m[layout].plain[0]?.height ?? 0), layout).toBe(true);
		});

		it("never moves a sheet past the flow threshold, at the longest home club", () => {
			const m = measure();
			for (const layout of LAYOUTS) {
				for (const [i, { height: h }] of m[layout].captioned.entries()) {
					// A sheet that already flows with a plain "· Guest" (spacious
					// page 2 on CI's fonts) cannot be pushed over a cliff it is past.
					if (!fits(m[layout].plain[i]?.height ?? 0)) continue;
					expect(
						fits(h),
						`${layout} sheet ${i + 1} measures ${h}px with the longest ` +
							"caption, which FitPage would flow onto a second page",
					).toBe(true);
				}
			}
		});

		it("costs no sheet a single pixel of height", () => {
			// Editorial is ~19px from the cliff on CI's fonts (see
			// `ballot-qr-print-fit.test.tsx`), so "still fits on this machine" is
			// not enough: the caption must add nothing a wider face could tip over.
			const m = measure();
			for (const layout of LAYOUTS)
				for (const v of ["captioned", "multiline"] as const)
					expect(
						m[layout][v].map((x) => x.height),
						`${layout} (${v})`,
					).toEqual(m[layout].plain.map((x) => x.height));
		});

		it("runs nothing off the side of the sheet — the caption shrinks, not the paper", () => {
			const m = measure();
			for (const layout of LAYOUTS)
				expect(
					m[layout].captioned.map((x) => x.overflowX),
					layout,
				).toEqual(m[layout].plain.map((x) => x.overflowX));
		});

		it("flows without the one-line rule — the pre-fix control", () => {
			const m = measure();
			const flowed = LAYOUTS.some((layout) =>
				m[layout].control.some(
					(x, i) => fits(m[layout].plain[i]?.height ?? 0) && !fits(x.height),
				),
			);
			expect(flowed).toBe(true);
		});
	},
);
