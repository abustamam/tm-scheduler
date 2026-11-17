// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.resetModules();
	vi.doUnmock("canvas-confetti");
});

describe("fireAwardConfetti (#1654)", () => {
	// protects=a failed burst never rejects into the deck's Next handler;
	// fails_when=the call rejects when the confetti call throws; no_claim=real
	// canvas painting.
	it("resolves when the confetti call rejects", async () => {
		const confetti = vi.fn().mockRejectedValue(new Error("canvas lost"));
		vi.doMock("canvas-confetti", () => ({ default: confetti }));
		const { fireAwardConfetti } = await import("./award-confetti");
		await expect(fireAwardConfetti()).resolves.toBeUndefined();
		expect(confetti).toHaveBeenCalledTimes(1);
	});

	// protects=a failed chunk load never breaks the slide; fails_when=the
	// dynamic import's rejection escapes; no_claim=the burst itself.
	it("resolves when the chunk fails to load", async () => {
		vi.doMock("canvas-confetti", () => {
			throw new Error("chunk failed");
		});
		const { fireAwardConfetti } = await import("./award-confetti");
		await expect(fireAwardConfetti()).resolves.toBeUndefined();
	});

	// protects=the burst fires once with reduced motion honoured; fails_when=the
	// option is dropped; no_claim=the library's own media query.
	it("fires one burst that disables itself for reduced motion", async () => {
		const confetti = vi.fn().mockResolvedValue(undefined);
		vi.doMock("canvas-confetti", () => ({ default: confetti }));
		const { fireAwardConfetti } = await import("./award-confetti");
		await fireAwardConfetti();
		expect(confetti).toHaveBeenCalledTimes(1);
		expect(confetti.mock.calls[0][0]).toMatchObject({
			disableForReducedMotion: true,
		});
	});
});
