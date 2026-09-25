// @vitest-environment jsdom
//
// `DistrictShare` (#868): the input, the blurb and link it mints, and the copy
// buttons' clipboard write and toasts.
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { toastSuccess, toastError } = vi.hoisted(() => ({
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: { success: toastSuccess, error: toastError },
}));

import { renderToString } from "react-dom/server";
import { districtShareBlurb } from "#/lib/district-share";
import { DistrictShare } from "./district-share";

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
	toastSuccess.mockReset();
	toastError.mockReset();
	writeText.mockReset();
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
});

afterEach(cleanup);

const origin = () => window.location.origin;
const input = () => screen.getByLabelText("Your district number");
const ERROR = /up to 4 letters or digits/;

describe("DistrictShare (#868)", () => {
	it("with a valid d, prefills the input and renders the blurb and absolute link", async () => {
		render(<DistrictShare d="57" />);
		expect((input() as HTMLInputElement).value).toBe("57");
		const link = `${origin()}/?ref=district-57`;
		await waitFor(() =>
			expect(screen.getByTestId("share-link").textContent).toBe(link),
		);
		expect(screen.getByTestId("share-blurb").textContent).toBe(
			districtShareBlurb(link),
		);
		expect(screen.queryByText(ERROR)).toBeNull();
	});

	it("without d, shows the input only; typing 57 shows the link, typing '5 7!' the error and no link", async () => {
		render(<DistrictShare />);
		expect((input() as HTMLInputElement).value).toBe("");
		expect(screen.queryByTestId("share-link")).toBeNull();
		expect(screen.queryByText(ERROR)).toBeNull();

		fireEvent.change(input(), { target: { value: "57" } });
		await waitFor(() =>
			expect(screen.getByTestId("share-link").textContent).toBe(
				`${origin()}/?ref=district-57`,
			),
		);

		fireEvent.change(input(), { target: { value: "5 7!" } });
		expect(screen.getByText(ERROR)).toBeTruthy();
		expect(input().getAttribute("aria-invalid")).toBe("true");
		expect(screen.queryByTestId("share-link")).toBeNull();
		expect(screen.queryByTestId("share-blurb")).toBeNull();
	});

	it("treats an invalid d from the URL as absent: raw value kept, error shown, no link", () => {
		render(<DistrictShare d="57; drop" />);
		expect((input() as HTMLInputElement).value).toBe("57; drop");
		expect(screen.getByText(ERROR)).toBeTruthy();
		expect(screen.queryByTestId("share-link")).toBeNull();
	});

	// Validated RAW (#868): an invalid d is treated as absent, and padding is
	// not quietly trimmed into a valid one.
	it("treats a padded d and whitespace-only input as invalid, with the error and no link", () => {
		render(<DistrictShare d=" 57 " />);
		expect((input() as HTMLInputElement).value).toBe(" 57 ");
		expect(screen.getByText(ERROR)).toBeTruthy();
		expect(screen.queryByTestId("share-link")).toBeNull();

		fireEvent.change(input(), { target: { value: "   " } });
		expect(screen.getByText(ERROR)).toBeTruthy();
		expect(screen.queryByTestId("share-link")).toBeNull();
	});

	// Client navigation ?d=57 -> ?d=58 re-renders with a new prop, no remount.
	it("follows a changed d prop instead of keeping the first district", async () => {
		const { rerender } = render(<DistrictShare d="57" />);
		await waitFor(() =>
			expect(screen.getByTestId("share-link").textContent).toBe(
				`${origin()}/?ref=district-57`,
			),
		);
		rerender(<DistrictShare d="58" />);
		await waitFor(() =>
			expect(screen.getByTestId("share-link").textContent).toBe(
				`${origin()}/?ref=district-58`,
			),
		);
		expect((input() as HTMLInputElement).value).toBe("58");
	});

	// The server render (and the first client render) has no origin: the link
	// is relative and neither copy button can put it on the clipboard.
	it("renders the SSR output with the relative link and both copy buttons disabled", () => {
		const host = document.createElement("div");
		host.innerHTML = renderToString(<DistrictShare d="57" />);
		const buttons = [...host.querySelectorAll("button")];
		expect(buttons.map((b) => b.textContent)).toEqual([
			"Copy message",
			"Copy link",
		]);
		for (const b of buttons) expect(b.disabled, b.textContent ?? "").toBe(true);
		expect(host.querySelector('[data-testid="share-link"]')?.textContent).toBe(
			"/?ref=district-57",
		);
		expect(host.textContent).not.toMatch(/https?:\/\//);
	});

	it("copies the exact blurb, toasting on success and on a rejected write", async () => {
		render(<DistrictShare d="57" />);
		const copyMessage = screen.getByRole("button", { name: "Copy message" });
		await waitFor(() =>
			expect(copyMessage.hasAttribute("disabled")).toBe(false),
		);
		const blurb = districtShareBlurb(`${origin()}/?ref=district-57`);

		writeText.mockResolvedValueOnce();
		fireEvent.click(copyMessage);
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith(blurb);
		expect(toastError).not.toHaveBeenCalled();

		writeText.mockRejectedValueOnce(new Error("NotAllowedError"));
		fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenLastCalledWith(`${origin()}/?ref=district-57`);
	});
});
