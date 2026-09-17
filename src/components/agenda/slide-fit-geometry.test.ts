import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fitScale } from "#/lib/slide-fit";
import { CHROME_TEST_TIMEOUT_MS, findChrome } from "#/test/print-page-count";

/**
 * Whether a shrunk slide body actually lands inside its box (#767).
 *
 * `slide-fit.test.ts` pins the arithmetic; this pins what the arithmetic is FOR,
 * which jsdom cannot see because it does no layout. The body box is a flex
 * column with `justify-content: center` and uneven padding (4cqw above, 1.5cqw
 * below), and the body scales about its own centre. Whether a given scale keeps
 * the last line off the footer rule is a question for a layout engine, and the
 * answer turned out to depend on the padding the old formula ignored.
 *
 * The fixture reproduces the measured 1280×720 box in plain px, and a pre-fix
 * CONTROL rendered beside it — scaled the old way, by the padding box — must
 * overflow. Without the control, a fixture that could never overflow would
 * pass these assertions for any scale at all.
 */
const hasChrome = findChrome() !== null;

const BOX = {
	clientWidth: 1280,
	clientHeight: 457,
	paddingTop: 51.2,
	paddingRight: 102.4,
	paddingBottom: 19.2,
	paddingLeft: 102.4,
};
const BODY = { width: 1075.2, height: 523 };

/** The scale #767 shipped: the padding box, not the content box. */
const PRE_FIX_SCALE = Math.min(
	1,
	BOX.clientWidth / BODY.width,
	BOX.clientHeight / BODY.height,
);

function box(id: string, scale: number): string {
	return `<div id="${id}" style="box-sizing:border-box;width:${BOX.clientWidth}px;height:${BOX.clientHeight}px;padding:${BOX.paddingTop}px ${BOX.paddingRight}px ${BOX.paddingBottom}px ${BOX.paddingLeft}px;display:flex;flex-direction:column;justify-content:center;overflow:hidden;margin-bottom:40px">
	<div class="inner" style="width:100%;transform:scale(${scale})"><div style="height:${BODY.height}px"></div></div>
</div>`;
}

type Placement = {
	/** Content-box top edge to the scaled body's top, in px. Negative = overflow. */
	topGap: number;
	/** Scaled body's bottom to the content-box bottom edge. Negative = overflow. */
	bottomGap: number;
	clientHeight: number;
	naturalHeight: number;
};

function measure(ids: readonly string[], html: string): Placement[] {
	const chrome = findChrome();
	if (!chrome) throw new Error("No Chrome");
	const probe = `<script>
	document.title = ${JSON.stringify(ids)}.map(function (id) {
		var o = document.getElementById(id);
		var n = o.querySelector(".inner");
		var cs = getComputedStyle(o);
		var ob = o.getBoundingClientRect();
		var r = n.getBoundingClientRect();
		return [
			r.top - (ob.top + parseFloat(cs.paddingTop)),
			ob.bottom - parseFloat(cs.paddingBottom) - r.bottom,
			o.clientHeight,
			n.scrollHeight,
		].join(",");
	}).join("|");
	</script>`;
	const dir = mkdtempSync(join(tmpdir(), "slide-fit-"));
	try {
		const path = join(dir, "page.html");
		writeFileSync(
			path,
			`<!doctype html><html><head><title>x</title><style>body{margin:0}</style></head><body>${html}${probe}</body></html>`,
			"utf8",
		);
		const dom = execFileSync(
			chrome,
			[
				"--headless",
				"--disable-gpu",
				"--no-sandbox",
				`--user-data-dir=${dir}`,
				"--disable-extensions",
				"--host-resolver-rules=MAP * ~NOTFOUND",
				"--window-size=1400,1200",
				"--virtual-time-budget=2000",
				"--dump-dom",
				`file://${path}`,
			],
			{ encoding: "utf8", stdio: "pipe", timeout: 10_000 },
		);
		const title = dom.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
		const rows = title.split("|");
		if (rows.length !== ids.length) {
			throw new Error(`The probe did not run; Chrome reported "${title}".`);
		}
		return rows.map((row) => {
			const [topGap, bottomGap, clientHeight, naturalHeight] = row
				.split(",")
				.map(Number);
			return {
				topGap: topGap ?? Number.NaN,
				bottomGap: bottomGap ?? Number.NaN,
				clientHeight: clientHeight ?? Number.NaN,
				naturalHeight: naturalHeight ?? Number.NaN,
			};
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("slide-fit harness availability", () => {
	it("has a browser to measure with when running in CI", () => {
		if (!process.env.CI) return;
		expect(
			hasChrome,
			"CI has no Chrome, so the slide-fit geometry would skip and the suite " +
				"would still report green.",
		).toBe(true);
	});
});

describe.skipIf(!hasChrome)(
	"a shrunk slide body stays inside its box (#767)",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		it("keeps the last line off the footer, where the old scale did not", () => {
			const scale = fitScale(BOX, BODY);
			const [fixed, control] = measure(
				["fixed", "control"],
				box("fixed", scale) + box("control", PRE_FIX_SCALE),
			);
			if (!fixed || !control) throw new Error("missing measurement");

			// The fixture is the box `fitScale` was told about. If these drift, the
			// scale below was computed for a different box than the one measured.
			expect(fixed.clientHeight).toBe(BOX.clientHeight);
			expect(fixed.naturalHeight).toBe(BODY.height);
			// Not vacuous: this body really is too tall and really was shrunk.
			expect(scale).toBeLessThan(1);

			// The control reproduces #767: the body spills past the bottom edge.
			expect(control.bottomGap).toBeLessThan(-10);

			// Half a pixel of tolerance for sub-pixel rounding of the transform.
			expect(fixed.bottomGap).toBeGreaterThanOrEqual(-0.5);
			expect(fixed.topGap).toBeGreaterThanOrEqual(-0.5);
		});
	},
);
