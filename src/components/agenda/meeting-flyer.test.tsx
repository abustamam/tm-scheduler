/**
 * The Letter flyer poster (#931): what it prints, and that it prints on ONE
 * sheet. The Chrome cases follow the other print suites' rule (skip locally
 * without one). The page count alone cannot see a too-long poster — static
 * markup never runs `FitPage`'s effect, so the sheet is a clipped fixed box and
 * reports 1 whatever it holds — so the long case MEASURES the natural height
 * and asserts `FitPage` would scale it rather than flow it onto a second sheet
 * (`MIN_FIT_SCALE`).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";
import {
	buildFlyerContent,
	DEFAULT_PROMO_TEMPLATE,
	type PromoMeeting,
	promoValues,
} from "#/lib/promo-template";
import {
	CHROME_TEST_TIMEOUT_MS,
	findChrome,
	measuredHeight,
	printableDocument,
	printedPageCount,
} from "#/test/print-page-count";
import {
	FLYER_QR_CAPTION,
	MeetingFlyerLetter,
	MeetingFlyerSquare,
} from "./meeting-flyer";
import { MIN_FIT_SCALE, PAGE_H, PRINT_PAGE_CSS } from "./print-theme";

const CLUB = {
	name: "Downtown Speakers",
	slug: "downtown",
	timezone: "America/Chicago",
};
const MEETING: PromoMeeting = {
	urlKey: "2026-10-01",
	scheduledAt: "2026-10-02T00:30:00Z",
	location: "Library, Room 4",
	online: true,
	theme: "Beginnings",
	wordOfTheDay: null,
	meetingNumber: 57,
	promoNote: "It's our open house, bring a friend!",
};

const content = (
	m: Partial<PromoMeeting> = {},
	origin = "https://gavelup.app",
) =>
	buildFlyerContent(
		DEFAULT_PROMO_TEMPLATE,
		promoValues(CLUB, { ...MEETING, ...m }, origin),
	);

const letter = (c = content()) =>
	renderToStaticMarkup(
		<MeetingFlyerLetter content={c} clubName={CLUB.name} logoUrl={null} />,
	);

describe("MeetingFlyerLetter", () => {
	const html = letter();

	it("prints the headline, when, where, theme, note and the why-join bullets", () => {
		for (const text of [
			"You&#x27;re invited: Downtown Speakers, Thursday, October 1",
			"Thursday, October 1 · 7:30 PM",
			"Library, Room 4",
			"Beginnings",
			"It&#x27;s our open house, bring a friend!",
			"Practice public speaking in a supportive room",
			FLYER_QR_CAPTION,
		]) {
			expect(html).toContain(text);
		}
	});

	it("carries the non-affiliation disclaimer (ADR-0024)", () => {
		expect(html).toContain(TOASTMASTERS_DISCLAIMER.slice(0, 40));
		expect(
			renderToStaticMarkup(
				<MeetingFlyerSquare content={content()} clubName={CLUB.name} />,
			),
		).toContain(TOASTMASTERS_DISCLAIMER.slice(0, 40));
	});

	it("draws a QR once the link is known, and an empty box before", () => {
		expect(html).toContain("<svg");
		expect(letter(content({}, ""))).not.toContain("<svg");
	});

	it("leaves out the lines it has no value for", () => {
		const bare = letter(
			content({ theme: null, promoNote: null, location: null }),
		);
		expect(bare).not.toContain("Theme:");
		expect(bare).not.toContain("flyer-note");
	});
});

const chrome = findChrome();

describe.skipIf(!chrome)(
	"the Letter flyer prints on one sheet",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		const pages = (html: string) =>
			printedPageCount(
				printableDocument(PRINT_PAGE_CSS, `<div class="pgwrap">${html}</div>`),
			);

		it("with the default template", () => {
			expect(pages(letter())).toBe(1);
		});

		it("the longest content a template allows still scales, never flows", () => {
			const long = content({
				theme: "A long meeting theme for the night",
				location: "The Community Library, Second Floor, Room 4",
			});
			long.headline = "H".repeat(10) + " headline ".repeat(15);
			long.whyJoin = Array(8).fill(
				"A why-join bullet long enough to wrap onto a second line of the poster",
			);
			const doc = printableDocument(PRINT_PAGE_CSS, letter(long));
			const natural = measuredHeight(doc, "[data-fit-inner]");
			// Control: the content really is taller than the sheet, so this case
			// exercises the scaling path rather than fitting for free.
			expect(natural).toBeGreaterThan(PAGE_H);
			expect((PAGE_H - 2) / natural).toBeGreaterThanOrEqual(MIN_FIT_SCALE);
		});
	},
);
