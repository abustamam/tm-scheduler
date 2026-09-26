import { describe, expect, it } from "vitest";
import { qrRuns } from "./qr-runs";

describe("qrRuns (#932)", () => {
	const url = "https://gavelup.app/club/mcf/meeting/2026-07-09";
	const { size, runs } = qrRuns(url);

	it("reads a real QR grid back out of QRCodeSVG's markup", () => {
		// A QR symbol is 21 + 4k modules a side.
		expect(size).toBeGreaterThanOrEqual(21);
		expect((size - 21) % 4).toBe(0);
		expect(runs.length).toBeGreaterThan(50);
		for (const r of runs) {
			expect(r.x + r.w).toBeLessThanOrEqual(size);
			expect(r.y).toBeLessThan(size);
		}
	});

	it("finds the three finder patterns, so the path format is the one parsed", () => {
		// Row 0: a 7-wide run at each top corner. Row size-1: one at bottom-left.
		const at = (y: number, x: number) =>
			runs.some((r) => r.y === y && r.x === x && r.w === 7);
		expect(at(0, 0)).toBe(true);
		expect(at(0, size - 7)).toBe(true);
		expect(at(size - 1, 0)).toBe(true);
	});

	it("encodes different URLs differently", () => {
		expect(qrRuns(`${url}-1830`).runs).not.toEqual(runs);
	});
});
