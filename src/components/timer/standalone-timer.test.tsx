// @vitest-environment jsdom
//
// The public `/timer` page (#1248), rendered as a visitor sees it, against a
// fake wall clock. `timerSignal` is NOT mocked: the transitions asserted here
// are the shared helper's, reached through the page.
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StandaloneTimer } from "./standalone-timer";
import { parseMark, validateMarks } from "./timer-presets";

const T0 = new Date("2026-10-19T12:00:00Z").getTime();
let clock = T0;

const click = async (el: HTMLElement) => {
	await act(async () => {
		fireEvent.click(el);
	});
};
const type = async (label: RegExp, value: string) => {
	await act(async () => {
		fireEvent.change(screen.getByLabelText(label), { target: { value } });
	});
};
/** Move the wall clock to `ms` after the start and let one repaint tick fire. */
async function at(ms: number) {
	clock = T0 + ms;
	await act(async () => {
		vi.setSystemTime(new Date(clock - 200));
		await vi.advanceTimersByTimeAsync(200);
	});
}
const band = () =>
	document.querySelector("[data-band]")?.getAttribute("data-band");
const field = (label: RegExp) =>
	(screen.getByLabelText(label) as HTMLInputElement).value;
const preset = (name: string) => screen.getByRole("button", { name });

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(T0));
	clock = T0;
	window.localStorage.clear();
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const PRESETS = [
	["Ice Breaker", "4:00", "5:00", "6:00", "6:30"],
	["Speech", "5:00", "6:00", "7:00", "7:30"],
	["Table Topics", "1:00", "1:30", "2:00", "2:30"],
	["Evaluation", "2:00", "2:30", "3:00", "3:30"],
] as const;

describe("presets fill the three fields", () => {
	for (const [name, g, y, r, dq] of PRESETS) {
		it(`${name}: ${g} / ${y} / ${r}, disqualified after ${dq}`, async () => {
			render(<StandaloneTimer />);
			await click(preset(name));
			expect(field(/^Green/)).toBe(g);
			expect(field(/^Yellow/)).toBe(y);
			expect(field(/^Red/)).toBe(r);
			expect(screen.getByText(`Disqualified after ${dq}`)).toBeTruthy();
			expect(preset(name).getAttribute("aria-pressed")).toBe("true");
		});
	}

	it("editing a field switches to Custom and keeps the edited values", async () => {
		render(<StandaloneTimer />);
		await click(preset("Ice Breaker"));
		await type(/^Green/, "3:30");
		expect(preset("Custom").getAttribute("aria-pressed")).toBe("true");
		expect(preset("Ice Breaker").getAttribute("aria-pressed")).toBe("false");
		expect(field(/^Green/)).toBe("3:30");
		expect(field(/^Yellow/)).toBe("5:00");
	});
});

describe("band transitions, through the page", () => {
	const run = async (
		name: string,
		g: number,
		y: number,
		r: number,
		custom?: [string, string, string],
	) => {
		render(<StandaloneTimer />);
		if (custom) {
			await type(/^Green/, custom[0]);
			await type(/^Yellow/, custom[1]);
			await type(/^Red/, custom[2]);
		} else {
			await click(preset(name));
		}
		await click(screen.getByRole("button", { name: "Start" }));
		const s = 1000;
		await at(g * s - 1);
		expect(band()).toBe("under");
		await at(g * s);
		expect(band()).toBe("green");
		await at(y * s - 1);
		expect(band()).toBe("green");
		await at(y * s);
		expect(band()).toBe("yellow");
		await at(r * s - 1);
		expect(band()).toBe("yellow");
		await at(r * s);
		expect(band()).toBe("red");
		// Disqualification: red at red + 0:30, over 1 ms later.
		await at((r + 30) * s);
		expect(band()).toBe("red");
		await at((r + 30) * s + 1);
		expect(band()).toBe("over");
	};

	for (const [name, g, y, r] of [
		["Ice Breaker", 240, 300, 360],
		["Speech", 300, 360, 420],
		["Table Topics", 60, 90, 120],
		["Evaluation", 120, 150, 180],
	] as const) {
		it(`${name}`, () => run(name, g, y, r));
	}

	it("Custom", () => run("Custom", 90, 150, 200, ["1:30", "2:30", "3:20"]));
});

describe("validation", () => {
	for (const [label, g, y, r] of [
		["equal marks", "2:00", "2:00", "3:00"],
		["descending marks", "3:00", "2:00", "1:00"],
		["zero green", "0:00", "1:00", "2:00"],
	] as const) {
		it(`${label}: inline message, no clock, no run`, async () => {
			render(<StandaloneTimer />);
			await type(/^Green/, g);
			await type(/^Yellow/, y);
			await type(/^Red/, r);
			expect(screen.getByRole("alert")).toBeTruthy();
			// No clock card at all: nothing stale to read, nothing to start.
			expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
			expect(document.querySelector("[data-band]")).toBeNull();
			expect(screen.queryByText(/Green \d/)).toBeNull();
			expect(screen.queryByText(/Disqualified after/)).toBeNull();
		});
	}

	it("text that is not m:ss is refused", async () => {
		render(<StandaloneTimer />);
		await type(/^Green/, "abc");
		expect(screen.getByRole("alert").textContent).toMatch(
			/minutes and seconds/,
		);
	});

	it("bare digits are accepted, so the numeric keypad can type a mark", async () => {
		render(<StandaloneTimer />);
		await type(/^Green/, "100");
		await type(/^Yellow/, "130");
		await type(/^Red/, "200");
		expect(screen.queryByRole("alert")).toBeNull();
		await click(screen.getByRole("button", { name: "Start" }));
		await at(60 * 1000);
		expect(band()).toBe("green");
		await at(120 * 1000);
		expect(band()).toBe("red");
	});
});

describe("parseMark", () => {
	it.each([
		["500", 300],
		["45", 45],
		["5", 5],
		["05", 5],
		["1030", 630],
		["5:00", 300],
		["0:45", 45],
		["  500 ", 300],
	])("%s is %i seconds", (text, sec) => {
		expect(parseMark(text)).toBe(sec);
	});
	it.each([
		"75",
		"560",
		"",
		"abc",
		"5:7",
		"1:2:3",
		"123456",
		"-5",
	])("%s is refused", (text) => {
		expect(parseMark(text)).toBeNull();
	});
	it("still rejects a non-ascending set typed as digits", () => {
		expect(validateMarks({ green: "500", yellow: "400", red: "700" }).ok).toBe(
			false,
		);
	});
});

describe("running", () => {
	it("locks the fields and presets from Start until Reset", async () => {
		render(<StandaloneTimer />);
		const locked = () => [
			...[/^Green/, /^Yellow/, /^Red/].map(
				(l) => (screen.getByLabelText(l) as HTMLInputElement).disabled,
			),
			...["Ice Breaker", "Speech", "Table Topics", "Evaluation", "Custom"].map(
				(n) => (preset(n) as HTMLButtonElement).disabled,
			),
		];
		expect(locked().every((d) => !d)).toBe(true);
		await click(screen.getByRole("button", { name: "Start" }));
		expect(locked().every(Boolean)).toBe(true);
		await at(1000);
		await click(screen.getByRole("button", { name: "Pause" }));
		expect(locked().every(Boolean)).toBe(true);
		await click(screen.getByRole("button", { name: "Reset" }));
		expect(locked().every((d) => !d)).toBe(true);
	});

	it("a preset tapped mid-speech changes nothing", async () => {
		render(<StandaloneTimer />);
		await click(screen.getByRole("button", { name: "Start" }));
		await at(310 * 1000);
		expect(band()).toBe("green");
		await click(preset("Table Topics"));
		expect(field(/^Red/)).toBe("7:00");
		expect(band()).toBe("green");
	});

	it("scrolls the colour block into view on Start", async () => {
		const scroll = vi.fn();
		Element.prototype.scrollIntoView = scroll;
		render(<StandaloneTimer />);
		await click(screen.getByRole("button", { name: "Start" }));
		expect(scroll).toHaveBeenCalledTimes(1);
	});

	it("makes no network request", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		render(<StandaloneTimer />);
		await click(screen.getByRole("button", { name: "Start" }));
		await at(8000 * 1000);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("Show clock", () => {
	it("hides the digits only: the band still changes, nothing starts or stops", async () => {
		render(<StandaloneTimer />);
		await click(screen.getByRole("button", { name: "Start" }));
		await at(1000);
		expect(document.querySelector("output")).not.toBeNull();
		await click(screen.getByLabelText("Show clock"));
		expect(document.querySelector("output")).toBeNull();
		// Still running: Pause is offered, and the band moves on schedule.
		expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
		expect(band()).toBe("under");
		await at(300 * 1000);
		expect(band()).toBe("green");
		await click(screen.getByLabelText("Show clock"));
		expect(document.querySelector("output")?.textContent).toBe("5:00");
	});
});

describe("Show clock while not running", () => {
	it("does not start an idle or paused clock", async () => {
		render(<StandaloneTimer />);
		await click(screen.getByLabelText("Show clock"));
		await click(screen.getByLabelText("Show clock"));
		expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
		await click(screen.getByRole("button", { name: "Start" }));
		await at(1000);
		await click(screen.getByRole("button", { name: "Pause" }));
		await click(screen.getByLabelText("Show clock"));
		await click(screen.getByLabelText("Show clock"));
		expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
		await at(60 * 1000);
		expect(document.querySelector("output")?.textContent).toBe("0:01");
	});
});

describe("remembering", () => {
	it.each([
		[
			"unknown selection",
			{
				selection: "nope",
				fields: { green: "1:00", yellow: "2:00", red: "3:00" },
				showClock: true,
			},
		],
		[
			"non-string field",
			{
				selection: "custom",
				fields: { green: 1, yellow: "2:00", red: "3:00" },
				showClock: true,
			},
		],
		[
			"non-boolean showClock",
			{
				selection: "custom",
				fields: { green: "1:00", yellow: "2:00", red: "3:00" },
				showClock: "yes",
			},
		],
		["missing fields", { selection: "custom", showClock: true }],
	])("rejects %s and falls back to the defaults", (_n, stored) => {
		window.localStorage.setItem("gavelup:timer", JSON.stringify(stored));
		render(<StandaloneTimer />);
		expect(field(/^Green/)).toBe("5:00");
		expect(preset("Speech").getAttribute("aria-pressed")).toBe("true");
	});

	it("restores the last selection and Show clock, and survives broken storage", async () => {
		const first = render(<StandaloneTimer />);
		await click(preset("Evaluation"));
		await click(screen.getByLabelText("Show clock"));
		first.unmount();
		render(<StandaloneTimer />);
		expect(preset("Evaluation").getAttribute("aria-pressed")).toBe("true");
		expect(field(/^Red/)).toBe("3:00");
		expect(
			(screen.getByLabelText("Show clock") as HTMLInputElement).checked,
		).toBe(false);
		cleanup();

		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		render(<StandaloneTimer />);
		expect(field(/^Red/)).toBe("7:00");
	});

	it("ignores malformed stored data", () => {
		window.localStorage.setItem("gavelup:timer", "{nope");
		render(<StandaloneTimer />);
		expect(field(/^Green/)).toBe("5:00");
	});
});
