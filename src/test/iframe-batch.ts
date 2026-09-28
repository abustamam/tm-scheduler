/**
 * Lay many small documents out in ONE headless Chrome launch, each in its own
 * iframe at its own width, and read back what a probe script measured inside
 * each one. A launch is the whole cost of these harnesses, so every case rides
 * one `--dump-dom`.
 *
 * Why an iframe: headless Chrome will not size a WINDOW below 500px, and an
 * iframe gives its page a genuine viewport of the frame's width (`100vw`,
 * media queries and all). It also draws a classic 15px scrollbar, which a
 * phone does not, so edge assertions should read `clientWidth`, not the frame
 * width: that is stricter than a phone.
 *
 * The probe runs inside each frame and must end in
 * `parent.postMessage({ id: location.hash.slice(1), frame: <result> }, "*")`.
 * Used by `print-screen-fit-geometry.test.tsx` (#964) and
 * `print-toolbar-geometry.test.tsx` (#998).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROME_ENV, findChrome } from "#/test/print-page-count";

export type FrameCase = { id: string; html: string; width: number };

export function measureInFrames<T>(
	cases: readonly FrameCase[],
	{
		probe,
		frameHeight,
		timeoutMs = 20_000,
	}: { probe: string; frameHeight: number; timeoutMs?: number },
): Map<string, T> {
	const chrome = findChrome();
	if (!chrome) throw new Error("No Chrome");
	const dir = mkdtempSync(join(tmpdir(), "iframe-batch-"));
	try {
		const frames = cases
			.map((c) => {
				const file = `${c.id}.html`;
				writeFileSync(
					join(dir, file),
					c.html.replace("</body>", `${probe}</body>`),
					"utf8",
				);
				return `<iframe src="${file}#${c.id}" style="display:block;border:0;width:${c.width}px;height:${frameHeight}px"></iframe>`;
			})
			.join("");
		// The listener is registered in <head>, BEFORE any frame exists. At the
		// end of <body> it raced the frames: under a parallel run a frame could
		// load and post before the parser reached the script, the message was
		// lost, and the page never left "pending" (seen 1 run in 3).
		const outer = `<!doctype html><html><head><title>pending</title>
<script>
var got = {}, want = ${cases.length};
addEventListener("message", function (e) {
	got[e.data.id] = e.data.frame;
	if (Object.keys(got).length === want) {
		document.getElementById("out").textContent = JSON.stringify(got);
		document.title = "done";
	}
});
</script></head><body style="margin:0">
<pre id="out"></pre>${frames}
</body></html>`;
		const outerPath = join(dir, "outer.html");
		writeFileSync(outerPath, outer, "utf8");
		const dom = execFileSync(
			chrome,
			[
				"--headless",
				"--disable-gpu",
				"--no-sandbox",
				`--user-data-dir=${dir}`,
				"--disable-extensions",
				"--host-resolver-rules=MAP * ~NOTFOUND",
				"--window-size=1400,900",
				// Generous: an idle page fast-forwards virtual time, so a big budget
				// costs nothing real and only matters if many frames load slowly.
				"--virtual-time-budget=30000",
				"--dump-dom",
				`file://${outerPath}`,
			],
			{ encoding: "utf8", stdio: "pipe", timeout: timeoutMs, env: CHROME_ENV },
		);
		const title = dom.match(/<title>([^<]*)<\/title>/)?.[1];
		const json = dom.match(/<pre id="out">([^<]*)<\/pre>/)?.[1];
		if (title !== "done" || !json) {
			throw new Error(
				`Not every frame reported back; Chrome's title was "${title}".`,
			);
		}
		// `--dump-dom` serialises the <pre>'s text, escaping these four.
		const parsed = JSON.parse(
			json
				.replace(/&quot;/g, '"')
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.replace(/&amp;/g, "&"),
		) as Record<string, T>;
		return new Map(Object.entries(parsed));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
