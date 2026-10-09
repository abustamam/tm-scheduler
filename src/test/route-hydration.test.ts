// The route hydration harness's teardown (#1000).
//
// The gate failed in CI once with every assertion green:
// `ENOTEMPTY: directory not empty, rmdir '/tmp/route-hydration-chrome-…/Default'`.
// Chrome's renderers were still writing the profile when it was removed, and
// the error escaped `afterAll`. These pin both halves of the fix: Chrome and
// its whole group are gone before the directory goes, and a removal that fails
// anyway is swallowed, because a cleanup hiccup must never fail the gate.
//
// And its launch (#1029): the first Chrome on a cold CI runner took up to
// ~15s to come up, which is where the old fixed poll gave up, so this file went
// red on its own about one run in twenty. `CHROME_LAUNCH_TIMEOUT_MS` says why
// the budget is what it is; the fake-browser cases below pin that a Chrome
// which DIES fails the launch at once with what it printed, rather than being
// waited out, and that a launch giving up still cleans up after itself.
//
// And its commands (#1128): a CDP command nobody answers used to wait for ever,
// so one `hydration` run in 150 spent the hook's whole 900s budget on a stalled
// sweep and printed nothing about where. `CdpClient` is pinned against a fake
// wire (a budget that runs out, a connection that goes away), `ConnectionWatch`
// against a fake process on a fake clock (what a dropped socket waits for before
// it fails the commands waiting on it); `HydrationBrowser` against a real Chrome
// that is wedged, one that is killed mid-command, and a DevTools stand-in that
// refuses the socket or breaks it.

import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { CHROME_EXIT_WAIT_MS } from "#/test/chrome-teardown";
import { findChrome } from "#/test/print-page-count";
import {
	CDP_SEND_TIMEOUT_MS,
	CdpClient,
	CHROME_LAUNCH_TIMEOUT_MS,
	ConnectionWatch,
	DEFAULT_CLIENT,
	EXIT_REPORT_GRACE_MS,
	HydrationBrowser,
} from "#/test/route-hydration";

const hasChrome = findChrome() !== null;

/**
 * A real launch can take the whole launch budget on a cold runner, and the
 * test then closes Chrome (twice, in the second case). Derived rather than
 * written down, so raising the budget cannot leave the test timing out first.
 */
const REAL_LAUNCH_TEST_MS =
	CHROME_LAUNCH_TIMEOUT_MS + 2 * CHROME_EXIT_WAIT_MS + 10_000;

/** The private fields a test needs to look at, or to break. */
function internals(b: HydrationBrowser) {
	return b as unknown as { chrome: ChildProcess; dir: string; ws: WebSocket };
}

/**
 * Starts watching a command, so its rejection is handled the moment it comes.
 * `done` is the wait for it, in tests that run on real time.
 */
function track(command: Promise<unknown>) {
	const outcome: {
		settled: boolean;
		error: Error | null;
		done: Promise<void>;
	} = { settled: false, error: null, done: Promise.resolve() };
	outcome.done = command.then(
		() => {
			outcome.settled = true;
		},
		(err: Error) => {
			outcome.settled = true;
			outcome.error = err;
		},
	);
	return outcome;
}

/** Runs what fake timers have made due, and the promises it settles. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("HydrationBrowser teardown", () => {
	it("runs in CI: Chrome is present", () => {
		if (!process.env.CI) return;
		expect(hasChrome, "CI has no Chrome on PATH, so this would skip").toBe(
			true,
		);
	});

	it.skipIf(!hasChrome)(
		"stops Chrome before removing its profile, and removes it",
		async () => {
			const b = await HydrationBrowser.launch(DEFAULT_CLIENT, 0);
			const { chrome, dir } = internals(b);
			expect(existsSync(dir)).toBe(true);
			let exitedAtRemoval: boolean | null = null;
			await b.close({
				rm: (d) => {
					exitedAtRemoval =
						chrome.exitCode !== null || chrome.signalCode !== null;
					rmSync(d, { recursive: true, force: true });
				},
			});
			expect(
				exitedAtRemoval,
				"the profile was removed under a live Chrome",
			).toBe(true);
			expect(existsSync(dir)).toBe(false);
		},
		REAL_LAUNCH_TEST_MS,
	);

	it.skipIf(!hasChrome)(
		"never throws, even when the removal does",
		async () => {
			const b = await HydrationBrowser.launch(DEFAULT_CLIENT, 0);
			const { dir } = internals(b);
			await expect(
				b.close({
					rm: () => {
						throw Object.assign(new Error("ENOTEMPTY: directory not empty"), {
							code: "ENOTEMPTY",
						});
					},
				}),
			).resolves.toBeUndefined();
			// The throwing `rm` left it; clean up for real.
			await b.close();
			expect(existsSync(dir)).toBe(false);
		},
		REAL_LAUNCH_TEST_MS,
	);
});

describe("HydrationBrowser launch", () => {
	const scratch = mkdtempSync(join(tmpdir(), "route-hydration-fake-chrome-"));
	afterAll(() => rmSync(scratch, { recursive: true, force: true }));

	/** A shell script standing in for Chrome. */
	function fakeChrome(name: string, body: string) {
		const bin = join(scratch, name);
		writeFileSync(bin, `#!/bin/sh\n${body}\n`);
		chmodSync(bin, 0o755);
		return bin;
	}

	/** What `onSpawn` reported, read back after the launch settles. */
	function spawned() {
		const seen: { pid?: number; dir?: string } = {};
		return {
			seen,
			onSpawn: (s: { pid: number | undefined; dir: string }) => {
				seen.pid = s.pid;
				seen.dir = s.dir;
			},
		};
	}

	const isAlive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};

	/**
	 * A stand-in for Chrome's DevTools endpoint: it lists one page target and
	 * hands the WebSocket upgrade to `onUpgrade`. Its fake Chrome announces it
	 * and sleeps.
	 */
	async function fakeDevTools(
		name: string,
		onUpgrade: (req: IncomingMessage, socket: Duplex) => void,
	) {
		let port = 0;
		const held: Duplex[] = [];
		const server = createServer((_req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify([
					{
						type: "page",
						webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/fake`,
					},
				]),
			);
		});
		server.on("upgrade", (req, socket) => {
			held.push(socket);
			onUpgrade(req, socket);
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		port = (server.address() as AddressInfo).port;
		const bin = fakeChrome(
			name,
			[
				`printf 'DevTools listening on ws://127.0.0.1:${port}/devtools/browser/fake\\n' >&2`,
				"exec sleep 60",
			].join("\n"),
		);
		return {
			bin,
			async stop() {
				for (const socket of held) socket.destroy();
				await new Promise((r) => server.close(r));
			},
		};
	}

	/** The WebSocket handshake, by hand: all a DevTools stand-in needs of it. */
	function acceptWebSocket(req: IncomingMessage, socket: Duplex) {
		const accept = createHash("sha1")
			.update(
				`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
			)
			.digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
	}

	it("waits long enough for the slowest cold start CI has measured", () => {
		// The worst first launch over the 40 \`hydration\` jobs before #1029 was
		// 14.7s, and the old ~15s poll failed twice. An absolute floor, not one
		// stated in terms of the budget: four times that worst case.
		expect(CHROME_LAUNCH_TIMEOUT_MS).toBeGreaterThanOrEqual(4 * 14_700);
		// And a ceiling: a Chrome that hangs instead of dying is waited out in
		// full, so a budget of many minutes would stall the gate for that long.
		expect(CHROME_LAUNCH_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
	});

	it("fails at once, quoting stderr, when Chrome exits while starting", async () => {
		const bin = fakeChrome(
			"dies",
			"echo 'cannot open shared object file: libnss3.so' >&2\nexit 127",
		);
		const { seen, onSpawn } = spawned();
		const started = Date.now();
		const launch = HydrationBrowser.launch(DEFAULT_CLIENT, 0, { bin, onSpawn });
		await expect(launch).rejects.toThrow(/exited while starting \(code 127/);
		await expect(launch).rejects.toThrow(/libnss3\.so/);
		// The budget is a minute; a dead browser must not be waited out.
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(seen.dir).toBeTruthy();
		expect(existsSync(seen.dir as string)).toBe(false);
	});

	it("gives up at its budget when Chrome never answers, and stops it", async () => {
		const bin = fakeChrome("silent", "exec sleep 60");
		const { seen, onSpawn } = spawned();
		const started = Date.now();
		await expect(
			HydrationBrowser.launch(DEFAULT_CLIENT, 0, {
				bin,
				launchTimeoutMs: 300,
				onSpawn,
			}),
		).rejects.toThrow(
			/announced no DevTools endpoint after \d+ms \(budget 300ms\)\. It printed nothing\./,
		);
		// Killing a sleeping process group is immediate; nothing here should
		// come near the teardown's own exit wait.
		expect(Date.now() - started).toBeLessThan(3_000);
		expect(seen.pid).toBeTypeOf("number");
		expect(
			isAlive(seen.pid as number),
			"the hung Chrome was left running",
		).toBe(false);
		expect(seen.dir).toBeTruthy();
		expect(existsSync(seen.dir as string)).toBe(false);
	});

	it("reads the endpoint only once its line is complete, however it is split", async () => {
		// A stand-in DevTools server that only records what it is asked.
		const requests: string[] = [];
		const server = createServer((req, res) => {
			requests.push(req.url ?? "");
			res.setHeader("content-type", "application/json");
			res.end("[]");
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		try {
			const { port } = server.address() as AddressInfo;
			// Split mid-host: \`ws://127.\` alone is a parseable URL, and the wrong one.
			const bin = fakeChrome(
				"split",
				[
					"printf 'DevTools listening on ws://127.' >&2",
					"sleep 0.3",
					`printf '0.0.1:${port}/devtools/browser/fake\\n' >&2`,
					"exec sleep 60",
				].join("\n"),
			);
			await expect(
				HydrationBrowser.launch(DEFAULT_CLIENT, 0, {
					bin,
					launchTimeoutMs: 2_000,
				}),
			).rejects.toThrow(/exposed no page target/);
			expect(requests).toContain("/json/list");
		} finally {
			await new Promise((r) => server.close(r));
		}
	});

	it("gives up at its budget when the DevTools socket never opens, and stops Chrome", async () => {
		// A Chrome that takes the connection and never completes the handshake:
		// the page target is listed, the upgrade is accepted and left hanging.
		const devtools = await fakeDevTools("no-socket", () => {});
		try {
			const { seen, onSpawn } = spawned();
			const started = Date.now();
			await expect(
				HydrationBrowser.launch(DEFAULT_CLIENT, 0, {
					bin: devtools.bin,
					launchTimeoutMs: 1_000,
					onSpawn,
				}),
			).rejects.toThrow(
				/opened no DevTools socket after \d+ms \(budget 1000ms\)/,
			);
			expect(Date.now() - started).toBeLessThan(5_000);
			expect(
				isAlive(seen.pid as number),
				"the hung Chrome was left running",
			).toBe(false);
			expect(existsSync(seen.dir as string)).toBe(false);
		} finally {
			await devtools.stop();
		}
	});

	it("fails at once, not at the deadline, when the DevTools socket is refused", async () => {
		const devtools = await fakeDevTools("refused", (_req, socket) =>
			socket.destroy(),
		);
		try {
			const { seen, onSpawn } = spawned();
			const started = Date.now();
			await expect(
				HydrationBrowser.launch(DEFAULT_CLIENT, 0, {
					bin: devtools.bin,
					launchTimeoutMs: 30_000,
					onSpawn,
				}),
			).rejects.toThrow(
				/Chrome could not open its DevTools socket after \d+ms \(budget 30000ms\)/,
			);
			// The budget is 30s: this was the refusal, not the clock.
			expect(Date.now() - started).toBeLessThan(5_000);
			expect(
				isAlive(seen.pid as number),
				"the refusing Chrome was left running",
			).toBe(false);
			expect(existsSync(seen.dir as string)).toBe(false);
		} finally {
			await devtools.stop();
		}
	});

	it("names a socket that errors under a Chrome that is still up", async () => {
		// Answers the first command with a frame no peer may send (RSV1 set, no
		// extension negotiated): the client fails the connection with an `error`
		// event and only then a `close`, and the first is the one that is named.
		const devtools = await fakeDevTools("garbage", (req, socket) => {
			acceptWebSocket(req, socket);
			socket.once("data", () => socket.write(Buffer.from([0xc1, 0x00])));
		});
		try {
			const started = Date.now();
			await expect(
				HydrationBrowser.launch(DEFAULT_CLIENT, 0, { bin: devtools.bin }),
			).rejects.toThrow(
				/CDP Runtime\.enable was never answered: the DevTools socket errored before any page was loaded\. Chrome is still running\./,
			);
			// Chrome gave no exit to report, so it took the grace, not the budget.
			expect(Date.now() - started).toBeLessThan(EXIT_REPORT_GRACE_MS + 3_000);
		} finally {
			await devtools.stop();
		}
	});
});

describe("CdpClient (#1128)", () => {
	// Fake timers throughout: the client does no I/O, only budgets.
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	/** A wire that records what it is sent; failures name a fixed place. */
	function wire(timeoutMs = 50) {
		const sent: Array<{ id: number; method: string }> = [];
		const cdp = new CdpClient(
			(frame) => {
				sent.push(JSON.parse(frame));
			},
			timeoutMs,
			() => " while on /routes/x. Chrome is still running.",
		);
		return { cdp, sent };
	}

	it("hands an answer to the command with that id, and to nobody else", async () => {
		const { cdp, sent } = wire();
		const first = cdp.send("Runtime.enable");
		const second = cdp.send("Page.enable");
		expect(cdp.answer(sent[1]?.id as number, "second")).toBe(true);
		expect(cdp.answer(sent[0]?.id as number, "first")).toBe(true);
		await expect(first).resolves.toBe("first");
		await expect(second).resolves.toBe("second");
		// Nothing waits for it any more: an event, or a late answer.
		expect(cdp.answer(sent[0]?.id as number, "again")).toBe(false);
		expect(cdp.answer(999, "never asked")).toBe(false);
	});

	it("fails a command nobody answers at its budget, naming the method, the wait and the place", async () => {
		const { cdp } = wire(50);
		const command = track(cdp.send("Runtime.evaluate"));
		await vi.advanceTimersByTimeAsync(49);
		expect(command.settled, "failed before its budget").toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(command.error?.message).toMatch(
			/CDP Runtime\.evaluate got no answer after 50ms \(budget 50ms\) while on \/routes\/x\. Chrome is still running\./,
		);
	});

	it("ignores an answer that arrives after its command gave up", async () => {
		const { cdp, sent } = wire(20);
		const command = track(cdp.send("Runtime.evaluate"));
		await vi.advanceTimersByTimeAsync(20);
		expect(command.error?.message).toMatch(/no answer/);
		expect(cdp.answer(sent[0]?.id as number, "too late")).toBe(false);
	});

	it("gives a command its own budget when it is passed one", async () => {
		// `Page.navigate` is answered only once the server has sent the page: the
		// default budget would fail a route `vite dev` is compiling.
		const { cdp, sent } = wire(50);
		const navigate = track(cdp.send("Page.navigate", {}, 2_000));
		const evaluate = track(cdp.send("Runtime.evaluate"));
		await vi.advanceTimersByTimeAsync(200);
		expect(evaluate.error?.message).toMatch(/budget 50ms/);
		expect(navigate.settled, "failed on the default budget").toBe(false);
		expect(cdp.answer(sent[0]?.id as number, "landed")).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(navigate.error).toBeNull();
		expect(navigate.settled).toBe(true);
	});

	it("fails every waiting command at once when the connection is lost", async () => {
		const { cdp, sent } = wire(30_000);
		const evaluate = track(cdp.send("Runtime.evaluate"));
		const navigate = track(cdp.send("Page.navigate"));
		cdp.lose("the DevTools socket closed (code 1006)");
		// Nothing is left waiting: an answer that straggles in finds nobody.
		expect(cdp.answer(sent[0]?.id as number, "straggler")).toBe(false);
		// No timer was advanced: this is the loss settling them, not a budget.
		await flush();
		expect(evaluate.error?.message).toMatch(
			/CDP Runtime\.evaluate was never answered: the DevTools socket closed \(code 1006\) while on \/routes\/x\. Chrome is still running\./,
		);
		expect(navigate.error?.message).toMatch(
			/CDP Page\.navigate was never answered: the DevTools socket closed/,
		);
	});

	it("stops the clocks of waiting commands when suspended, until the loss settles them", async () => {
		const { cdp } = wire(1_000);
		const command = track(cdp.send("Runtime.evaluate"));
		await vi.advanceTimersByTimeAsync(900);
		cdp.suspend();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(command.settled, "its budget ran out while suspended").toBe(false);
		cdp.lose("the browser process exited");
		await flush();
		expect(command.error?.message).toMatch(
			/was never answered: the browser process exited/,
		);
	});

	it("refuses a command sent after the connection was lost, and writes nothing", async () => {
		const { cdp, sent } = wire(30_000);
		cdp.lose("the browser process exited");
		expect(cdp.isLost).toBe(true);
		await expect(cdp.send("Runtime.evaluate")).rejects.toThrow(
			/CDP Runtime\.evaluate not sent: the browser process exited while on/,
		);
		expect(sent).toEqual([]);
	});

	it("keeps the first reason when the connection is lost twice", async () => {
		const { cdp } = wire(30_000);
		cdp.lose("the DevTools socket closed (code 1006)");
		cdp.lose("the browser was closed by the harness");
		await expect(cdp.send("Runtime.evaluate")).rejects.toThrow(/code 1006/);
	});

	it("fails a command whose frame cannot be written, and leaves nothing waiting", async () => {
		const attempted: Array<{ id: number }> = [];
		const cdp = new CdpClient(
			(frame) => {
				attempted.push(JSON.parse(frame));
				throw new Error("the DevTools socket is not open");
			},
			30_000,
			() => " while on /routes/x.",
		);
		await expect(cdp.send("Runtime.evaluate")).rejects.toThrow(
			/CDP Runtime\.evaluate could not be sent \(the DevTools socket is not open\) while on/,
		);
		expect(attempted).toHaveLength(1);
		expect(cdp.answer(attempted[0]?.id as number, "nobody asked")).toBe(false);
	});

	it("leaves no timer running once every command has settled, however it did", async () => {
		// A budget timer left armed would outlive its command by up to 30s, and a
		// gate sends hundreds of commands.
		let writes = 0;
		const cdp = new CdpClient(
			() => {
				if (++writes === 3) throw new Error("the DevTools socket is not open");
			},
			30_000,
			() => "",
		);
		const answered = track(cdp.send("Runtime.enable"));
		const lost = track(cdp.send("Page.enable"));
		const unwritable = track(cdp.send("Network.enable"));
		expect(vi.getTimerCount()).toBe(2);
		cdp.answer(1, "ok");
		expect(vi.getTimerCount()).toBe(1);
		cdp.lose("the browser process exited");
		expect(vi.getTimerCount()).toBe(0);
		await flush();
		expect([answered, lost, unwritable].every((c) => c.settled)).toBe(true);
	});

	it("bounds one command well inside the hook's 900s, but not inside a slow healthy one", () => {
		// A floor: four times the slowest healthy command measured through this
		// harness (a 2.3s `Runtime.evaluate`; see `CDP_SEND_TIMEOUT_MS`), because a
		// false positive fails a healthy gate.
		expect(CDP_SEND_TIMEOUT_MS).toBeGreaterThanOrEqual(4 * 2_300);
		// A ceiling: a stalled sweep must surface in about a minute, not fifteen.
		expect(CDP_SEND_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
	});

	it("waits for a Chrome's exit report for a second or two, no longer", () => {
		// Paid on a run that is already failing, by every connection loss and by a
		// launch whose Chrome died: long enough for an exit to be reported and
		// stderr to drain, short enough that a Chrome which never says is not
		// waited on for the command budget.
		expect(EXIT_REPORT_GRACE_MS).toBeGreaterThanOrEqual(500);
		expect(EXIT_REPORT_GRACE_MS).toBeLessThanOrEqual(2_000);
	});
});

describe("ConnectionWatch (#1128)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	/** A process that exits and closes on cue, the way Node reports them. */
	class FakeChrome extends EventEmitter {
		signalCode: string | null = null;
		stderr = "";
		exit(signal: string) {
			this.signalCode = signal;
			this.emit("exit", null, signal);
		}
		close() {
			this.emit("close", null, this.signalCode);
		}
	}

	/** A session whose failures say what the fake process looks like by then. */
	function session(budgetMs = 30_000) {
		const chrome = new FakeChrome();
		const cdp = new CdpClient(
			() => {},
			budgetMs,
			() =>
				chrome.signalCode
					? ` while on /routes/x. Chrome exited (signal ${chrome.signalCode}). Its stderr:\n${chrome.stderr}`
					: " while on /routes/x. Chrome is still running.",
		);
		return { chrome, cdp, watch: new ConnectionWatch(cdp, chrome) };
	}

	it("leaves a command to the exit report when its budget runs out inside the grace", async () => {
		// The socket drops at 29.9s into a 30s budget and Chrome says how it ended
		// at 30.1s: the budget must not get in first and say "still running".
		const { chrome, cdp, watch } = session(30_000);
		const command = track(cdp.send("Runtime.evaluate"));
		await vi.advanceTimersByTimeAsync(29_900);
		watch.lost("the DevTools socket closed (code 1006)");
		await vi.advanceTimersByTimeAsync(200);
		expect(command.settled, "its budget ran out during the grace").toBe(false);
		chrome.exit("SIGKILL");
		chrome.close();
		await flush();
		expect(command.error?.message).toMatch(
			/was never answered: the DevTools socket closed \(code 1006\)/,
		);
		expect(command.error?.message).toMatch(/Chrome exited \(signal SIGKILL\)/);
		expect(command.error?.message).not.toMatch(/got no answer/);
	});

	it("settles on the process's close, so stderr that trails the exit is in the message", async () => {
		const { chrome, cdp } = session();
		const command = track(cdp.send("Runtime.evaluate"));
		chrome.exit("SIGSEGV");
		await flush();
		expect(command.settled, "settled on `exit`, before stderr drained").toBe(
			false,
		);
		chrome.stderr += "FATAL: renderer crashed\n";
		chrome.close();
		await flush();
		expect(command.error?.message).toMatch(
			/was never answered: the browser process exited/,
		);
		expect(command.error?.message).toMatch(/FATAL: renderer crashed/);
	});

	it("gives up on a process that never closes, after the grace, with what it has", async () => {
		// A renderer that outlives Chrome holds its stderr open: `close` never comes.
		const { chrome, cdp } = session();
		const command = track(cdp.send("Runtime.evaluate"));
		chrome.exit("SIGKILL");
		await vi.advanceTimersByTimeAsync(EXIT_REPORT_GRACE_MS - 1);
		expect(command.settled, "gave up before the grace").toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(command.error?.message).toMatch(/Chrome exited \(signal SIGKILL\)/);
	});

	it("names a dropped socket under a Chrome that is still running, after the grace", async () => {
		const { cdp, watch } = session();
		const command = track(cdp.send("Runtime.evaluate"));
		watch.lost("the DevTools socket errored");
		await vi.advanceTimersByTimeAsync(EXIT_REPORT_GRACE_MS - 1);
		expect(command.settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(command.error?.message).toMatch(
			/was never answered: the DevTools socket errored while on \/routes\/x\. Chrome is still running\./,
		);
	});

	it("keeps the first reason when the socket and the process both go", async () => {
		const { chrome, cdp, watch } = session();
		const command = track(cdp.send("Runtime.evaluate"));
		watch.lost("the DevTools socket closed (code 1006)");
		chrome.exit("SIGKILL");
		watch.lost("the DevTools socket errored");
		chrome.close();
		await flush();
		expect(command.error?.message).toMatch(/closed \(code 1006\)/);
		expect(command.error?.message).not.toMatch(/errored|process exited/);
		// And no grace timer is left behind to settle it a second time.
		expect(vi.getTimerCount()).toBe(0);
	});

	it("leaves a session the harness already closed alone", async () => {
		const { cdp, watch } = session();
		const command = track(cdp.send("Runtime.evaluate"));
		cdp.lose("the browser was closed by the harness");
		watch.lost("the DevTools socket closed (code 1005)");
		await flush();
		expect(command.error?.message).toMatch(/closed by the harness/);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("HydrationBrowser commands (#1128)", () => {
	// A page whose main thread never returns: the browser stays up and a
	// `Runtime.evaluate` is never answered, which is the stall this guards.
	const WEDGE = "(() => { for (;;) {} })()";

	it.skipIf(!hasChrome)(
		"fails a command a wedged page never answers, at its budget, instead of waiting for ever",
		async () => {
			const b = await HydrationBrowser.launch(DEFAULT_CLIENT, 0, {
				sendTimeoutMs: 1_000,
			});
			try {
				const started = Date.now();
				await expect(b.evaluate(WEDGE)).rejects.toThrow(
					/CDP Runtime\.evaluate got no answer after \d+ms \(budget 1000ms\) before any page was loaded\. Chrome is still running\./,
				);
				expect(Date.now() - started).toBeLessThan(1_000 + 5_000);
			} finally {
				await b.close();
			}
		},
		REAL_LAUNCH_TEST_MS,
	);

	it.skipIf(!hasChrome)(
		"fails a command in flight, at once, when Chrome dies under it, and says how",
		async () => {
			const b = await HydrationBrowser.launch(DEFAULT_CLIENT, 0);
			try {
				const outcome = track(b.evaluate(WEDGE));
				await new Promise((r) => setTimeout(r, 300));
				const started = Date.now();
				process.kill(-(internals(b).chrome.pid as number), "SIGKILL");
				await outcome.done;
				expect(outcome.error?.message).toMatch(
					/CDP Runtime\.evaluate was never answered: /,
				);
				expect(outcome.error?.message).toMatch(
					/Chrome exited \(code null, signal SIGKILL\)/,
				);
				// The budget is 30s: this was the connection going, not the clock.
				expect(Date.now() - started).toBeLessThan(EXIT_REPORT_GRACE_MS + 3_000);
				await expect(b.evaluate("1")).rejects.toThrow(/not sent: /);
			} finally {
				await b.close();
			}
		},
		REAL_LAUNCH_TEST_MS,
	);

	it.skipIf(!hasChrome)(
		"fails a command in flight when the socket drops under a Chrome that is still up",
		async () => {
			// The budget (0.8s) is shorter than the grace (1s): the clock must not be
			// the thing that settles it.
			const b = await HydrationBrowser.launch(DEFAULT_CLIENT, 0, {
				sendTimeoutMs: EXIT_REPORT_GRACE_MS - 200,
			});
			try {
				const started = Date.now();
				const outcome = track(b.evaluate(WEDGE));
				internals(b).ws.close();
				// Closing is synchronous to the socket: a command sent now must say
				// so, not be handed to a socket that drops it without a word.
				await expect(b.evaluate("1")).rejects.toThrow(
					/CDP Runtime\.evaluate could not be sent \(the DevTools socket is not open\)/,
				);
				await outcome.done;
				expect(outcome.error?.message).toMatch(
					/CDP Runtime\.evaluate was never answered: the DevTools socket closed/,
				);
				expect(outcome.error?.message).toMatch(/Chrome is still running\./);
				// Chrome gave no exit to report, so it took the grace, not the budget.
				expect(Date.now() - started).toBeLessThan(EXIT_REPORT_GRACE_MS + 3_000);
			} finally {
				await b.close();
			}
		},
		REAL_LAUNCH_TEST_MS,
	);

	it.skipIf(!hasChrome)(
		"fails a command still waiting when the harness closes the browser",
		async () => {
			const b = await HydrationBrowser.launch(DEFAULT_CLIENT, 0);
			const outcome = track(b.evaluate(WEDGE));
			await new Promise((r) => setTimeout(r, 300));
			await b.close();
			// A sweep still running when another one failed the gate ends here,
			// instead of being left waiting on a browser that was killed.
			await outcome.done;
			expect(outcome.error?.message).toMatch(
				/was never answered: the browser was closed by the harness/,
			);
		},
		REAL_LAUNCH_TEST_MS,
	);

	it.skipIf(!hasChrome)(
		"gives a slow page load its own budget, and names the page a later command stalls on",
		async () => {
			// The headers arrive after the CDP budget: `Page.navigate` is answered
			// only then, so it must be held to the load's budget, not the command's.
			const server = createServer((_req, res) => {
				setTimeout(() => {
					res.setHeader("content-type", "text/html");
					res.end("<!doctype html><title>slow</title><p>hello</p>");
				}, 1_500);
			});
			await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
			const b = await HydrationBrowser.launch(DEFAULT_CLIENT, 0, {
				sendTimeoutMs: 500,
			});
			try {
				const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/slow`;
				// Never hydrates (it is not the app), so this runs to its own 4s budget.
				await expect(b.load(url, 4_000)).resolves.toBe(false);
				await expect(b.evaluate(WEDGE)).rejects.toThrow(
					new RegExp(
						`CDP Runtime\\.evaluate got no answer after \\d+ms \\(budget 500ms\\) while on ${url.replace(/[.]/g, "\\.")}\\. Chrome is still running\\.`,
					),
				);
			} finally {
				await b.close();
				server.closeAllConnections();
				await new Promise((r) => server.close(r));
			}
		},
		REAL_LAUNCH_TEST_MS,
	);
});
