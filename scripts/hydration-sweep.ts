/**
 * Load routes of a running dev server in headless Chrome under a runtime that
 * differs from the server's, and report every React hydration mismatch with
 * the component and source line React names (#1000).
 *
 *   TZ=UTC ENABLE_DEV_LOGIN=1 BETTER_AUTH_URL=http://localhost:3100 \
 *     bunx vite dev --port 3100 --strictPort
 *   bun scripts/hydration-sweep.ts --base http://localhost:3100 \
 *     --email jordan@example.com /admin/vpe-dashboard /activity …
 *
 * `--email none` sweeps signed out. `--tz` / `--locale` pick the browser's
 * runtime (default America/Los_Angeles + es-ES, the pair #1000 was found
 * under); run it again under a zone on the far side of UTC (Asia/Tokyo) too,
 * because a date only moves across a day boundary in one direction.
 *
 * Why a DEV server: production React minifies #418 to a number and drops the
 * diff. The dev build prints the mismatched text and, through TanStack's
 * `data-tsd-source` attributes, the file and line that rendered it.
 *
 * Why each route loads TWICE: the first load of a route in `vite dev`
 * compiles its modules on demand, and a mismatch thrown after the settle
 * window would be missed. Findings from either load count.
 *
 * What it cannot see: React stops at the FIRST text node that disagrees in a
 * tree, so one finding per route is a floor, not a count — fix it and run
 * again. And it samples one instant against one dataset: a render that only
 * disagrees at a month boundary, or on data the dev seed does not hold, reads
 * clean. `src/lib/format-locale.guard.test.ts` is the CI gate for the shape
 * every finding so far has had; this is the inventory tool behind it.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function flag(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = flag("base", "http://localhost:3000");
const TZ = flag("tz", "America/Los_Angeles");
const LOCALE = flag("locale", "es-ES");
const EMAIL = flag("email", "jordan@example.com");
const SETTLE_MS = Number(flag("settle", "7000"));
const routes = process.argv
	.slice(2)
	.filter((a, i, all) => a.startsWith("/") && !all[i - 1]?.startsWith("--"));

if (routes.length === 0) {
	console.error(
		"usage: bun scripts/hydration-sweep.ts [--base URL] [--email E|none] [--tz Z] [--locale L] /route …",
	);
	process.exit(2);
}

const port = 9300 + Math.floor(Math.random() * 600);
const chrome = spawn(
	process.env.CHROME_PATH ?? "google-chrome",
	[
		"--headless=new",
		`--remote-debugging-port=${port}`,
		"--no-first-run",
		"--no-default-browser-check",
		`--lang=${LOCALE}`,
		`--user-data-dir=${mkdtempSync(join(tmpdir(), "hydration-sweep-"))}`,
		"about:blank",
	],
	{
		// LANG as well as --lang: without it `navigator.language` stays the
		// machine's, even with the Intl default overridden below.
		env: { ...process.env, TZ, LANG: `${LOCALE.replace("-", "_")}.UTF-8` },
		stdio: "ignore",
	},
);

async function pageSocketUrl(): Promise<string> {
	for (let i = 0; i < 100; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/list`);
			const targets = (await res.json()) as Array<{
				type: string;
				webSocketDebuggerUrl: string;
			}>;
			const page = targets.find((t) => t.type === "page");
			if (page) return page.webSocketDebuggerUrl;
		} catch {
			// Chrome is still starting.
		}
		await Bun.sleep(100);
	}
	throw new Error("Chrome did not expose a page target");
}

const ws = new WebSocket(await pageSocketUrl());
await new Promise((resolve) => ws.addEventListener("open", resolve));

let nextId = 0;
const pending = new Map<number, (value: unknown) => void>();
const errors: string[] = [];
let onLoad: (() => void) | null = null;

ws.addEventListener("message", (event) => {
	const msg = JSON.parse(String(event.data));
	if (msg.id && pending.has(msg.id)) {
		pending.get(msg.id)?.(msg.result ?? msg.error);
		pending.delete(msg.id);
		return;
	}
	if (msg.method === "Runtime.exceptionThrown") {
		const d = msg.params.exceptionDetails;
		errors.push(String(d.exception?.description ?? d.text));
	} else if (
		msg.method === "Runtime.consoleAPICalled" &&
		msg.params.type === "error"
	) {
		errors.push(
			msg.params.args
				.map((a: { value?: unknown; description?: string }) =>
					a.value !== undefined ? String(a.value) : (a.description ?? ""),
				)
				.join(" "),
		);
	} else if (msg.method === "Page.loadEventFired") {
		onLoad?.();
	}
});

function send<T = unknown>(method: string, params: object = {}): Promise<T> {
	const id = ++nextId;
	ws.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve) =>
		pending.set(id, resolve as (value: unknown) => void),
	);
}

async function load(url: string) {
	const loaded = new Promise<void>((resolve) => {
		onLoad = resolve;
	});
	await send("Page.navigate", { url });
	await Promise.race([loaded, Bun.sleep(30_000)]);
	await Bun.sleep(SETTLE_MS);
}

async function evaluate<T>(expression: string): Promise<T> {
	const r = await send<{ result: { value: T } }>("Runtime.evaluate", {
		expression,
		returnByValue: true,
	});
	return r.result.value;
}

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setTimezoneOverride", { timezoneId: TZ });
await send("Emulation.setLocaleOverride", { locale: LOCALE });

await load(
	EMAIL === "none"
		? `${BASE}/about`
		: `${BASE}/api/dev-login?email=${encodeURIComponent(EMAIL)}&redirect=/about`,
);
// Prove the shift took before trusting a clean result.
console.log(
	`browser runtime: ${await evaluate<string>(
		"Intl.DateTimeFormat().resolvedOptions().timeZone + ' ' + navigator.language",
	)}`,
);

const HYDRATION = /hydrat|server rendered|did not match|#418|#419|#423|#425/i;
let mismatched = 0;
for (const route of routes) {
	errors.length = 0;
	await load(`${BASE}${route}`);
	await load(`${BASE}${route}`);
	const landed = await evaluate<string>("location.pathname");
	const found = errors.filter((e) => HYDRATION.test(e));
	console.log(
		`\n${found.length ? "MISMATCH" : "clean   "} ${route}${landed === route ? "" : ` -> ${landed}`}`,
	);
	if (found.length) mismatched++;
	for (const e of new Set(found)) {
		for (const line of e.split("\n")) {
			if (
				/data-tsd-source="\/src\/[^"]+:\d+/.test(line) ||
				/^[+-]\s{2,}\S/.test(line)
			) {
				console.log(`  ${line.trim()}`);
			}
		}
	}
}

ws.close();
chrome.kill();
console.log(`\n${mismatched} of ${routes.length} routes mismatched`);
process.exit(mismatched ? 1 : 0);
