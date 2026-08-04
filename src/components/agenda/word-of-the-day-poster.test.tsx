// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";
import {
	CONTENT_W,
	POSTER_FONT_WEIGHT,
	POSTER_PAD_X,
	posterBodySize,
	posterWordSize,
} from "#/lib/word-poster";
import { PAGE_W } from "./print-theme";
import { WordOfTheDayPoster } from "./word-of-the-day-poster";

afterEach(cleanup);

const base = {
	word: "Ephemeral",
	definition: "Lasting for a very short time; fleeting.",
	example: "The applause was ephemeral, but the lesson stayed.",
	clubName: "Downtown Toastmasters",
	dateLong: "Friday, July 31, 2026",
};

describe("WordOfTheDayPoster", () => {
	it("renders the word, definition, and example", () => {
		render(<WordOfTheDayPoster {...base} />);
		expect(screen.getByText("Ephemeral")).toBeTruthy();
		expect(
			screen.getByText("Lasting for a very short time; fleeting."),
		).toBeTruthy();
		expect(
			screen.getByText(/The applause was ephemeral, but the lesson stayed\./),
		).toBeTruthy();
	});

	it("renders the club name and date in the footer", () => {
		render(<WordOfTheDayPoster {...base} />);
		expect(screen.getByText("Downtown Toastmasters")).toBeTruthy();
		expect(screen.getByText("Friday, July 31, 2026")).toBeTruthy();
	});

	// Trademark guard (#381 / ADR-0024) pinned where it belongs: this poster is a
	// PUBLIC printable that hangs on a wall for a whole meeting, so it must carry
	// the TI non-affiliation disclaimer. It gets it from print-theme's
	// <DarkFooter />, and asserting it HERE — on the rendered artifact rather than
	// on the route's source — survives any future change to how routes are
	// registered, and holds for every surface that mounts this component.
	it("carries the Toastmasters non-affiliation disclaimer", () => {
		render(<WordOfTheDayPoster {...base} />);
		expect(screen.getByText(TOASTMASTERS_DISCLAIMER)).toBeTruthy();
	});

	// The disclaimer is not conditional on the optional blocks: a word-only poster
	// is the sparsest thing this component renders, and still a public surface.
	it("carries the disclaimer even with no definition or example", () => {
		render(<WordOfTheDayPoster {...base} definition={null} example={null} />);
		expect(screen.getByText(TOASTMASTERS_DISCLAIMER)).toBeTruthy();
	});

	// Asserted against `posterWordSize` rather than literal px: the behaviour
	// under test is the wiring — that the size lands on the element holding the
	// word — not the table's current values, which are retuned by measurement.
	it("sizes the word from its length", () => {
		const { unmount } = render(<WordOfTheDayPoster {...base} word="Apt" />);
		expect(screen.getByText("Apt").style.fontSize).toBe(
			`${posterWordSize("Apt")}px`,
		);
		unmount();
		render(<WordOfTheDayPoster {...base} word="Circumlocution!" />);
		expect(screen.getByText("Circumlocution!").style.fontSize).toBe(
			`${posterWordSize("Circumlocution!")}px`,
		);
		// The two lengths must actually resolve to different sizes, or the
		// assertions above would hold even if the size were constant.
		expect(posterWordSize("Apt")).not.toBe(posterWordSize("Circumlocution!"));
	});

	it("trims the word for both sizing and rendering", () => {
		render(<WordOfTheDayPoster {...base} word="  Apt  " />);
		const el = screen.getByText("Apt");
		expect(el.style.fontSize).toBe(`${posterWordSize("Apt")}px`);
	});

	// The sizes in `word-poster.ts` were measured against a content box of
	// exactly CONTENT_W. Nothing else ties that number to the page width and the
	// poster's padding, so widening either would silently narrow the box below
	// what the tables assume and reintroduce mid-word breaks.
	it("keeps the measured content width equal to the real page geometry", () => {
		expect(PAGE_W - 2 * POSTER_PAD_X).toBe(CONTENT_W);
	});

	// ...and the identity above is worth nothing on its own: it relates three
	// constants while saying nothing about what the poster RENDERS. Padding of
	// `POSTER_PAD_X + 24` narrows the real box to 656px — under the 685px target
	// the tables were derived against — with every other test in this file still
	// green. These two pin the geometry to the constants it was measured with.
	it("pads the content box by exactly POSTER_PAD_X on both sides", () => {
		render(<WordOfTheDayPoster {...base} />);
		const box = screen.getByText("Ephemeral").parentElement;
		expect(box?.style.paddingLeft).toBe(`${POSTER_PAD_X}px`);
		expect(box?.style.paddingRight).toBe(`${POSTER_PAD_X}px`);
	});

	it("sets the word at the weight the sizes were derived at", () => {
		render(<WordOfTheDayPoster {...base} />);
		expect(screen.getByText("Ephemeral").style.fontWeight).toBe(
			String(POSTER_FONT_WEIGHT),
		);
	});

	// The body copy is sized FROM the word, so the word keeps the same dominance
	// at every length. A fixed body size made "Apt" 5.8x the definition and a
	// 22-letter word only 1.5x. Definition and example share the size; the
	// example is set apart by italics, colour and quotes.
	it("sizes the definition and example from the word", () => {
		const { unmount } = render(<WordOfTheDayPoster {...base} word="Apt" />);
		expect(screen.getByTestId("wod-definition").style.fontSize).toBe(
			`${posterBodySize("Apt")}px`,
		);
		expect(screen.getByTestId("wod-example").style.fontSize).toBe(
			`${posterBodySize("Apt")}px`,
		);
		unmount();

		const long = "Electroencephalographs";
		render(<WordOfTheDayPoster {...base} word={long} />);
		expect(screen.getByTestId("wod-definition").style.fontSize).toBe(
			`${posterBodySize(long)}px`,
		);
		expect(screen.getByTestId("wod-example").style.fontSize).toBe(
			`${posterBodySize(long)}px`,
		);
		// The two words must really resolve to different body sizes, or the
		// assertions above would hold for a hardcoded size too.
		expect(posterBodySize("Apt")).not.toBe(posterBodySize(long));
	});

	// 23em is the measure, but at the 32px body ceiling that is 736px — wider
	// than the 704px content box. The cap is what keeps the intent from
	// overflowing now that the size varies.
	it("caps the body measure at the content width", () => {
		render(<WordOfTheDayPoster {...base} word="Apt" />);
		const expected = `min(23em, ${CONTENT_W}px)`;
		expect(screen.getByTestId("wod-definition").style.maxWidth).toBe(expected);
		expect(screen.getByTestId("wod-example").style.maxWidth).toBe(expected);
	});

	it("omits the definition block when there is no definition", () => {
		render(<WordOfTheDayPoster {...base} definition={null} />);
		expect(screen.getByText("Ephemeral")).toBeTruthy();
		expect(screen.queryByTestId("wod-definition")).toBeNull();
		// The example still renders on its own, and drops the top margin that
		// only exists to separate it from the definition above.
		expect(screen.getByTestId("wod-example")).toBeTruthy();
		expect(screen.getByTestId("wod-example").style.marginTop).toBe("0px");
	});

	// Both sides, because the "no definition" case alone cannot fail if the
	// margin is made unconditional — it is 0 in exactly that case either way.
	it("spaces the example from the definition only when both render", () => {
		const { unmount } = render(<WordOfTheDayPoster {...base} />);
		expect(screen.getByTestId("wod-example").style.marginTop).toBe("34px");
		unmount();
		render(<WordOfTheDayPoster {...base} definition={null} />);
		expect(screen.getByTestId("wod-example").style.marginTop).toBe("0px");
	});

	it("omits the example block when there is no example", () => {
		render(<WordOfTheDayPoster {...base} example={null} />);
		expect(screen.getByTestId("wod-definition")).toBeTruthy();
		expect(screen.queryByTestId("wod-example")).toBeNull();
	});

	it("renders the word alone when neither definition nor example is set", () => {
		render(<WordOfTheDayPoster {...base} definition={null} example={null} />);
		expect(screen.getByText("Ephemeral")).toBeTruthy();
		expect(screen.queryByTestId("wod-definition")).toBeNull();
		expect(screen.queryByTestId("wod-example")).toBeNull();
	});

	it("treats a whitespace-only definition as absent", () => {
		render(<WordOfTheDayPoster {...base} definition="   " />);
		expect(screen.queryByTestId("wod-definition")).toBeNull();
	});

	it("treats a whitespace-only example as absent", () => {
		render(<WordOfTheDayPoster {...base} example="   " />);
		expect(screen.queryByTestId("wod-example")).toBeNull();
	});
});

describe("club logo (#496)", () => {
	const LOGO =
		"/api/club/11111111-1111-4111-8111-111111111111/logo?v=1754000000000";

	it("renders the club's logo in the footer when one is set", () => {
		render(<WordOfTheDayPoster {...base} logoUrl={LOGO} />);
		const img = document.querySelector<HTMLImageElement>(`img[src="${LOGO}"]`);
		expect(img).not.toBeNull();
		// Sized to the footer's text line, NOT the print default of 48px: this
		// component's word size comes from a measured table and the sheet must
		// stay one page. A taller band would eat body height.
		expect(img?.style.height).toBe("20px");
		// Decorative — the club name is the adjacent text (ADR-0024 constraint 1
		// also forbids naming a mark in text a screen reader would announce).
		expect(img?.getAttribute("alt")).toBe("");
	});

	it("renders no image element at all when the club has no logo", () => {
		render(<WordOfTheDayPoster {...base} logoUrl={null} />);
		expect(document.querySelector("img")).toBeNull();
	});

	it("still shows the club name beside the logo", () => {
		render(<WordOfTheDayPoster {...base} logoUrl={LOGO} />);
		expect(screen.getByText(base.clubName)).toBeTruthy();
	});
});
