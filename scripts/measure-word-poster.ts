/**
 * Re-derive and verify the Word of the Day poster's font-size tables
 * (`src/lib/word-poster.ts`) against a real browser and a real dictionary.
 *
 * Run this whenever something invalidates those tables: a change to `PAGE_W`,
 * to `POSTER_PAD_X`, or to the display font family or weight. The tables are
 * each the largest size that clears the target, so any of those changes can
 * push a bucket over and reintroduce the mid-word break they exist to prevent
 * — with no test able to notice, because the failure is font rendering.
 *
 * Two modes:
 *
 *   verify   (default) Measure the CURRENT tables in `src/lib/word-poster.ts`
 *            against every dictionary word, in all three realistic input
 *            styles. Exits 1 if any bucket exceeds TARGET_W.
 *   derive   Search for the largest size per bucket that clears TARGET_W and
 *            print a table you can paste back into `word-poster.ts`.
 *
 * Usage:
 *   bun run scripts/measure-word-poster.ts
 *   bun run scripts/measure-word-poster.ts derive
 *
 * Requirements:
 *   • Headless Chrome — `google-chrome`, `google-chrome-stable` or `chromium`
 *     on PATH, or set CHROME_BIN. (Real font rendering is the whole point;
 *     jsdom performs no layout and canvas-only metrics miss `opsz`.)
 *   • A word list at /usr/share/dict/words (Debian: `wamerican`). Override
 *     with WORDS_FILE=/path/to/list.
 *   • Network access on first run, to fetch Fraunces from Google Fonts — the
 *     same source `src/styles.css` uses.
 *
 * TWO THINGS THIS SCRIPT EXISTS TO GET RIGHT, both of which produced wrong
 * numbers when done by hand:
 *
 *   1. It loads the real webfont before measuring. `document.fonts.ready`
 *      resolves immediately when nothing has requested a face yet, so a naive
 *      harness silently measures the Georgia fallback.
 *   2. It measures at each candidate size instead of extrapolating. Fraunces
 *      is a variable font with an optical-size axis and CSS
 *      `font-optical-sizing` defaults to `auto`, so letterforms change shape
 *      with size and width is NOT proportional to font-size — smaller sizes
 *      render relatively wider. `size * budget / width` is systematically
 *      optimistic.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTENT_W, TARGET_W, posterWordSize } from "#/lib/word-poster";

const WORDS_FILE = process.env.WORDS_FILE ?? "/usr/share/dict/words";
const MODE = process.argv[2] === "derive" ? "derive" : "verify";

/** Length ranges matching the buckets in `word-poster.ts`. */
const RANGES: readonly (readonly [lo: number, hi: number])[] = [
	[1, 6],
	[7, 10],
	[11, 14],
	[15, 18],
	[19, 99],
];

function findChrome(): string {
	const candidates = [
		process.env.CHROME_BIN,
		"google-chrome",
		"google-chrome-stable",
		"chromium",
		"chromium-browser",
	].filter((c): c is string => Boolean(c));
	for (const bin of candidates) {
		try {
			execFileSync("which", [bin], { stdio: "pipe" });
			return bin;
		} catch {
			// not on PATH; try the next candidate
		}
	}
	throw new Error(
		"No headless Chrome found. Install Chrome/Chromium or set CHROME_BIN.",
	);
}

/** Lowercase common words: a Word of the Day is not a proper noun or acronym. */
function loadWords(): string[] {
	let raw: string;
	try {
		raw = readFileSync(WORDS_FILE, "utf8");
	} catch {
		throw new Error(
			`Could not read ${WORDS_FILE}. Install a word list (Debian: 'wamerican') or set WORDS_FILE.`,
		);
	}
	const words = raw
		.split("\n")
		.map((w) => w.trim())
		.filter((w) => w.length > 0 && /^[a-z]+$/.test(w));
	if (words.length === 0) throw new Error(`No usable words in ${WORDS_FILE}.`);
	return words;
}

/**
 * The page runs in Chrome: it loads Fraunces, then measures. Kept as a string
 * because it executes in the browser, not here.
 */
function buildPage(words: string[], sizes: number[][], mode: string): string {
	return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&display=swap" rel="stylesheet">
<style>.probe{font-family:'Fraunces',Georgia,serif;font-weight:600;line-height:1.05;
white-space:nowrap;display:inline-block}#out{font-family:monospace;white-space:pre;font-size:12px}</style>
</head><body><div id="host" style="position:absolute;left:-99999px;top:0"></div>
<div id="out">PENDING</div><script>
const WORDS = ${JSON.stringify(words)};
const SIZES = ${JSON.stringify(sizes)};
const RANGES = ${JSON.stringify(RANGES)};
const CONTENT_W = ${CONTENT_W}, TARGET_W = ${TARGET_W}, MODE = ${JSON.stringify(mode)};
const host = document.getElementById("host");

function domWidth(text, size) {
  const p = document.createElement("span");
  p.className = "probe"; p.style.fontSize = size + "px"; p.textContent = text;
  host.appendChild(p); const w = p.getBoundingClientRect().width; p.remove(); return w;
}
function worstAt(cands, size) {
  let bw = "", best = 0;
  for (const c of cands) { const w = domWidth(c, size); if (w > best) { best = w; bw = c; } }
  return [bw, best];
}
// Canvas pre-rank is only a cheap shortlist; every reported number is DOM-measured.
function shortlist(words, lo, hi, atSize, n) {
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = "600 " + atSize + "px Fraunces, Georgia, serif";
  return words.filter((w) => w.length >= lo && w.length <= hi)
    .map((w) => [w, ctx.measureText(w).width])
    .sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}
function largestFitting(cands) {
  for (let s = 220; s >= 8; s--) {
    const [w, width] = worstAt(cands, s);
    if (width <= TARGET_W) return [s, w, width];
  }
  return [0, "?", 0];
}

function run() {
  const lower = WORDS;
  const cap = WORDS.map((w) => w[0].toUpperCase() + w.slice(1));
  const upper = WORDS.map((w) => w.toUpperCase());
  const lines = [];
  let failed = false;
  lines.push("words=" + WORDS.length + "  CONTENT_W=" + CONTENT_W + "  TARGET_W=" + TARGET_W);
  lines.push("");

  if (MODE === "derive") {
    const norm = [], caps = [];
    lines.push("NORMAL (must satisfy lowercase AND Capitalised):");
    for (const [lo, hi] of RANGES) {
      const pool = shortlist(lower, lo, hi, 100, 40).concat(shortlist(cap, lo, hi, 100, 40));
      const [size, word, width] = largestFitting(pool);
      norm.push(size);
      lines.push("  len " + lo + "-" + hi + " -> " + size + "px  binding " + word + " " + width.toFixed(1) + "px");
    }
    lines.push("  => " + norm.join(" / "));
    lines.push("ALL_CAPS:");
    for (const [lo, hi] of RANGES) {
      const [size, word, width] = largestFitting(shortlist(upper, lo, hi, 100, 40));
      caps.push(size);
      lines.push("  len " + lo + "-" + hi + " -> " + size + "px  binding " + word + " " + width.toFixed(1) + "px");
    }
    lines.push("  => " + caps.join(" / "));
  } else {
    const pops = [["NORMAL/lowercase", lower, 0], ["NORMAL/Capitalised", cap, 0], ["ALL_CAPS", upper, 1]];
    for (const [label, words, which] of pops) {
      lines.push("=== " + label + " ===");
      for (let i = 0; i < RANGES.length; i++) {
        const [lo, hi] = RANGES[i];
        const size = SIZES[which][i];
        const pool = shortlist(words, lo, hi, size, 40);
        if (!pool.length) { lines.push("  len " + lo + "-" + hi + " (none)"); continue; }
        const [w, width] = worstAt(pool, size);
        const ok = width <= TARGET_W;
        if (!ok) failed = true;
        lines.push("  len " + String(lo + "-" + hi).padEnd(6) + " @" + String(size).padStart(3) +
          "px  widest " + w.padEnd(24) + width.toFixed(1).padStart(6) + "px  " +
          (width / CONTENT_W * 100).toFixed(1) + "% of content  " + (ok ? "OK" : "OVER TARGET"));
      }
      lines.push("");
    }
  }
  lines.push("fraunces_loaded=" + document.fonts.check("600 100px Fraunces"));
  lines.push("STATUS=" + (failed ? "FAIL" : "PASS"));
  document.getElementById("out").textContent = "BEGIN\\n" + lines.join("\\n") + "\\nEND";
}

const faces = [];
for (let s = 8; s <= 220; s++) faces.push("600 " + s + "px Fraunces");
Promise.all(faces.map((f) => document.fonts.load(f, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")))
  .then(() => document.fonts.ready).then(() => setTimeout(run, 800))
  .catch((e) => { document.getElementById("out").textContent = "BEGIN\\nFONT LOAD FAILED: " + e + "\\nSTATUS=FAIL\\nEND"; });
</script></body></html>`;
}

function main(): void {
	const chrome = findChrome();
	const words = loadWords();
	// Current tables, read through the real function so they cannot drift.
	const normal = RANGES.map(([, hi]) => posterWordSize("a".repeat(Math.min(hi, 22))));
	const allCaps = RANGES.map(([, hi]) =>
		posterWordSize("A".repeat(Math.min(hi, 22))),
	);

	console.log(`chrome:     ${chrome}`);
	console.log(`dictionary: ${WORDS_FILE} (${words.length} lowercase words)`);
	console.log(`mode:       ${MODE}`);
	console.log(`NORMAL:     ${normal.join(" / ")}`);
	console.log(`ALL_CAPS:   ${allCaps.join(" / ")}\n`);

	const dir = mkdtempSync(join(tmpdir(), "wod-poster-"));
	const page = join(dir, "measure.html");
	try {
		writeFileSync(page, buildPage(words, [normal, allCaps], MODE));
		const dom = execFileSync(
			chrome,
			[
				"--headless=new",
				"--no-sandbox",
				"--disable-gpu",
				"--allow-file-access-from-files",
				"--virtual-time-budget=240000",
				"--dump-dom",
				`file://${page}`,
			],
			{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
		);
		const body = dom.split("BEGIN")[1]?.split("END")[0];
		if (!body) throw new Error("Chrome produced no measurements.");
		const text = body
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&amp;/g, "&")
			.trim();
		console.log(text);
		if (text.includes("fraunces_loaded=false")) {
			console.error(
				"\nFraunces did NOT load — these numbers are the fallback face. Check network access.",
			);
			process.exit(1);
		}
		if (text.includes("STATUS=FAIL")) {
			console.error("\nA bucket exceeds TARGET_W. Re-derive with: … derive");
			process.exit(1);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

main();
