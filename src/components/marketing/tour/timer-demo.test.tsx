// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimerDemo } from "./timer-demo";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const band = () =>
	(document.querySelector("[data-band]") as HTMLElement).dataset.band;
const click = (name: string) =>
	fireEvent.click(screen.getByRole("button", { name }));
/** Real seconds; the demo runs 20x, so 1s here is 20s on the clock. */
const run = (s: number) => act(() => vi.advanceTimersByTime(s * 1000));

describe("TimerDemo", () => {
	it("shows the role, the real marks and the qualifying window, idle at 0:00", () => {
		render(<TimerDemo />);
		expect(screen.getByText("Speaker 2 · Priya Nair")).toBeTruthy();
		expect(screen.getByText(/Green 5:00/)).toBeTruthy();
		expect(screen.getByText(/Yellow 6:00/)).toBeTruthy();
		expect(screen.getByText(/Red 7:00/)).toBeTruthy();
		expect(screen.getByText("Qualifies 4:30–7:30")).toBeTruthy();
		expect(screen.getByText("0:00")).toBeTruthy();
		expect(screen.getByText("Before green")).toBeTruthy();
		expect(screen.getByText(/20× speed/)).toBeTruthy();
	});

	it("does not tick until Start", () => {
		render(<TimerDemo />);
		run(30);
		expect(screen.getByText("0:00")).toBeTruthy();
	});

	it("crosses green, yellow, red and over at 20x", () => {
		render(<TimerDemo />);
		click("Start");
		run(14);
		expect(band()).toBe("under");
		run(1);
		expect(band()).toBe("green");
		expect(screen.getByText("5:00")).toBeTruthy();
		run(3);
		expect(band()).toBe("yellow");
		run(3);
		expect(band()).toBe("red");
		run(2);
		expect(band()).toBe("over");
		expect(screen.getAllByText("Over time").length).toBeGreaterThan(0);
	});

	it("pauses and resumes without losing time", () => {
		render(<TimerDemo />);
		click("Start");
		run(5);
		expect(screen.getByText("1:40")).toBeTruthy();
		click("Pause");
		run(30);
		expect(screen.getByText("1:40")).toBeTruthy();
		click("Resume");
		run(5);
		expect(screen.getByText("3:20")).toBeTruthy();
	});

	it("stops with a receipt and a verdict, then resets", () => {
		render(<TimerDemo />);
		click("Start");
		run(18.6); // 6:12
		click("Stop");
		expect(screen.getByText("Recorded 6:12 · Qualified")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
		run(10);
		expect(screen.getByText("6:12")).toBeTruthy();
		click("Reset");
		expect(screen.getByText("0:00")).toBeTruthy();
		expect(screen.queryByText(/Recorded/)).toBeNull();
		expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
	});

	it("says a stop before the window did not qualify", () => {
		render(<TimerDemo />);
		click("Start");
		run(5);
		click("Stop");
		expect(screen.getByText("Recorded 1:40 · Under time")).toBeTruthy();
	});

	it("announces the band, not every tick", () => {
		render(<TimerDemo />);
		const status = screen.getByRole("status");
		expect(status.textContent).toBe("");
		click("Start");
		run(2);
		expect(status.textContent).toBe("Before green");
		run(13);
		expect(status.textContent).toBe("Green");
	});

	it("stops its interval on unmount", () => {
		const { unmount } = render(<TimerDemo />);
		const setSpy = vi.spyOn(globalThis, "setInterval");
		const clearSpy = vi.spyOn(globalThis, "clearInterval");
		click("Start");
		expect(setSpy).toHaveBeenCalledTimes(1);
		const id = setSpy.mock.results[0].value;
		expect(clearSpy).not.toHaveBeenCalledWith(id);
		unmount();
		expect(clearSpy).toHaveBeenCalledWith(id);
	});
});
