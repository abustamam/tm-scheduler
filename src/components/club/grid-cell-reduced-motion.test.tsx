import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ViewCell } from "#/lib/season-grid-view";
import { buildAppCss, candidatesIn } from "#/test/pinned-column-scroll";
import { CHROME_TEST_TIMEOUT_MS, findChrome } from "#/test/print-page-count";
import { GridCell } from "./grid-cell";

// The claim moment (#1315) is a 200ms colour transition. DESIGN.md's reduced-
// motion rule (styles.css) must collapse it. jsdom loads no stylesheet, so this
// reads the computed `transition-duration` in headless Chrome, with and without
// `prefers-reduced-motion: reduce`.
const hasChrome = findChrome() !== null;

const cell: ViewCell = {
	meetingId: "m1",
	kind: "open",
	text: "OPEN",
	title: "Timer",
	slotId: "slot-1",
	memberId: null,
};

async function transition(
	reduce: boolean,
): Promise<{ duration: string; timing: string }> {
	const body = renderToStaticMarkup(
		<GridCell
			cell={cell}
			currentMemberId="me"
			pending={{ kind: "claim", name: "Me" }}
			onClaim={() => {}}
		/>,
	);
	const css = await buildAppCss(candidatesIn(body));
	const chrome = findChrome();
	if (!chrome) throw new Error("No Chrome — set CHROME_PATH.");
	const dir = mkdtempSync(join(tmpdir(), "grid-cell-motion-"));
	try {
		writeFileSync(join(dir, "app.css"), css, "utf8");
		writeFileSync(
			join(dir, "page.html"),
			`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head><body>${body}<script>var s=getComputedStyle(document.querySelector("button"));document.title="D="+s.transitionDuration+"|"+s.transitionTimingFunction;</script></body></html>`,
			"utf8",
		);
		const dom = execFileSync(
			chrome,
			[
				"--headless",
				"--disable-gpu",
				"--no-sandbox",
				`--user-data-dir=${dir}`,
				...(reduce ? ["--force-prefers-reduced-motion"] : []),
				"--host-resolver-rules=MAP * ~NOTFOUND",
				"--dump-dom",
				`file://${join(dir, "page.html")}`,
			],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 30_000,
			},
		);
		const [duration = "", timing = ""] = (
			/<title>D=([^<]*)<\/title>/.exec(dom)?.[1] ?? ""
		).split("|");
		return { duration, timing };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// The longest listed duration, in ms ("0.18s, 0.18s" or "0.01ms, 0.01ms").
const maxMs = (v: string) =>
	Math.max(
		...v
			.split(",")
			.map((d) => Number.parseFloat(d) * (d.trim().endsWith("ms") ? 1 : 1000)),
	);

describe.skipIf(!hasChrome)(
	"claim fill transition under reduced motion",
	() => {
		// protects=the claim transition is 200ms on the enter easing (not styles.css's unlayered 180ms `ease` button rule) and reduced motion still collapses it; fails_when=the transition is removed, regresses to the global rule, or survives reduced motion; no_claim=none
		it(
			"animates normally and is at most 0.01ms under prefers-reduced-motion",
			async () => {
				const normal = await transition(false);
				expect(normal.duration).toBe("0.2s");
				expect(normal.timing).toBe("cubic-bezier(0.2, 0, 0, 1)");
				expect(maxMs((await transition(true)).duration)).toBeLessThanOrEqual(
					0.01,
				);
			},
			CHROME_TEST_TIMEOUT_MS,
		);
	},
);
