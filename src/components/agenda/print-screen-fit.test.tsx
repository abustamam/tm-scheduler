// @vitest-environment jsdom
/**
 * The custom properties `FitPage` hands the screen fit (#964).
 *
 * `SCREEN_FIT_CSS` shrinks a sheet against `--sheet-w` / `--sheet-h`, and gives
 * back the scaled share of `--sheet-h` with a negative bottom margin. The
 * geometry suite beside this (`print-screen-fit-geometry.test.tsx`) proves what
 * the CSS does with those values in a real browser, but it cannot run `FitPage`'s
 * effect — static markup never mounts React — so it sets the flowed state by
 * hand. This is the other half: that the shipped component actually writes the
 * values the geometry suite assumed. The property names are imported from the
 * module both halves use, so the two cannot agree with each other and disagree
 * with the component.
 *
 * `scrollHeight` is stubbed, the same technique `print-theme.test.tsx` uses to
 * reach `FitPage`'s branches: a real DOM property the component reads, not a
 * mock of its logic.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FitPage,
	PAGE_H,
	PAGE_W,
	SHEET_H_VAR,
	SHEET_W_VAR,
} from "./print-theme";

afterEach(cleanup);

function mountWith(
	height: number,
	orientation: "portrait" | "landscape" = "portrait",
) {
	const spy = vi
		.spyOn(HTMLElement.prototype, "scrollHeight", "get")
		.mockReturnValue(height);
	try {
		const { container } = render(
			<FitPage orientation={orientation}>
				<p>run of show</p>
			</FitPage>,
		);
		const outer = container.querySelector<HTMLElement>(".agenda-page");
		if (!outer) throw new Error("FitPage did not render its sheet");
		return {
			outer,
			w: outer.style.getPropertyValue(SHEET_W_VAR),
			h: outer.style.getPropertyValue(SHEET_H_VAR),
		};
	} finally {
		spy.mockRestore();
	}
}

describe("FitPage's screen-fit properties (#964)", () => {
	it("hands a sheet that fits the page box", () => {
		const { w, h } = mountWith(PAGE_H - 100);
		expect(w).toBe(`${PAGE_W}px`);
		expect(h).toBe(`${PAGE_H}px`);
	});

	it("hands a scaled sheet the page box too — it is still one fixed sheet", () => {
		const { outer, h } = mountWith(Math.round(PAGE_H * 1.1));
		expect(outer.style.height).not.toBe("");
		expect(h).toBe(`${PAGE_H}px`);
	});

	it("hands a FLOWING sheet its measured height, not the page box", () => {
		// Left at PAGE_H, the negative margin gave back (1 - fit) x 1056 of the
		// (1 - fit) x 3168 the scale took, and a phone scrolled through the rest.
		const { outer, h } = mountWith(PAGE_H * 3);
		expect(outer.style.height).toBe(""); // really flowing
		expect(h).toBe(`${PAGE_H * 3}px`);
	});

	it("hands a landscape sheet the landscape box", () => {
		const { w, h } = mountWith(100, "landscape");
		expect(w).toBe(`${PAGE_H}px`);
		expect(h).toBe(`${PAGE_W}px`);
	});
});
