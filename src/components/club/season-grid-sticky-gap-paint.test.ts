/**
 * The sign-up sheet's sticky label column paints its own colour in the 4px
 * border-spacing gap (#1302), measured in PIXELS.
 *
 * `season-grid.test.tsx` pins the class strings (jsdom paints nothing). This
 * renders the real class strings, read out of `season-grid.tsx`, in headless
 * Chrome, scrolls the table so strongly-coloured cells slide under the label
 * column, takes a screenshot and compares pixels in the gap against the pixel
 * at the centre of the label cell:
 *
 * - right gap: between the label cell and the scrolled cells (the #1302 bleed);
 * - bottom gap: between this row's label cell and the next row's, where the
 *   NEXT row's spread competes for paint order. A hovered or self row must win
 *   it, or its fill sits in a frame of another colour.
 *
 * The hovered state is modelled by stripping the `group-hover:` prefixes from
 * the source class string (a screenshot cannot hover), so it is the shipped
 * hover utilities that are measured, not copies.
 *
 * Light theme only: dark reuses the same tokens through the same utilities.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { twMerge } from "tailwind-merge";
import { beforeAll, describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";
import { buildAppCss, candidatesIn } from "#/test/pinned-column-scroll";
import {
	CHROME_ENV,
	CHROME_TEST_TIMEOUT_MS,
	findChrome,
} from "#/test/print-page-count";

const GRID = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"season-grid.tsx",
);
const hasChrome = findChrome() !== null;

function literal(fragment: string): string {
	const hit = [...readSource(GRID).matchAll(/"([^"\n]*)"/g)]
		.map((m) => m[1] as string)
		.find((c) => c.includes(fragment));
	if (!hit) throw new Error(`\`${fragment}\` not found in season-grid.tsx`);
	return hit;
}

const ROW = literal("group-hover:z-[11] bg-card");
const SELF = literal("z-[11] bg-[color-mix");
const TABLE = literal("border-separate border-spacing-1");
const BASE =
	"sticky left-0 z-10 w-36 max-w-36 px-3 py-1 text-left text-xs font-semibold";
// A screenshot cannot hover: the hovered row is the same string, hover applied.
const HOVERED = ROW.replace(/group-hover:/g, "");

type Probe = { rect: { l: number; r: number; t: number; b: number }[] };

describe.skipIf(!hasChrome)(
	"sticky label column paints its colour in the gap (#1302)",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		let png: PNG;
		let probe: Probe;

		const th = (cls: string, i: number) =>
			`<th class="${twMerge(BASE, cls)}">Member ${i}</th>`;
		// Row 0 is the one under test; row 1 sits below it with the default fill.
		const page = (cls: string) => {
			const cell = `<td class="p-0"><div style="width:90px;height:32px;background:rgb(220,0,0)"></div></td>`;
			const tr = (h: string) => `<tr class="group">${h}${cell.repeat(6)}</tr>`;
			return `<div id="s" style="width:375px;overflow:auto;background:white"><table class="${TABLE}">${tr(th(cls, 0))}${tr(th(ROW, 1))}${tr(th(ROW, 2))}</table></div>`;
		};

		const shoot = async (cls: string) => {
			const html = page(cls);
			const css = await buildAppCss([...candidatesIn(html), "flex"]);
			const dir = mkdtempSync(join(tmpdir(), "sticky-gap-"));
			try {
				writeFileSync(join(dir, "app.css"), css);
				writeFileSync(
					join(dir, "page.html"),
					`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head><body style="margin:0">${html}<script>
document.getElementById("s").scrollLeft = 90;
setTimeout(()=>{
 const r=[...document.querySelectorAll("th")].map(e=>{const b=e.getBoundingClientRect();return {l:b.left,r:b.right,t:b.top,b:b.bottom}});
 document.title=JSON.stringify({rect:r});
},200);</script></body></html>`,
				);
				const shot = join(dir, "out.png");
				const url = `file://${join(dir, "page.html")}`;
				const args = [
					"--headless",
					"--disable-gpu",
					"--no-sandbox",
					`--user-data-dir=${dir}`,
					"--window-size=500,400",
					"--force-device-scale-factor=1",
					"--virtual-time-budget=3000",
					"--host-resolver-rules=MAP * ~NOTFOUND",
				];
				const chrome = findChrome() as string;
				const opts = {
					encoding: "utf8" as const,
					env: CHROME_ENV,
					timeout: 30_000,
					stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
				};
				const dom = execFileSync(chrome, [...args, "--dump-dom", url], opts);
				probe = JSON.parse(
					/<title>([^<]*)<\/title>/.exec(dom)?.[1]?.replace(/&quot;/g, '"') ??
						"{}",
				);
				execFileSync(chrome, [...args, `--screenshot=${shot}`, url], opts);
				png = PNG.sync.read(readFileSync(shot));
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		};

		const px = (x: number, y: number): [number, number, number] => {
			const i = (png.width * Math.round(y) + Math.round(x)) * 4;
			return [
				png.data[i] as number,
				png.data[i + 1] as number,
				png.data[i + 2] as number,
			];
		};
		const close = (a: number[], b: number[]) =>
			a.every((v, i) => Math.abs(v - (b[i] as number)) <= 3);

		beforeAll(() => {});

		it.each([
			["at rest", ROW],
			["hovered", HOVERED],
			["self row", SELF],
		])("%s: the right and bottom gaps match the cell fill", async (_n, cls) => {
			await shoot(cls);
			const c = probe.rect[0] as Probe["rect"][number];
			const fill = px((c.l + c.r) / 2, (c.t + c.b) / 2);
			// right gap, mid-height: the scrolled red cells slide under here. The
			// edge shadow darkens it a little, so assert "not the red cell".
			const right = px(c.r + 1.5, (c.t + c.b) / 2);
			expect(
				right[1],
				`right gap ${right} shows the scrolled cell`,
			).toBeGreaterThan(150);
			// bottom gap, left of the cell centre so the edge shadow is not sampled
			const bottom = px(c.l + 20, c.b + 2);
			expect(close(bottom, fill), `bottom gap ${bottom} vs fill ${fill}`).toBe(
				true,
			);
		});

		it("control: with the spreads removed the right gap shows the scrolled cells", async () => {
			await shoot(ROW.replace(/,0_0_0_4px_var\(--(card|muted)\)/g, ""));
			const c = probe.rect[0] as Probe["rect"][number];
			const right = px(c.r + 1.5, (c.t + c.b) / 2);
			expect(right[1]).toBeLessThan(100);
		});
	},
);
