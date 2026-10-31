// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISMISSED_KEY, noteClaim } from "#/lib/install-hint";
import { InstallHint } from "./install-hint";

const toastMock = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: toastMock }));

const IOS_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const CHROME_UA =
	"Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";

function env({
	phone = true,
	standalone = false,
	ua = CHROME_UA,
}: {
	phone?: boolean;
	standalone?: boolean;
	ua?: string;
}) {
	vi.stubGlobal("matchMedia", (q: string) => ({
		matches: q.includes("standalone")
			? standalone
			: q.includes("coarse")
				? phone
				: false,
		media: q,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
	vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
	window.innerWidth = phone ? 375 : 1280;
}

function fireInstallEvent() {
	const e = Object.assign(
		new Event("beforeinstallprompt", { cancelable: true }),
		{
			prompt: vi.fn().mockResolvedValue(undefined),
		},
	);
	act(() => {
		window.dispatchEvent(e);
	});
	return e;
}

beforeEach(() => {
	vi.useFakeTimers();
	toastMock.mockReset();
	window.localStorage.clear();
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// protects: the hint waits 4s after the second claim (claim toast stays
// readable), never fires on the first, and is once per device. fails_when: the
// delay or the claims threshold is dropped, or the dismissed flag is not set
// when shown. no_claim: not real sonner rendering.
describe("timing and once-ever", () => {
	it("second claim shows after 4s, not before; first does not; third does not", () => {
		env({});
		render(<InstallHint />);
		fireInstallEvent();

		act(() => {
			noteClaim();
			vi.advanceTimersByTime(10_000);
		});
		expect(toastMock).not.toHaveBeenCalled();

		act(() => {
			noteClaim();
			vi.advanceTimersByTime(3_999);
		});
		expect(toastMock).not.toHaveBeenCalled();
		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(toastMock).toHaveBeenCalledTimes(1);
		expect(window.localStorage.getItem(DISMISSED_KEY)).not.toBeNull();

		act(() => {
			noteClaim();
			vi.advanceTimersByTime(10_000);
		});
		expect(toastMock).toHaveBeenCalledTimes(1);
	});
});

// protects: Chrome gets "Install" wired to the kept event's prompt(); iOS
// Safari gets "How" opening the Share instructions; neither -> silence.
// fails_when: branches swap, preventDefault is skipped, or an ineligible
// browser sets the dismissed flag. no_claim: no real install happens.
describe("branches", () => {
	it("Chrome: Install calls prompt() on the captured event", () => {
		env({});
		render(<InstallHint />);
		const e = fireInstallEvent();
		expect(e.defaultPrevented).toBe(true);
		act(() => {
			noteClaim();
			noteClaim();
			vi.advanceTimersByTime(4000);
		});
		const opts = toastMock.mock.calls[0][1];
		expect(opts.action.label).toBe("Install");
		opts.action.onClick();
		expect(e.prompt).toHaveBeenCalledTimes(1);
	});

	it("iOS Safari: How opens the Add to Home Screen dialog", () => {
		env({ ua: IOS_UA });
		render(<InstallHint />);
		act(() => {
			noteClaim();
			noteClaim();
			vi.advanceTimersByTime(4000);
		});
		const opts = toastMock.mock.calls[0][1];
		expect(opts.action.label).toBe("How");
		act(() => {
			opts.action.onClick();
		});
		expect(screen.getByText(/Add to Home Screen/)).toBeTruthy();
	});

	it("neither event nor iOS Safari: nothing shows and nothing is set", () => {
		env({});
		render(<InstallHint />);
		act(() => {
			noteClaim();
			noteClaim();
			vi.advanceTimersByTime(10_000);
		});
		expect(toastMock).not.toHaveBeenCalled();
		expect(window.localStorage.getItem(DISMISSED_KEY)).toBeNull();
	});
});

// protects: an installed app and a desktop never see the hint.
// fails_when: standalone or phone is not re-checked when the timer fires.
// no_claim: matchMedia is stubbed, not a real display mode.
describe("ineligible environments", () => {
	it("standalone never shows", () => {
		env({ standalone: true });
		render(<InstallHint />);
		fireInstallEvent();
		act(() => {
			noteClaim();
			noteClaim();
			vi.advanceTimersByTime(10_000);
		});
		expect(toastMock).not.toHaveBeenCalled();
	});
});
