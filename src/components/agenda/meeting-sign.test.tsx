// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MeetingSign } from "./meeting-sign";

afterEach(cleanup);

describe("MeetingSign (#1167)", () => {
	it("without an arrow: guests welcome, the invitation, and no arrow or THIS WAY", () => {
		render(<MeetingSign clubName="THR Speaking Club" arrow={null} />);
		expect(screen.getByTestId("sign-club-name").textContent).toBe(
			"THR SPEAKING CLUB",
		);
		expect(screen.getByText("MEETING")).toBeTruthy();
		expect(screen.getByText("Guests Welcome")).toBeTruthy();
		expect(
			screen.getByText("Please come in and find your voice."),
		).toBeTruthy();
		expect(screen.queryByText("THIS WAY")).toBeNull();
		expect(screen.queryByTestId("sign-arrow")).toBeNull();
	});

	it.each([
		"left",
		"right",
	] as const)("with arrow %s: THIS WAY and an arrow pointing that way replace the guests text", (arrow) => {
		render(<MeetingSign clubName="THR Speaking Club" arrow={arrow} />);
		expect(screen.getByText("THIS WAY")).toBeTruthy();
		const svg = screen.getByTestId("sign-arrow");
		expect(svg.getAttribute("data-direction")).toBe(arrow);
		expect(svg.getAttribute("aria-label")).toBe(`Arrow pointing ${arrow}`);
		expect(screen.queryByText("Guests Welcome")).toBeNull();
		expect(
			screen.queryByText("Please come in and find your voice."),
		).toBeNull();
	});

	it("the two arrows are different shapes (not one glyph mirrored by label alone)", () => {
		const { unmount } = render(<MeetingSign clubName="X" arrow="left" />);
		const left = screen.getByTestId("sign-arrow").innerHTML;
		unmount();
		render(<MeetingSign clubName="X" arrow="right" />);
		expect(screen.getByTestId("sign-arrow").innerHTML).not.toBe(left);
	});

	it("steps the club name down past 28 characters, and clamps it to two lines", () => {
		const { unmount } = render(
			<MeetingSign clubName={"A".repeat(28)} arrow={null} />,
		);
		expect(screen.getByTestId("sign-club-name").style.fontSize).toBe("54px");
		unmount();
		render(
			<MeetingSign
				clubName="Downtown Lunchtime Communicators Society"
				arrow={null}
			/>,
		);
		const name = screen.getByTestId("sign-club-name");
		expect(name.style.fontSize).toBe("40px");
		// jsdom drops vendor-prefixed longhands it does not know; the clamp and the
		// anywhere-wrap are pinned by the browser suite, and read here off the
		// attribute so a deleted clamp is still seen.
		const css = name.getAttribute("style") ?? "";
		expect(css).toContain("line-clamp: 2");
		expect(css).toContain("overflow-wrap: anywhere");
	});

	it("carries the logo as a decorative image", () => {
		const { container } = render(<MeetingSign clubName="X" arrow={null} />);
		const img = container.querySelector("img");
		expect(img).not.toBeNull();
		expect(img?.getAttribute("alt")).toBe("");
		expect(img?.getAttribute("src")).toMatch(/ToastmastersLogo3Color/);
	});
});
