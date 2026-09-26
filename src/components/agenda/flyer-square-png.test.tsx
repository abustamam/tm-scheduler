/**
 * The square flyer's PNG export (#931), decoded.
 *
 * `html-to-image` draws the DOM into a canvas inside a real browser, so nothing
 * in jsdom can say whether the image it produces is right. This runs the
 * SHIPPED export function (`exportSquarePng`, bundled from source with esbuild)
 * in headless Chrome against the SHIPPED square layout, reads the PNG back, and
 * decodes it:
 *
 *   - the QR in the image decodes to the public meeting URL;
 *   - the logo region is not blank (the test logo is pure red, a colour the
 *     layout uses nowhere else, so counting red pixels counts logo pixels);
 *   - the image is exactly 1080x1080.
 *
 * With two controls, so the positive assertions can fail: the same layout with
 * no logo has no red pixels, and a logo that is NOT a data URL is refused
 * rather than silently dropped — the export's whole reason for its guard.
 *
 * Same Chrome discovery and the same skip-locally / fail-in-CI rule as the
 * other browser-backed suites (`src/test/print-page-count.ts`).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { build } from "esbuild";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { NOT_INLINED_MESSAGE, SQUARE_PNG_PX } from "#/lib/flyer-png";
import {
	buildFlyerContent,
	DEFAULT_PROMO_TEMPLATE,
	promoValues,
} from "#/lib/promo-template";
import {
	CHROME_ENV,
	CHROME_TEST_TIMEOUT_MS,
	findChrome,
} from "#/test/print-page-count";
import { FLYER_SQUARE_PX, MeetingFlyerSquare } from "./meeting-flyer";

const ROOT = resolve(__dirname, "..", "..", "..");
const chrome = findChrome();
const MEETING_URL = "https://gavelup.app/club/downtown/meeting/2026-10-01";

const content = buildFlyerContent(
	DEFAULT_PROMO_TEMPLATE,
	promoValues(
		{
			name: "Downtown Speakers",
			slug: "downtown",
			timezone: "America/Chicago",
		},
		{
			urlKey: "2026-10-01",
			scheduledAt: "2026-10-02T00:30:00Z",
			location: "Library, Room 4",
			online: false,
			theme: "Beginnings",
			wordOfTheDay: null,
			meetingNumber: 57,
			promoNote: null,
		},
		"https://gavelup.app",
	),
);

/** A solid pure-red PNG — the stand-in club logo. */
function redLogo(): string {
	const png = new PNG({ width: 96, height: 96 });
	for (let i = 0; i < png.data.length; i += 4) {
		png.data[i] = 255;
		png.data[i + 1] = 0;
		png.data[i + 2] = 0;
		png.data[i + 3] = 255;
	}
	return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
}

let bundle = "";

beforeAll(async () => {
	if (!chrome) return;
	const out = await build({
		stdin: {
			contents:
				'import { exportSquarePng } from "./src/lib/flyer-png"; window.exportSquarePng = exportSquarePng;',
			resolveDir: ROOT,
			loader: "ts",
		},
		bundle: true,
		format: "iife",
		platform: "browser",
		write: false,
		logLevel: "silent",
	});
	bundle = out.outputFiles[0]?.text ?? "";
});

/**
 * Drive Chrome over the DevTools protocol on a pipe (fds 3 and 4) and AWAIT the
 * export's promise, rather than `--dump-dom` + `--virtual-time-budget`.
 *
 * The first version used the dump, and it flaked: about one run in three with
 * a logo, never without one (measured 5/15 and 0/15 over fresh Chrome
 * processes). Virtual time fast-forwards whenever the page looks idle, and an
 * image decoding off the main thread does not count as busy — so Chrome
 * jumped to the end of the budget and dumped the page before `html-to-image`
 * had finished, whatever the budget was (10s and 60s failed alike). Awaiting
 * the promise itself has no budget to outrun.
 */
async function exportInChrome(logoSrc: string | null): Promise<string> {
	if (!chrome) throw new Error("no chrome");
	const markup = renderToStaticMarkup(
		<MeetingFlyerSquare
			content={content}
			clubName="Downtown Speakers"
			logoSrc={logoSrc}
		/>,
	);
	const html = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0">${markup}
<script>${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>
window.__flyerExport = window
	.exportSquarePng(document.querySelector("[data-flyer-square]"))
	.catch(function (e) { return "ERR:" + e.message; });
</script></body></html>`;
	const dir = mkdtempSync(join(tmpdir(), "flyer-png-"));
	const htmlPath = join(dir, "page.html");
	writeFileSync(htmlPath, html, "utf8");
	const proc = spawn(
		chrome,
		[
			"--headless",
			"--disable-gpu",
			"--no-sandbox",
			`--user-data-dir=${dir}`,
			"--disable-extensions",
			"--host-resolver-rules=MAP * ~NOTFOUND",
			"--remote-debugging-pipe",
			`file://${htmlPath}`,
		],
		{ stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], env: CHROME_ENV },
	);
	const toChrome = proc.stdio[3] as Writable;
	const fromChrome = proc.stdio[4] as Readable;
	let nextId = 0;
	const pending = new Map<number, (msg: CdpMessage) => void>();
	let buffered = "";
	fromChrome.on("data", (chunk: Buffer) => {
		buffered += chunk.toString("utf8");
		let nul = buffered.indexOf("\0");
		while (nul !== -1) {
			const msg = JSON.parse(buffered.slice(0, nul)) as CdpMessage;
			buffered = buffered.slice(nul + 1);
			if (msg.id !== undefined) pending.get(msg.id)?.(msg);
			nul = buffered.indexOf("\0");
		}
	});
	const send = (
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	) =>
		new Promise<CdpMessage>((resolveMsg) => {
			const id = ++nextId;
			pending.set(id, resolveMsg);
			toChrome.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
		});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const run = (async () => {
			// The start page is the only target; poll until it exists.
			let targetId: string | undefined;
			for (let i = 0; i < 100 && !targetId; i++) {
				const { result } = await send("Target.getTargets");
				// Wait for the page to be ON the file, not the blank page Chrome
				// opens first — attaching to that one races the navigation.
				targetId = (
					result?.targetInfos as {
						type: string;
						targetId: string;
						url: string;
					}[]
				)?.find(
					(t) => t.type === "page" && t.url.startsWith("file://"),
				)?.targetId;
				if (!targetId) await new Promise((r) => setTimeout(r, 50));
			}
			if (!targetId) throw new Error("Chrome opened no page");
			const attached = await send("Target.attachToTarget", {
				targetId,
				flatten: true,
			});
			const sessionId = attached.result?.sessionId as string;
			// Re-asked while a navigation still tears the context down.
			let evaluated: CdpMessage = {};
			for (let i = 0; i < 50; i++) {
				evaluated = await send(
					"Runtime.evaluate",
					{
						expression: `new Promise(function (ok) {
						(function wait() {
							if (window.__flyerExport) window.__flyerExport.then(ok);
							else setTimeout(wait, 20);
						})();
					})`,
						awaitPromise: true,
						returnByValue: true,
					},
					sessionId,
				);
				if (!evaluated.error) break;
				await new Promise((r) => setTimeout(r, 50));
			}
			const value = (evaluated.result?.result as { value?: unknown })?.value;
			if (typeof value !== "string") {
				throw new Error(`the export returned ${JSON.stringify(evaluated)}`);
			}
			return value;
		})();
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("the export did not finish in 30s")),
				30_000,
			);
		});
		return await Promise.race([run, timeout]);
	} finally {
		clearTimeout(timer);
		proc.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
}

type CdpMessage = {
	id?: number;
	result?: Record<string, unknown>;
	error?: unknown;
};

function decode(dataUrl: string): PNG {
	expect(dataUrl.slice(0, 120)).toMatch(/^data:image\/png;base64,/);
	return PNG.sync.read(
		Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64"),
	);
}

function redPixels(png: PNG): number {
	let n = 0;
	for (let i = 0; i < png.data.length; i += 4) {
		const r = png.data[i] ?? 0;
		const g = png.data[i + 1] ?? 0;
		const b = png.data[i + 2] ?? 0;
		if (r > 200 && g < 60 && b < 60) n++;
	}
	return n;
}

describe("square flyer PNG harness availability", () => {
	it("has a Chrome to run in (fails in CI rather than skipping)", () => {
		if (!chrome && process.env.CI) {
			throw new Error(
				"CI has no Chrome on PATH — the PNG export is unverified",
			);
		}
		expect(FLYER_SQUARE_PX).toBe(SQUARE_PNG_PX);
	});
});

describe.skipIf(!chrome)(
	"the square flyer exports a PNG that decodes (#931)",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		it("is 1080x1080, its QR opens the meeting page, and the logo is in it", async () => {
			const png = decode(await exportInChrome(redLogo()));
			expect(png.width).toBe(SQUARE_PNG_PX);
			expect(png.height).toBe(SQUARE_PNG_PX);

			const qr = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
			expect(qr?.data).toBe(MEETING_URL);

			// The logo box is 120px tall; anything near that is the logo drawn.
			// A few stray anti-aliased pixels would not reach this.
			expect(redPixels(png)).toBeGreaterThan(5000);
		});

		it("without a logo there is no red at all (control)", async () => {
			const png = decode(await exportInChrome(null));
			expect(redPixels(png)).toBe(0);
		});

		it("refuses a logo that is not inlined rather than dropping it", async () => {
			const out = await exportInChrome("https://gavelup.app/api/club/x/logo");
			expect(out).toBe(`ERR:${NOT_INLINED_MESSAGE}`);
		});
	},
);
