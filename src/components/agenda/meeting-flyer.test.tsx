/**
 * The Letter flyer poster (#931): what it prints, and that it prints on ONE
 * sheet. The Chrome cases follow the other print suites' rule (skip locally
 * without one, fail in CI). The page count alone cannot see a too-long poster — static
 * markup never runs `FitPage`'s effect, so the sheet is a clipped fixed box and
 * reports 1 whatever it holds — so the long case MEASURES the natural height
 * and asserts `FitPage` would scale it rather than flow it onto a second sheet
 * (`MIN_FIT_SCALE`).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";
import { MEETING_LIMITS } from "#/lib/meeting-limits";
import {
	buildFlyerContent,
	DEFAULT_PROMO_TEMPLATE,
	PROMO_LIMITS,
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

/** `n` characters of wrapping prose, distinct per `seed`. */
const prose = (n: number, seed = "") =>
	`${seed}Wonderful words wrap widely `.repeat(Math.ceil(n / 20)).slice(0, n);

/**
 * EVERY free-text field at its cap — headline, intro (switched on for the
 * flyer), eight bullets, call to action, promo note, venue and theme — which
 * is the longest poster a club can produce.
 */
function longest() {
	const template = {
		...DEFAULT_PROMO_TEMPLATE,
		headline: prose(PROMO_LIMITS.headline),
		intro: prose(PROMO_LIMITS.intro),
		whyJoin: Array.from({ length: PROMO_LIMITS.bullets }, (_, i) =>
			prose(PROMO_LIMITS.bullet, `${i} `),
		),
		callToAction: prose(PROMO_LIMITS.callToAction),
		channels: {
			...DEFAULT_PROMO_TEMPLATE.channels,
			flyer: { intro: true, whyJoin: true, callToAction: true },
		},
	};
	const c = buildFlyerContent(
		template,
		promoValues(
			CLUB,
			{
				...MEETING,
				location: prose(MEETING_LIMITS.location),
				theme: prose(MEETING_LIMITS.theme),
				promoNote: prose(PROMO_LIMITS.note),
			},
			"https://gavelup.app",
		),
	);
	// Fixture floor: each field really is at its cap.
	expect(c.headline).toHaveLength(PROMO_LIMITS.headline);
	expect(c.intro).toHaveLength(PROMO_LIMITS.intro);
	expect(c.callToAction).toHaveLength(PROMO_LIMITS.callToAction);
	expect(c.note).toHaveLength(PROMO_LIMITS.note);
	expect(c.whyJoin).toHaveLength(PROMO_LIMITS.bullets);
	return c;
}

// Same rule as every other browser-backed suite: skip locally without Chrome,
// FAIL in CI, because a silently absent print gate reads exactly like a
// passing one.
describe("Letter flyer print harness availability", () => {
	it("has a browser to print with when running in CI", () => {
		if (!process.env.CI) return;
		expect(
			chrome,
			"CI has no Chrome on PATH, so the flyer's page-count and fit " +
				"assertions would skip and the suite would still report green.",
		).not.toBe(null);
	});
});

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

		// The control that says what the 1 above is worth: Chrome prints an
		// EMPTY document as one valid page too, so a count of 1 is not proof of
		// content on its own — the content assertions at the top of this file,
		// and the measured height below, are what carry that.
		it("an empty document also prints one page — so 1 is not proof of content", () => {
			expect(pages("")).toBe(1);
		});

		it("every field at its cap still scales onto the sheet, never flows", () => {
			const doc = printableDocument(PRINT_PAGE_CSS, letter(longest()));
			const natural = measuredHeight(doc, "[data-fit-inner]");
			// Control: the content really is taller than the sheet, so this case
			// exercises the scaling path rather than fitting for free.
			expect(natural).toBeGreaterThan(PAGE_H);
			// With one wrapped line (16px) of headroom below the flow cliff: that
			// is the unit by which this harness's substitute font and CI's can
			// disagree (see `ballot-qr-print-fit.test.tsx`'s MIN_FLOW_SLACK_PX).
			const cliff = (PAGE_H - 2) / MIN_FIT_SCALE;
			expect(
				cliff - natural,
				`natural height ${natural}px against a ${cliff.toFixed(1)}px cliff`,
			).toBeGreaterThanOrEqual(16);
		});
	},
);
