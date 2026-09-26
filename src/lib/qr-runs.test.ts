import { QRCodeSVG } from "qrcode.react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseQrSvg, qrRuns } from "./qr-runs";

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

describe("parseQrSvg is all-or-nothing (#932)", () => {
	const svg = (d: string) =>
		`<svg viewBox="0 0 21 21"><path fill="#FFFFFF" d="M0,0 h21v21H0z"></path><path fill="#000000" d="${d}"></path></svg>`;

	it("reads a path made only of run segments", () => {
		expect(parseQrSvg(svg("M0 0h7v1H0zM8,0 h2v1H8z"))).toEqual({
			size: 21,
			runs: [
				{ x: 0, y: 0, w: 7 },
				{ x: 8, y: 0, w: 2 },
			],
		});
	});

	it("refuses a path with ANY segment it cannot read, rather than drawing holes", () => {
		// One run in a shape the parser does not know, among ones it does.
		expect(parseQrSvg(svg("M0 0h7v1H0zM8 0H10V1H8zM12 0h1v1H12z"))).toBeNull();
		expect(parseQrSvg(svg("M0 0h1v2H0z"))).toBeNull();
	});

	it("refuses markup with no dark path or no size", () => {
		expect(parseQrSvg("<svg></svg>")).toBeNull();
	});

	it("the real encoder's output is consumed whole", () => {
		const markup = renderToStaticMarkup(
			createElement(QRCodeSVG, {
				value: "https://gavelup.app/x",
				marginSize: 0,
			}),
		);
		expect(parseQrSvg(markup)).not.toBeNull();
	});
});
