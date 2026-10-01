/**
 * Harness for the route hydration gate (#1000): a REAL dev server rendering
 * each route under a UTC runtime, and a REAL Chrome hydrating it under a
 * different zone, locale and clock, with every React hydration error collected
 * and parsed into the route, the source line and the two texts.
 *
 * Why the real app and not `hydrateAcrossRuntimes`: that harness proves a
 * component someone thought to test. #1000 was found in production on a route
 * nobody had, and a sweep is the only thing that finds the next one.
 *
 * Why a DEV server: production React reports #418 as a bare number. The dev
 * build prints the mismatched text, and TanStack's `data-tsd-source`
 * attributes name the file and line that rendered it.
 *
 * The runtime shift, all three halves of it:
 *
 *   - ZONE: the server runs with `TZ=UTC`, the browser with its zone
 *     overridden over CDP (and `TZ` in its environment, belt and braces);
 *   - LOCALE: the server `en_US`, the browser `--lang` + `LANG` + a CDP locale
 *     override;
 *   - CLOCK: both processes are moved to the SAME instant, 03:30 UTC on the
 *     15th (`boundaryInstant`), the previous evening in America/Los_Angeles. The same instant on both
 *     sides is what production has; the day boundary between the two zones at
 *     that instant is what makes `new Date().getDate()` and friends disagree.
 *     The node server gets it through a `--import` preload, the page through
 *     `Page.addScriptToEvaluateOnNewDocument`, both from `clockShiftSource`.
 *
 * What it cannot see: React stops at the FIRST text node that disagrees in a
 * tree, so one finding per route is a floor. And it samples one instant
 * against one dataset: a render that disagrees only at a month boundary
 * (`formatTenure` does, measured; see `boundaryInstant`), or only on data the
 * fixture does not hold, reads clean here. Nor does it see a mismatch that
 * depends on the viewport, stored state or a media query: one headless
 * desktop-sized browser with empty storage is all it runs.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stopChromeAndRemoveDir } from "#/test/chrome-teardown";
import { findChrome } from "#/test/print-page-count";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");

/** The browser's runtime. The server's is fixed: UTC, en-US. */
export interface ClientRuntime {
	timeZone: string;
	locale: string;
}

export const DEFAULT_CLIENT: ClientRuntime = {
	timeZone: "America/Los_Angeles",
	locale: "es-ES",
};

/**
 * How long `HydrationBrowser.launch` waits for Chrome to come up (#1029).
 *
 * The FIRST Chrome on a fresh CI runner is slow, and the second is not. Over
 * the 40 `hydration` jobs before #1029, the teardown test's first launch took
 * ~1.2s or ~6-9s, with a tail at 12.0s and 14.7s; its second launch took
 * ~0.5s every time. The old wait was 150 polls 100ms apart, ~15s, so the tail
 * crossed it: both red runs threw "Chrome exposed no page target" at ~15.18s
 * (read at first as vitest's 15s timeout, which the test does not use). The
 * second launch in those runs took 8.8s and 13.2s, the first having been
 * killed before finishing whatever one-time work a cold start does.
 *
 * Four times the worst launch measured. It costs nothing when Chrome is fine,
 * and a Chrome that dies fails at once rather than waiting it out (`start`).
 */
export const CHROME_LAUNCH_TIMEOUT_MS = 60_000;

/**
 * The instant both processes are moved to: 03:30 UTC on the 15th of the
 * current UTC month, or of the previous one if that is still ahead. At 03:30
 * UTC it is 20:30 the PREVIOUS day in Los Angeles and 22:30 in Chicago, so the
 * UTC day and the client's day differ.
 *
 * Mid-month DELIBERATELY: at a MONTH boundary `formatTenure`
 * (`src/lib/members.ts`) counts months in the runtime's calendar and prints
 * "1 yr 1 mo" on the server against "11 mo 2 wks" in Los Angeles. That is a
 * real, reported mismatch outside #1000's files, and it renders in every row
 * of the roster, the member page and the VPE dashboard, ahead of every date
 * this gate exists to check; React stops at the first disagreement, so a gate
 * run on the 1st would report nothing but tenure. A fixed day keeps the gate
 * about day boundaries and keeps it from going red one day a month.
 */
export function boundaryInstant(now = Date.now()): number {
	const d = new Date(now);
	const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 15, 3, 30);
	return at <= now
		? at
		: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15, 3, 30);
}

/**
 * Source that moves `Date` by `offsetMs` in whatever runtime evaluates it.
 * A Proxy rather than a subclass so `Date()` called as a function (which a
 * subclass cannot answer) and `instanceof Date` both keep working.
 *
 * `Date.prototype.constructor` is repointed at the Proxy as well. Seroval
 * (TanStack's SSR serialiser) recognises a Date by its CONSTRUCTOR, compared
 * with the global it captured at import, which is the Proxy; left alone every
 * Date in loader data was "unsupported", SSR shipped no router state, and the
 * client threw an invariant on every page that loads a date.
 */
export function clockShiftSource(offsetMs: number): string {
	return `(() => {
	const Real = globalThis.Date;
	if (Real.__clockShifted) return;
	const OFFSET = ${JSON.stringify(offsetMs)};
	const now = () => Real.now() + OFFSET;
	const Shifted = new Proxy(Real, {
		construct(target, args, newTarget) {
			return Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget);
		},
		apply() {
			return new Real(now()).toString();
		},
		get(target, prop, receiver) {
			if (prop === "now") return now;
			if (prop === "__clockShifted") return true;
			return Reflect.get(target, prop, receiver);
		},
	});
	Object.defineProperty(Real.prototype, "constructor", {
		value: Shifted,
		writable: true,
		configurable: true,
	});
	globalThis.Date = Shifted;
})();
`;
}

async function freePort(): Promise<number> {
	return new Promise((done, fail) => {
		const srv = createServer();
		srv.once("error", fail);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			srv.close(() =>
				typeof addr === "object" && addr ? done(addr.port) : fail(addr),
			);
		});
	});
}

export interface DevServer {
	base: string;
	/** Everything the server printed, for a failure message. */
	log: () => string;
	stop: () => Promise<void>;
}

/**
 * Start `vite dev` under a UTC, en-US runtime whose clock is moved by
 * `clockOffsetMs`, against `databaseUrl`.
 *
 * `DISABLE_REMINDER_POLLER`: the dev server boots the in-process notification
 * poller, and against the shared test database it would deliver OTHER suites'
 * queued notifications out from under them.
 */
export async function startDevServer(opts: {
	databaseUrl: string;
	clockOffsetMs: number;
	env?: Record<string, string>;
}): Promise<DevServer> {
	const port = await freePort();
	const base = `http://localhost:${port}`;
	const dir = mkdtempSync(join(tmpdir(), "route-hydration-server-"));
	const preload = join(dir, "clock.mjs");
	writeFileSync(preload, clockShiftSource(opts.clockOffsetMs));

	const out: string[] = [];
	const child: ChildProcess = spawn(
		"node",
		[
			join(REPO_ROOT, "node_modules/vite/bin/vite.js"),
			"dev",
			"--port",
			String(port),
			"--strictPort",
		],
		{
			cwd: REPO_ROOT,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
				NODE_ENV: "development",
				TZ: "UTC",
				LANG: "en_US.UTF-8",
				LC_ALL: "en_US.UTF-8",
				DATABASE_URL: opts.databaseUrl,
				BETTER_AUTH_URL: base,
				BETTER_AUTH_SECRET:
					process.env.BETTER_AUTH_SECRET ?? "test-better-auth-secret",
				ENABLE_DEV_LOGIN: "1",
				DISABLE_REMINDER_POLLER: "1",
				RESEND_API_KEY: "",
				...opts.env,
			},
		},
	);
	child.stdout?.on("data", (b) => out.push(String(b)));
	child.stderr?.on("data", (b) => out.push(String(b)));

	const stop = async () => {
		if (child.exitCode === null && child.pid) {
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				// already gone
			}
			const exited = new Promise<void>((done) => child.once("exit", done));
			const timer = setTimeout(() => {
				try {
					if (child.pid) process.kill(-child.pid, "SIGKILL");
				} catch {
					// already gone
				}
			}, 5_000);
			await exited;
			clearTimeout(timer);
		}
		try {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		} catch {
			// A temp dir the OS reaps anyway must never fail the gate.
		}
	};

	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`dev server exited early:\n${out.join("")}`);
		}
		try {
			const res = await fetch(`${base}/api/health`);
			if (res.ok) return { base, log: () => out.join(""), stop };
		} catch {
			// not listening yet
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	await stop();
	throw new Error(`dev server never answered /api/health:\n${out.join("")}`);
}

/** One hydration error, parsed. */
export interface Mismatch {
	/** `src/…:line:col` of the element React named, when it named one. */
	source: string | null;
	/** What the SERVER rendered (React's `-` line). */
	server: string | null;
	/** What the CLIENT rendered (React's `+` line). */
	client: string | null;
	/** The first line of the error, for anything that did not parse. */
	message: string;
}

export interface RouteResult {
	/** The path requested. */
	path: string;
	/** Where the page ended up. Not `path` means it redirected. */
	landed: string;
	/** React attached to the document, i.e. hydration actually ran. */
	hydrated: boolean;
	mismatches: Mismatch[];
	/** Wall time both loads took, for spotting a route that waits on a timeout. */
	ms: number;
	/** The page's visible text, for asserting WHICH state of a route rendered. */
	text: string;
}

/**
 * React's own hydration-failure messages, dev and minified. Narrow on purpose:
 * `/hydrat/` alone also matches TanStack's "dehydrated data" invariant, which
 * is a broken page but not a server/client disagreement.
 */
const HYDRATION_ERROR =
	/Hydration failed|hydrated but some attributes|server rendered (text|HTML) didn't match|Minified React error #(418|419|423|425)/;

/** Parse React's dev-build hydration diff into the texts and the source. */
export function parseHydrationError(text: string): Mismatch {
	const lines = text.split("\n");
	let source: string | null = null;
	let server: string | null = null;
	let client: string | null = null;
	for (const line of lines) {
		const src = /data-tsd-source="\/(src\/[^"]+:\d+:\d+)"/.exec(line);
		if (src?.[1]) source = src[1];
		const minus = /^-\s{2,}(\S.*)$/.exec(line);
		const plus = /^\+\s{2,}(\S.*)$/.exec(line);
		if (minus?.[1] && server === null) server = minus[1].trim();
		if (plus?.[1] && client === null) client = plus[1].trim();
	}
	return { source, server, client, message: lines[0] ?? "" };
}

/**
 * A headless Chrome on `client`'s zone and locale with its clock moved by
 * `clockOffsetMs`, driven over CDP.
 */
export class HydrationBrowser {
	private ws!: WebSocket;
	private nextId = 0;
	private pending = new Map<number, (value: unknown) => void>();
	private errors: string[] = [];
	private onLoad: (() => void) | null = null;
	/** Main-frame navigations since the last `sweep` began. */
	private navigations = 0;
	/** When a request last started or ended. */
	private lastNetworkChange = 0;
	private chrome!: ChildProcess;
	private dir!: string;

	private constructor(
		private readonly client: ClientRuntime,
		private readonly clockOffsetMs: number,
	) {}

	static async launch(
		client: ClientRuntime,
		clockOffsetMs: number,
		opts: {
			/** The browser binary. Defaults to `findChrome()`. */
			bin?: string;
			/** Budget for Chrome to come up. See `CHROME_LAUNCH_TIMEOUT_MS`. */
			launchTimeoutMs?: number;
			/**
			 * Told the process and its profile the moment Chrome is spawned, before
			 * it has run a line: how a test observes cleanup without depending on
			 * the child getting far enough to report anything itself.
			 */
			onSpawn?: (spawned: { pid: number | undefined; dir: string }) => void;
		} = {},
	): Promise<HydrationBrowser> {
		const bin = opts.bin ?? findChrome();
		if (!bin) throw new Error("no Chrome: see findChrome() / CHROME_PATH");
		const b = new HydrationBrowser(client, clockOffsetMs);
		try {
			await b.start(
				bin,
				opts.launchTimeoutMs ?? CHROME_LAUNCH_TIMEOUT_MS,
				opts.onSpawn,
			);
		} catch (err) {
			await b.close();
			throw err;
		}
		return b;
	}

	/**
	 * Spawn Chrome and attach to its page target, within ONE deadline.
	 *
	 * Chrome picks its own DevTools port (`--remote-debugging-port=0`) and says
	 * which on stderr, so there is no window between choosing a free port and
	 * Chrome binding it for another process to take. And a Chrome that EXITS
	 * while starting fails the launch at once, with what it printed, instead of
	 * being polled for until the deadline and reported as a missing page target.
	 */
	private async start(
		bin: string,
		launchTimeoutMs: number,
		onSpawn?: (spawned: { pid: number | undefined; dir: string }) => void,
	) {
		const started = Date.now();
		const deadline = started + launchTimeoutMs;
		this.dir = mkdtempSync(join(tmpdir(), "route-hydration-chrome-"));
		this.chrome = spawn(
			bin,
			[
				"--headless=new",
				"--remote-debugging-port=0",
				"--no-first-run",
				"--no-default-browser-check",
				"--no-sandbox",
				// Nothing but the dev server: the web fonts would otherwise be
				// fetched from Google on every page, which CI may not reach and
				// which only moves layout, never text.
				"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
				`--lang=${this.client.locale}`,
				`--user-data-dir=${this.dir}`,
				"about:blank",
			],
			{
				env: {
					...process.env,
					TZ: this.client.timeZone,
					LANG: `${this.client.locale.replace("-", "_")}.UTF-8`,
				},
				// stderr only: it is where Chrome announces its DevTools endpoint,
				// and what a launch failure quotes.
				stdio: ["ignore", "ignore", "pipe"],
				// Its own process group, so teardown can kill the renderers too.
				detached: true,
			},
		);
		const chrome = this.chrome;
		onSpawn?.({ pid: chrome.pid, dir: this.dir });

		// Drained for the whole life of the process, so a chatty Chrome never
		// blocks on a full pipe; only the tail is kept, for an error message.
		let stderr = "";
		chrome.stderr?.setEncoding("utf8");
		chrome.stderr?.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-4_000);
		});
		const fail = (why: string) =>
			new Error(
				`Chrome ${why} after ${Date.now() - started}ms (budget ${launchTimeoutMs}ms).` +
					(stderr.trim()
						? ` Its stderr:\n${stderr.trim()}`
						: " It printed nothing."),
			);
		const exitedEarly = () =>
			chrome.exitCode !== null || chrome.signalCode !== null;

		// 1. The endpoint, from Chrome's own announcement.
		const endpoint = await new Promise<URL>((done, reject) => {
			const timer = setTimeout(
				() => finish(fail("announced no DevTools endpoint")),
				Math.max(0, deadline - Date.now()),
			);
			// Only a COMPLETE line: the announcement can arrive split across
			// chunks, and a prefix such as `ws://127.` is itself a valid match.
			const onData = () => {
				const m = /DevTools listening on (ws:\/\/\S+)\r?\n/.exec(stderr);
				if (!m?.[1]) return;
				try {
					finish(new URL(m[1]));
				} catch {
					finish(fail(`announced an unparseable endpoint (${m[1]})`));
				}
			};
			// `exit` can arrive before the last of stderr does, and stderr is the
			// whole point of the message: let it drain, briefly.
			const onExit = () => {
				const report = () =>
					finish(
						fail(
							`exited while starting (code ${chrome.exitCode}, signal ${chrome.signalCode})`,
						),
					);
				if (!chrome.stderr || chrome.stderr.readableEnded) return report();
				const grace = setTimeout(report, 1_000);
				chrome.stderr.once("end", () => {
					clearTimeout(grace);
					report();
				});
			};
			const onError = (err: Error) =>
				finish(fail(`could not be spawned (${err.message})`));
			function finish(result: URL | Error) {
				clearTimeout(timer);
				chrome.stderr?.off("data", onData);
				chrome.off("exit", onExit);
				chrome.off("error", onError);
				if (result instanceof URL) done(result);
				else reject(result);
			}
			chrome.stderr?.on("data", onData);
			chrome.once("exit", onExit);
			chrome.once("error", onError);
			if (exitedEarly()) onExit();
		});

		// 2. The page target, which can trail the endpoint by a moment.
		let wsUrl: string | undefined;
		while (!wsUrl) {
			if (exitedEarly()) throw fail("exited before exposing a page target");
			if (Date.now() >= deadline) throw fail("exposed no page target");
			try {
				const res = await fetch(`http://${endpoint.host}/json/list`, {
					signal: AbortSignal.timeout(
						Math.max(1, Math.min(5_000, deadline - Date.now())),
					),
				});
				const targets = (await res.json()) as Array<{
					type: string;
					webSocketDebuggerUrl: string;
				}>;
				wsUrl = targets.find((t) => t.type === "page")?.webSocketDebuggerUrl;
			} catch {
				// not answering yet
			}
			if (!wsUrl) await new Promise((r) => setTimeout(r, 100));
		}

		this.ws = new WebSocket(wsUrl);
		await new Promise((done, fail) => {
			this.ws.addEventListener("open", done, { once: true });
			this.ws.addEventListener("error", fail, { once: true });
		});
		this.ws.addEventListener("message", (event) => this.receive(event));

		await this.send("Runtime.enable");
		await this.send("Page.enable");
		await this.send("Network.enable");
		await this.send("Emulation.setTimezoneOverride", {
			timezoneId: this.client.timeZone,
		});
		await this.send("Emulation.setLocaleOverride", {
			locale: this.client.locale,
		});
		await this.send("Page.addScriptToEvaluateOnNewDocument", {
			source: clockShiftSource(this.clockOffsetMs),
		});
	}

	private receive(event: MessageEvent) {
		const msg = JSON.parse(String(event.data));
		if (msg.id && this.pending.has(msg.id)) {
			this.pending.get(msg.id)?.(msg.result ?? msg.error);
			this.pending.delete(msg.id);
			return;
		}
		if (msg.method === "Runtime.exceptionThrown") {
			const d = msg.params.exceptionDetails;
			this.errors.push(String(d.exception?.description ?? d.text));
		} else if (
			msg.method === "Runtime.consoleAPICalled" &&
			msg.params.type === "error"
		) {
			this.errors.push(
				msg.params.args
					.map((a: { value?: unknown; description?: string }) =>
						a.value !== undefined ? String(a.value) : (a.description ?? ""),
					)
					.join(" "),
			);
		} else if (msg.method === "Page.loadEventFired") {
			this.onLoad?.();
		} else if (
			msg.method === "Network.requestWillBeSent" &&
			// A stream never finishes, so it would hold "idle" off forever: the
			// TanStack devtools console pipe is an EventSource on every page.
			msg.params.type !== "EventSource"
		) {
			this.lastNetworkChange = Date.now();
		} else if (
			msg.method === "Network.loadingFinished" ||
			msg.method === "Network.loadingFailed"
		) {
			this.lastNetworkChange = Date.now();
		} else if (
			msg.method === "Page.frameNavigated" &&
			!msg.params.frame?.parentId
		) {
			this.navigations++;
		}
	}

	private send<T = unknown>(method: string, params: object = {}): Promise<T> {
		const id = ++this.nextId;
		this.ws.send(JSON.stringify({ id, method, params }));
		return new Promise((done) =>
			this.pending.set(id, done as (value: unknown) => void),
		);
	}

	async evaluate<T>(expression: string): Promise<T> {
		const r = await this.send<{ result: { value: T } }>("Runtime.evaluate", {
			expression,
			returnByValue: true,
		});
		return r.result.value;
	}

	/**
	 * Navigate and wait until React has hydrated AND the page has gone quiet.
	 *
	 * React marks the document the moment `hydrateRoot` is CALLED, not when
	 * hydration finishes: a route whose chunk `vite dev` is still compiling
	 * suspends, and its mismatch is thrown seconds later. So after the marker,
	 * wait for the network to sit idle (no request in flight for a while), which
	 * is when lazy chunks and loader calls have landed, then give React's
	 * after-commit error reporting a moment more.
	 */
	async load(url: string, timeoutMs = 90_000): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		const loaded = new Promise<void>((done) => {
			this.onLoad = done;
		});
		this.lastNetworkChange = Date.now();
		await this.send("Page.navigate", { url });
		await Promise.race([loaded, new Promise((r) => setTimeout(r, timeoutMs))]);
		let hydrated = false;
		while (Date.now() < deadline) {
			hydrated = await this.evaluate<boolean>(
				"Object.keys(document).some((k) => k.startsWith('__reactContainer$'))",
			);
			if (hydrated) break;
			await new Promise((r) => setTimeout(r, 200));
		}
		while (Date.now() < deadline) {
			// Quiet = no request started or ended for a while. NOT "nothing in
			// flight": Chrome never reports some module requests `vite dev`
			// dedupes as finished, and an in-flight count waits on them forever.
			if (Date.now() - this.lastNetworkChange >= 750) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		await new Promise((r) => setTimeout(r, 750));
		return hydrated;
	}

	/**
	 * Load `path` twice and report what hydrating the SECOND load raised.
	 *
	 * The first load is a warm-up. On a route's first visit `vite dev`
	 * compiles its chunks on demand, and while a chunk compiles the page is
	 * waiting on a request that emits no network events at all, so "quiet"
	 * would be declared, and a mismatch thrown once the chunk lands would be
	 * missed. Measured: four known mismatches read clean on a single cold load
	 * and all four showed on a warm one. A deployed server never serves a cold
	 * compile, so the warm load is also the faithful one.
	 *
	 * If the page navigated itself while loading (`vite dev` reloads after
	 * re-optimising a dependency), the errors belong to a page that no longer
	 * exists: load again and report that one.
	 */
	async sweep(base: string, path: string): Promise<RouteResult> {
		const started = Date.now();
		await this.load(`${base}${path}`);
		let hydrated = false;
		for (let attempt = 0; attempt < 3; attempt++) {
			this.errors = [];
			this.navigations = 0;
			hydrated = await this.load(`${base}${path}`);
			if (this.navigations <= 1) break;
		}
		const landed = await this.evaluate<string>("location.pathname");
		const mismatches = [...new Set(this.errors)]
			.filter((e) => HYDRATION_ERROR.test(e))
			.map(parseHydrationError);
		const text = await this.evaluate<string>("document.body?.innerText ?? ''");
		return {
			path,
			landed,
			hydrated,
			mismatches,
			ms: Date.now() - started,
			text,
		};
	}

	/** What the page itself reports as its zone, locale and clock. */
	async runtime(): Promise<{ timeZone: string; locale: string; now: number }> {
		return this.evaluate(
			"({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: new Intl.NumberFormat().resolvedOptions().locale, now: Date.now() })",
		);
	}

	/**
	 * Stop Chrome and remove its profile, never throwing. `stopChromeAndRemoveDir`
	 * (#972) kills the whole process group and waits for every member to exit
	 * before removing the directory, with retries: removing it while a renderer
	 * was still writing `Default/` failed this gate in CI with ENOTEMPTY and every
	 * assertion green. `rm` is replaceable so a test can make the removal fail.
	 */
	async close(teardown: { rm?: (dir: string) => void } = {}): Promise<void> {
		try {
			this.ws?.close();
		} catch {
			// already closed
		}
		try {
			if (this.chrome) {
				await stopChromeAndRemoveDir(this.chrome, this.dir, teardown);
			} else if (this.dir) {
				(
					teardown.rm ??
					((d: string) =>
						rmSync(d, { recursive: true, force: true, maxRetries: 5 }))
				)(this.dir);
			}
		} catch {
			// Cleanup is best-effort: a straggler must never fail the gate.
		}
	}
}

/** One mismatch as a line: route, source, and server vs client text. */
export function describeMismatch(path: string, m: Mismatch): string {
	return `${path} ${m.source ?? "(no source)"}: server ${JSON.stringify(
		m.server,
	)} / client ${JSON.stringify(m.client)}${
		m.server === null && m.client === null ? ` [${m.message}]` : ""
	}`;
}
