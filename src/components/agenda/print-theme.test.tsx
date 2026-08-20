// @vitest-environment jsdom
/**
 * The shared print chrome — the half a page count cannot see.
 *
 * `PRINT_PAGE_CSS` hides the toolbar with `.no-print { display: none }`, and
 * the guard pins that RULE. Nothing pinned the other half: that the toolbar
 * actually carries the class. A ship audit deleted `className="no-print"` from
 * `PrintToolbar` and all eight page-count assertions still passed, because the
 * toolbar is `position: fixed` and contributes no flow height — so removing it
 * from the printed page changes no page count while very much changing what
 * comes out of the printer.
 *
 * That asymmetry got worse with this extraction, not better: one component now
 * owns that class for all three print routes, so a single deletion would put a
 * floating toolbar on every printed agenda, poster and role sheet at once.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DarkFooter,
	FitPage,
	MIN_FIT_SCALE,
	PAGE_H,
	PRINT_PAGE_CSS,
	PrintButton,
	PrintToolbar,
} from "./print-theme";

afterEach(cleanup);

describe("PrintToolbar", () => {
	it("carries the class the print stylesheet hides", () => {
		const { container } = render(
			<PrintToolbar>
				<PrintButton />
			</PrintToolbar>,
		);
		const toolbar = container.firstElementChild as HTMLElement;
		expect(toolbar).not.toBeNull();
		expect(toolbar.className).toContain("no-print");
	});

	it("is the class PRINT_PAGE_CSS actually targets", () => {
		// Pins the two halves TOGETHER. Renaming the class on one side only is
		// otherwise invisible: the rule keeps matching nothing, and the page
		// count keeps passing.
		const { container } = render(
			<PrintToolbar>
				<PrintButton />
			</PrintToolbar>,
		);
		const cls = (container.firstElementChild as HTMLElement).className.trim();
		expect(PRINT_PAGE_CSS).toContain(`.${cls}`);
	});

	it("floats above the sheet without taking part in its layout", () => {
		// Why the page count is blind to it, recorded so the next reader does not
		// assume a passing count covers the toolbar.
		const { container } = render(
			<PrintToolbar>
				<PrintButton />
			</PrintToolbar>,
		);
		expect((container.firstElementChild as HTMLElement).style.position).toBe(
			"fixed",
		);
	});
});

describe("PrintButton", () => {
	it("renders a button that triggers the browser print dialog", () => {
		const { container } = render(<PrintButton />);
		const button = container.querySelector("button");
		expect(button?.type).toBe("button");
		expect(button?.textContent).toBe("Print");
	});
});

// #510 review finding 1. A reviewer disabled this branch, ran the full 230-file
// suite, and it stayed green — nothing anywhere asserted the QR renders. This
// is the unit-level half of the fix; `meeting-agenda-print.test.tsx` covers the
// same thing threaded through all four print layouts, and `print-page-count.
// test.tsx`'s real-Chrome gate covers the printed-page shape.
describe("DarkFooter's scan-to-vote QR", () => {
	const BALLOT_URL = "https://gavelup.test/club/mcf/meeting/2026-06-25/vote";

	it("renders a real QR svg in .footer-qr when given a ballotUrl", () => {
		const { container } = render(
			<DarkFooter left="left" right="right" ballotUrl={BALLOT_URL} />,
		);
		const qr = container.querySelector(".footer-qr");
		expect(qr).not.toBeNull();
		expect(qr?.querySelector("svg")).not.toBeNull();
		expect(qr?.textContent).toContain("Scan to vote");
	});

	it("renders no .footer-qr at all when ballotUrl is undefined", () => {
		const { container } = render(<DarkFooter left="left" right="right" />);
		expect(container.querySelector(".footer-qr")).toBeNull();
	});

	it("is the class PRINT_PAGE_CSS's break-inside:avoid rule actually targets", () => {
		// Same pairing lesson as `PrintToolbar` above: the CSS rule and the
		// className it depends on can drift independently, and only pinning both
		// together catches a rename on one side leaving the other stale.
		const { container } = render(
			<DarkFooter left="left" right="right" ballotUrl={BALLOT_URL} />,
		);
		const cls = container.querySelector(".footer-qr")?.className;
		expect(cls).toBeTruthy();
		expect(PRINT_PAGE_CSS).toContain(`.${cls}`);
	});
});

/**
 * `FitPage`'s two branches, finally reachable (#agenda-templates PR 2).
 *
 * This was the largest unprotected behaviour PR 1 shipped, and the reason was
 * structural rather than an oversight: the decision lives in a `useEffect` that
 * reads `scrollHeight`, and NEITHER print harness can run it. `print-page-count`
 * and `print-density` both feed `renderToStaticMarkup` output to headless
 * Chrome, so React never mounts; jsdom mounts React but reports `scrollHeight`
 * as 0, so the effect returns at its first guard. The consequence was that
 * `print-density.test.tsx` asserted a REIMPLEMENTATION of the rule — its
 * `printedDetailPt` helper mirrors `raw < MIN_FIT_SCALE` — which is a parity
 * test, blind to a defect present on both sides.
 *
 * Stubbing `scrollHeight` closes it. That is a real stub of a real DOM property
 * the component reads, not a mock of the component's own logic, so the branch
 * under test is the shipped one.
 */
describe("FitPage scale-vs-flow (#agenda-templates)", () => {
	/** Mount FitPage with the inner element reporting `height` px of content. */
	function mountWith(height: number) {
		const spy = vi
			.spyOn(HTMLElement.prototype, "scrollHeight", "get")
			.mockReturnValue(height);
		try {
			const { container } = render(
				<FitPage>
					<p>run of show</p>
				</FitPage>,
			);
			const outer = container.querySelector<HTMLElement>(".agenda-page");
			const inner = container.querySelector<HTMLElement>("[data-fit-inner]");
			if (!outer || !inner) throw new Error("FitPage did not render its sheet");
			return { outer, inner };
		} finally {
			spy.mockRestore();
		}
	}

	it("does not scale a sheet that already fits", () => {
		const { outer, inner } = mountWith(PAGE_H - 100);
		// No transform at all — not `scale(1)`. A sheet that fits is printed at its
		// declared size, which is what `printedDetailPt`'s clamp encodes.
		expect(inner.style.transform).toBe("");
		expect(outer.style.height).not.toBe("");
	});

	it("scales a sheet that overruns by a little", () => {
		// 10% over: scale ~0.909, comfortably above the floor, so it squeezes.
		const { outer, inner } = mountWith(Math.round(PAGE_H * 1.1));
		expect(inner.style.transform).toMatch(/scale\(/);
		// Still ONE fixed-height sheet — the whole point of scaling.
		expect(outer.style.height).not.toBe("");
		expect(outer.style.overflow).toBe("hidden");
	});

	/**
	 * The contest case, and the branch PR 1 added. A speech contest runs ~40 rows
	 * at four contestants and ~58 at seven; squeezing that onto one sheet printed
	 * the body text at 2.6pt. Below the floor the sheet must drop BOTH its fixed
	 * height and its overflow clip — dropping only the height would still clip at
	 * `PAGE_H`, and dropping only the clip would leave the tail overlapping the
	 * next sheet's content.
	 */
	it("flows a sheet too long to scale legibly, dropping the height AND the clip", () => {
		const { outer, inner } = mountWith(PAGE_H * 3);
		expect(inner.style.transform).toBe("");
		expect(outer.style.height).toBe("");
		expect(outer.style.overflow).toBe("");
	});

	/**
	 * The threshold itself, exercised through the component rather than through a
	 * mirror of its rule. Just inside the floor scales; just outside it flows. This
	 * is what makes `MIN_FIT_SCALE` a load-bearing number here: raise it to 0.95
	 * and the "just inside" case starts flowing, so an ordinary club agenda becomes
	 * two sheets — the failure the density suite could not see, because a
	 * flowing sheet prints at full size and only makes its floors easier to pass.
	 */
	it("switches branches at MIN_FIT_SCALE, measured through the component", () => {
		// Content heights either side of the floor. `scale = (PAGE_H - 2) / h`, so
		// h just below (PAGE_H - 2)/MIN_FIT_SCALE scales and just above flows.
		const pivot = (PAGE_H - 2) / MIN_FIT_SCALE;
		expect(mountWith(Math.floor(pivot) - 20).inner.style.transform).toMatch(
			/scale\(/,
		);
		cleanup();
		expect(mountWith(Math.ceil(pivot) + 20).outer.style.height).toBe("");
	});
});
