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
import { afterEach, describe, expect, it } from "vitest";
import {
	DarkFooter,
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
