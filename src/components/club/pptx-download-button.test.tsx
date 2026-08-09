// @vitest-environment jsdom
/**
 * `fetchClubLogo` — the client-side logo fetch behind the .pptx export (#496).
 *
 * It shipped with no tests at all, which mattered for two reasons. Its own
 * comment calls it "deliberately best-effort" and says it swallows every
 * error — a claim nothing checked, on a function whose three failure paths all
 * silently return null. And it had no timeout: the export's
 * `finally { setBusy(false) }` only runs once this settles, so a fetch that
 * never resolved left the button spinning and permanently disabled with no way
 * back short of a page reload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// downloadDeckPptx (#541) dynamic-imports pptxgenjs + deck-to-pptx and shows a
// sonner toast on failure. Mocked file-wide so its tests never touch the real
// ~1 MB library — harmless to the fetchClubLogo tests above, which never
// import sonner, deck-to-pptx or pptxgenjs.
const { toastError, writeFile, deckToPptx } = vi.hoisted(() => {
	const writeFile = vi.fn(async () => "ok");
	return {
		toastError: vi.fn(),
		writeFile,
		deckToPptx: vi.fn(() => ({ writeFile })),
	};
});
vi.mock("sonner", () => ({ toast: { error: toastError } }));
vi.mock("#/lib/deck-to-pptx", () => ({
	deckToPptx,
	pptxFileName: (club: string) => `${club} - 2026-08-10 Agenda.pptx`,
}));
vi.mock("pptxgenjs", () => ({ default: class Fake {} }));

import type { Slide } from "#/lib/agenda-slides";
import {
	downloadDeckPptx,
	fetchClubLogo,
	LOGO_FETCH_TIMEOUT_MS,
} from "./pptx-download-button";

const URL_ = "/api/club/abc/logo?v=1";

/** jsdom has no `createImageBitmap`; the real browser reads the size there. */
function stubBitmap(width: number, height: number) {
	vi.stubGlobal(
		"createImageBitmap",
		vi.fn(async () => ({ width, height, close: vi.fn() })),
	);
}

function okResponse() {
	return { ok: true, blob: async () => new Blob(["x"], { type: "image/png" }) };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("fetchClubLogo (#496)", () => {
	it("returns null without fetching when the club has no logo", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		expect(await fetchClubLogo(null)).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("returns the data URI and the image's intrinsic size", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => okResponse()),
		);
		stubBitmap(1200, 300);
		const logo = await fetchClubLogo(URL_);
		expect(logo?.dataUri).toMatch(/^data:/);
		// The dimensions are the whole reason this measures at all — deck-to-pptx
		// cannot preserve aspect ratio without them.
		expect(logo?.width).toBe(1200);
		expect(logo?.height).toBe(300);
	});

	it("returns null on a non-ok response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false })),
		);
		stubBitmap(10, 10);
		expect(await fetchClubLogo(URL_)).toBeNull();
	});

	it("returns null instead of throwing when the fetch rejects", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network");
			}),
		);
		stubBitmap(10, 10);
		await expect(fetchClubLogo(URL_)).resolves.toBeNull();
	});

	it("returns null when the image cannot be measured", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => okResponse()),
		);
		vi.stubGlobal(
			"createImageBitmap",
			vi.fn(async () => {
				throw new Error("undecodable");
			}),
		);
		await expect(fetchClubLogo(URL_)).resolves.toBeNull();
	});

	it("returns null when the browser has no createImageBitmap", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => okResponse()),
		);
		vi.stubGlobal("createImageBitmap", undefined);
		expect(await fetchClubLogo(URL_)).toBeNull();
	});

	it("returns null when a measured image reports zero dimensions", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => okResponse()),
		);
		stubBitmap(0, 0);
		expect(await fetchClubLogo(URL_)).toBeNull();
	});

	// The finding this file exists for: without the AbortController the promise
	// below never settles, so the caller's `finally` never runs and the download
	// button stays disabled forever.
	it("gives up on a stalled fetch instead of hanging the export", async () => {
		vi.useFakeTimers();
		let aborted = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init: { signal: AbortSignal }) =>
					new Promise((_resolve, reject) => {
						init.signal.addEventListener("abort", () => {
							aborted = true;
							reject(new DOMException("Aborted", "AbortError"));
						});
					}),
			),
		);
		stubBitmap(10, 10);

		const pending = fetchClubLogo(URL_);
		await vi.advanceTimersByTimeAsync(LOGO_FETCH_TIMEOUT_MS + 1);

		expect(aborted).toBe(true);
		await expect(pending).resolves.toBeNull();
	});

	// The abort signal only reaches `fetch`. `createImageBitmap` runs after it and
	// is bounded by nothing, so before the deadline wrapped the WHOLE operation a
	// decode that never settled left the button stuck just as surely as a stalled
	// network call — the same failure, one step later.
	it("gives up when the image decode never settles, not just the fetch", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => okResponse()),
		);
		vi.stubGlobal(
			"createImageBitmap",
			vi.fn(() => new Promise(() => {})), // never resolves, never rejects
		);

		const pending = fetchClubLogo(URL_);
		await vi.advanceTimersByTimeAsync(LOGO_FETCH_TIMEOUT_MS + 1);

		await expect(pending).resolves.toBeNull();
	});

	// Real timers here: this path reaches FileReader, and jsdom's implementation
	// never completes while vitest's fake timers are installed.
	it("does not leave the abort timer armed after a successful fetch", async () => {
		const clearSpy = vi.spyOn(globalThis, "clearTimeout");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => okResponse()),
		);
		stubBitmap(64, 64);
		await fetchClubLogo(URL_);
		expect(clearSpy).toHaveBeenCalled();
	});
});

describe("downloadDeckPptx (#541)", () => {
	beforeEach(() => {
		// The outer `afterEach` above calls `restoreAllMocks()`, which wipes the
		// implementation off every `vi.fn()` in the file — including these two
		// module-level mocks set up once via `vi.hoisted`. Put the baseline back
		// before each test rather than relying on it surviving from module load.
		deckToPptx.mockImplementation(() => ({ writeFile }));
		writeFile.mockImplementation(async () => "ok");
	});

	const titleSlide = {
		kind: "title",
		clubName: "Harbor City Speakers",
		logoUrl: null,
		district: null,
		clubNumber: null,
		meetingNumber: null,
		scheduledAt: new Date("2026-08-11T03:00:00.000Z"),
		timezone: "America/Los_Angeles",
	} as unknown as Slide;

	it("names the file from the title slide", async () => {
		await downloadDeckPptx({ deck: [titleSlide], clubName: "HCS" });
		expect(writeFile).toHaveBeenCalledWith({
			fileName: "HCS - 2026-08-10 Agenda.pptx",
		});
	});

	it("falls back when the deck has no title slide", async () => {
		await downloadDeckPptx({ deck: [], clubName: "HCS" });
		expect(writeFile).toHaveBeenCalledWith({ fileName: "HCS Agenda.pptx" });
	});

	it("resolves (never rejects) and toasts when the build throws", async () => {
		deckToPptx.mockImplementationOnce(() => {
			throw new Error("boom");
		});
		await expect(
			downloadDeckPptx({ deck: [titleSlide], clubName: "HCS" }),
		).resolves.toBeUndefined();
		expect(toastError).toHaveBeenCalled();
	});
});
