/**
 * `stopChromeAndRemoveDir` (#972) — the teardown must not race the browser.
 *
 * The CI failure itself (`ENOTEMPTY` from an `rmdir` that lost a race with
 * Chrome's children) cannot be produced on demand: it needs a writer to land
 * between `rmSync`'s readdir and its rmdir. So these drive a stand-in process
 * whose timing is ours — it keeps writing into the profile directory after the
 * kill and only then reports its exit, exactly the window Chrome has — and pin
 * the three properties that close the race: the removal waits for the exit,
 * the wait is capped, and a failed removal never fails the caller.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stopChromeAndRemoveDir } from "./chrome-teardown";
import { readSource } from "./guard-source";

const made: string[] = [];
const groups: ChildProcess[] = [];
afterEach(() => {
	// Kill every stand-in group FIRST, whatever the test did: a detached child is
	// setsid'd, so nothing else (not even Ctrl-C) reaches it, and a surviving
	// writer would recreate a directory removed below.
	for (const child of groups.splice(0)) {
		try {
			if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
		} catch {
			// ESRCH: the teardown under test already killed it.
		}
	}
	for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
	const d = mkdtempSync(join(tmpdir(), "chrome-teardown-"));
	made.push(d);
	return d;
};

/** Every stand-in exits on its own after this, even if nothing kills it. */
const SELF_EXIT = "setTimeout(() => process.exit(0), 30000);";

/** A detached node process (its own group) running `script`, killed in afterEach. */
function spawnGroup(script: string): ChildProcess {
	const child = spawn(process.execPath, ["-e", `${script}\n${SELF_EXIT}`], {
		detached: true,
		stdio: "ignore",
	});
	groups.push(child);
	return child;
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/**
 * A process that, like Chrome after SIGKILL, goes on writing into its profile
 * for `lingerMs` and only then emits `exit`.
 */
function lingeringProcess(dir: string | null, lingerMs: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const proc = Object.assign(new EventEmitter(), {
		pid: undefined,
		exitCode: null as number | null,
		signalCode: null as NodeJS.Signals | null,
		exited: false,
		kill: () => {
			timer = setTimeout(() => {
				if (dir) {
					mkdirSync(join(dir, "Default"), { recursive: true });
					writeFileSync(join(dir, "Default", "Preferences"), "{}");
				}
				proc.signalCode = "SIGKILL";
				proc.exited = true;
				proc.emit("exit", null, "SIGKILL");
			}, lingerMs);
			return true;
		},
		/** Cancel a still-pending exit, so no timer outlives the test. */
		dispose: () => {
			clearTimeout(timer);
			proc.removeAllListeners();
		},
	});
	/** Typed as the ChildProcess the helper takes; it reads only the above. */
	return Object.assign(proc, { asChild: proc as unknown as ChildProcess });
}

describe("stopChromeAndRemoveDir (#972)", () => {
	it("removes the directory only after the process has exited", async () => {
		const proc = lingeringProcess(null, 30);
		let exitedAtRemoval: boolean | null = null;
		await stopChromeAndRemoveDir(proc.asChild, "/unused", {
			rm: () => {
				exitedAtRemoval = proc.exited;
			},
		});
		expect(exitedAtRemoval).toBe(true);
	});

	it("leaves no profile behind when the browser writes after the kill", async () => {
		const dir = tempDir();
		const proc = lingeringProcess(dir, 30);
		await stopChromeAndRemoveDir(proc.asChild, dir);
		// Let any write still scheduled after an early removal land first.
		await new Promise((r) => setTimeout(r, 60));
		expect(proc.exited).toBe(true);
		expect(existsSync(dir)).toBe(false);
	});

	// An uncapped wait never returns here (the stand-in's exit is 60s away), so
	// it fails at vitest's timeout; the elapsed bound is only a loose backstop.
	it("does not wait forever for a process that never reports its exit", async () => {
		const proc = lingeringProcess(null, 60_000);
		let removed = false;
		const started = Date.now();
		try {
			await stopChromeAndRemoveDir(proc.asChild, "/unused", {
				rm: () => {
					removed = true;
				},
				exitWaitMs: 50,
			});
		} finally {
			proc.dispose();
		}
		expect(removed).toBe(true);
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("never fails the caller when the removal throws", async () => {
		const proc = lingeringProcess(null, 0);
		await expect(
			stopChromeAndRemoveDir(proc.asChild, "/unused", {
				rm: () => {
					throw Object.assign(new Error("ENOTEMPTY: directory not empty"), {
						code: "ENOTEMPTY",
					});
				},
			}),
		).resolves.toBeUndefined();
	});

	it("does not wait on a process that has already exited", async () => {
		const proc = lingeringProcess(null, 60_000);
		proc.exitCode = 0;
		let removed = false;
		try {
			await stopChromeAndRemoveDir(proc.asChild, "/unused", {
				rm: () => {
					removed = true;
				},
				exitWaitMs: 60_000,
			});
		} finally {
			proc.dispose();
		}
		expect(removed).toBe(true);
	});

	it("kills the whole group of a detached child, grandchildren included", async () => {
		const dir = tempDir();
		const pidFile = join(dir, "grandchild.pid");
		const marker = join(dir, "grandchild-alive");
		// A detached parent whose own child keeps writing — Chrome's shape. The
		// grandchild announces its pid, then rewrites the directory every 10ms.
		const child = spawnGroup(
			`require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(
				`const fs = require("node:fs");
				fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
				setInterval(() => {
					fs.mkdirSync(${JSON.stringify(dir)}, { recursive: true });
					fs.writeFileSync(${JSON.stringify(marker)}, "x");
				}, 10);
				${SELF_EXIT}`,
			)}], { stdio: "ignore" });
			setInterval(() => {}, 1000);`,
		);
		// Readiness handshake with a generous cap: two node startups under a
		// loaded full-suite run are slow, and this is not what is being timed.
		for (let i = 0; i < 300 && !existsSync(marker); i++) {
			await new Promise((r) => setTimeout(r, 50));
		}
		const grandchild = Number(readFileSync(pidFile, "utf8"));
		expect(alive(grandchild)).toBe(true);

		await stopChromeAndRemoveDir(child, dir);
		expect(child.signalCode).toBe("SIGKILL");
		// Not a timing bound: the grandchild's own exit is 30s away, so it is
		// dead now only because the group kill reached it...
		expect(alive(grandchild)).toBe(false);
		// ...and so nothing is left to recreate the directory.
		await new Promise((r) => setTimeout(r, 100));
		expect(existsSync(dir)).toBe(false);
	});

	it("after the leader exits, waits for the rest of its group before removing", async () => {
		const child = spawnGroup("setInterval(() => {}, 1000);");
		await new Promise((r) => child.once("spawn", r));
		// A member still being torn down after the leader's exit: alive for
		// three polls. Only the probe is faked; the kill and the exit are real.
		let polls = 0;
		let pollsAtRemoval = -1;
		await stopChromeAndRemoveDir(child, "/unused", {
			groupAlive: () => ++polls <= 3,
			rm: () => {
				pollsAtRemoval = polls;
			},
		});
		expect(child.signalCode).toBe("SIGKILL");
		expect(pollsAtRemoval).toBe(4);
	});

	// As above: uncapped, the probe below never goes false and the test hits
	// vitest's timeout; the elapsed bound is a loose backstop.
	it("gives up on a group that never empties, at the cap", async () => {
		const child = spawnGroup("setInterval(() => {}, 1000);");
		await new Promise((r) => child.once("spawn", r));
		let removed = false;
		const started = Date.now();
		await stopChromeAndRemoveDir(child, "/unused", {
			groupAlive: () => true,
			rm: () => {
				removed = true;
			},
			exitWaitMs: 200,
		});
		expect(removed).toBe(true);
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	// The pipe harness is the one Chrome this repo kills mid-run rather than
	// letting it finish, so it is the one that must tear down through here.
	// Behaviour of the teardown is pinned above; this pins that the harness
	// USES it — the kill-then-rmSync it replaced is otherwise one edit away.
	it("is what the square-flyer PNG harness tears Chrome down with", () => {
		const path = resolve(
			__dirname,
			"../components/agenda/flyer-square-png.test.tsx",
		);
		// Presence checks read comment-blind, so a comment cannot satisfy them.
		const code = readSource(path);
		expect(code).toContain("await stopChromeAndRemoveDir(proc, dir)");
		// Without its own process group there is no group to kill.
		expect(code).toMatch(/detached:\s*true/);
		// Absence checks read RAW (guard-source.ts: stripping would loosen them).
		const raw = readFileSync(path, "utf8");
		expect(raw).not.toMatch(/\brmSync\s*\(/);
		expect(raw).not.toMatch(/\.kill\s*\(/);
	});
});
