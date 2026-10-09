/**
 * The club visit summary promises ONE sheet (#1120), and nothing else measures it.
 *
 * `area-club-summary` render tests assert text, and jsdom performs no layout. The
 * page count alone cannot see an overflow either: the sheet is a `FitPage`, whose
 * scale-and-flow decision is a `useEffect` that static markup never runs, so its
 * `.agenda-page` stays a fixed, clipped letter page and reports ONE whatever it
 * holds (`print-page-count.test.tsx` and `ballot-qr-print-fit.test.tsx` explain).
 * So this measures the thing that does move: the sheet's NATURAL height, which is
 * what `FitPage` reads at runtime to decide whether to scale it down. One sheet
 * means a natural height under `PAGE_H`, where `FitPage` does nothing at all.
 *
 * The fixtures are the long ones, not only "Downtown Speakers": a club name at
 * the 120-character cap (it wraps in the header band), the longest area label
 * (4-letter division, 4-character number), a name-only club (no numbers, a
 * sentence in their place) and a club with everything tracked and both visits.
 *
 * Same caveat as its neighbours: no webfont resolves in the harness and the
 * substitute differs between macOS and CI's Ubuntu, so the bound keeps a margin
 * of one wrapped line rather than pinning the measurement.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ClubHealth } from "#/lib/area-health";
import { AREA_CLUB_NAME_MAX } from "#/lib/area-limits";
import {
	CHROME_TEST_TIMEOUT_MS,
	findChrome,
	measuredHeights,
	printableDocument,
	printedPageCount,
} from "#/test/print-page-count";
import { PAGE_H, PRINT_PAGE_CSS } from "../agenda/print-theme";
import { AreaClubSummarySheet } from "./area-club-summary-sheet";

const hasChrome = findChrome() !== null;

/** One wrapped line, the unit of cross-platform variance this harness has. */
const SLACK_PX = 16;

const LONG_NAME = "Greater Metropolitan Downtown Toastmasters Speakers Club"
	.repeat(3)
	.slice(0, AREA_CLUB_NAME_MAX);

function club(overrides: Partial<ClubHealth> = {}): ClubHealth {
	return {
		areaClubId: "row-1",
		name: "Downtown Speakers",
		clubNumber: "12345678",
		status: "on_gavelup",
		meetings: {
			tracked: true,
			value: {
				held: 12,
				cancelled: 3,
				daysSinceLast: 120,
				next: ["2026-10-15T12:00:00.000Z", "2026-10-22T12:00:00.000Z"],
			},
		},
		roleFillRate: { tracked: true, value: { filled: 118, total: 124 } },
		attendance: {
			tracked: true,
			value: { avgMembers: 111.25, avgGuests: 10.5, rollTaken: 14, held: 15 },
		},
		officers: {
			tracked: true,
			value: {
				seatsFilled: 6,
				seatsTotal: 7,
				trained: { tracked: true, value: 4 },
			},
		},
		dcp: { tracked: true, value: { goalsMet: 10 } },
		renewals: {
			tracked: true,
			value: { paidThisPeriod: 140, paidLastPeriod: 160 },
		},
		...overrides,
	};
}

const SHEETS = {
	normal: { label: "C3", club: club() },
	longName: { label: "C3", club: club({ name: LONG_NAME }) },
	longLabel: { label: "WXYZ9999", club: club() },
	longBoth: { label: "WXYZ9999", club: club({ name: LONG_NAME }) },
	nameOnly: {
		label: "WXYZ9999",
		club: club({
			name: LONG_NAME,
			status: "not_on_gavelup",
			meetings: { tracked: false },
			roleFillRate: { tracked: false },
			attendance: { tracked: false },
			officers: { tracked: false },
			dcp: { tracked: false },
			renewals: { tracked: false },
		}),
	},
} as const;

function sheetHtml(key: keyof typeof SHEETS): string {
	const { label, club: c } = SHEETS[key];
	return renderToStaticMarkup(
		<AreaClubSummarySheet
			summary={{
				label,
				programYear: 2026,
				asOf: "2026-10-09T14:32:00.000Z",
				club: c,
				visits: { 1: "2026-10-12", 2: "2027-01-20" },
			}}
		/>,
	);
}

describe("the club visit summary's one-page promise (#1120)", () => {
	it("has a browser to measure with when running in CI", () => {
		if (!process.env.CI) return;
		expect(
			hasChrome,
			"CI has no Chrome, so the one-page measurement would skip and read green",
		).toBe(true);
	});

	describe.skipIf(!hasChrome)(
		"measured",
		{ timeout: CHROME_TEST_TIMEOUT_MS },
		() => {
			it("keeps every sheet's natural height under one letter page, long names included", () => {
				const keys = Object.keys(SHEETS) as (keyof typeof SHEETS)[];
				const body = keys
					.map((k) => `<div id="${k}">${sheetHtml(k)}</div>`)
					.join("");
				const heights = measuredHeights(
					printableDocument(PRINT_PAGE_CSS, body),
					keys.map((k) => `#${k} [data-fit-inner]`),
				);
				const byKey = Object.fromEntries(keys.map((k, i) => [k, heights[i]]));
				for (const k of keys) {
					expect(
						heights[keys.indexOf(k)],
						`${k}: ${JSON.stringify(byKey)}`,
					).toBeLessThanOrEqual(PAGE_H - SLACK_PX);
				}
				// Control: the long fixtures really are taller than the plain one, so
				// this is measuring the name and not three copies of one sheet.
				expect(byKey.longName as number).toBeGreaterThan(
					byKey.normal as number,
				);
			});

			it("prints the worst case on one page", () => {
				expect(
					printedPageCount(
						printableDocument(PRINT_PAGE_CSS, sheetHtml("longBoth")),
					),
				).toBe(1);
			});
		},
	);
});
