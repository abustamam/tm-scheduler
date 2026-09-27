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
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stopChromeAndRemoveDir } from "./chrome-teardown";
import { readSource } from "./guard-source";

const made: string[] = [];
afterEach(() => {
	for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
	const d = mkdtempSync(join(tmpdir(), "chrome-teardown-"));
	made.push(d);
	return d;
};

/**
 * A process that, like Chrome after SIGKILL, goes on writing into its profile
 * for `lingerMs` and only then emits `exit`.
 */
function lingeringProcess(dir: string | null, lingerMs: number) {
	const proc = new EventEmitter() as EventEmitter & {
		pid: undefined;
		exitCode: number | null;
		signalCode: NodeJS.Signals | null;
		kill: (signal?: string) => boolean;
		exited: boolean;
	};
	proc.pid = undefined;
	proc.exitCode = null;
	proc.signalCode = null;
	proc.exited = false;
	proc.kill = () => {
		setTimeout(() => {
			if (dir) {
				mkdirSync(join(dir, "Default"), { recursive: true });
				writeFileSync(join(dir, "Default", "Preferences"), "{}");
			}
			proc.signalCode = "SIGKILL";
			proc.exited = true;
			proc.emit("exit", null, "SIGKILL");
		}, lingerMs);
		return true;
	};
	return proc;
}

type Proc = Parameters<typeof stopChromeAndRemoveDir>[0];

describe("stopChromeAndRemoveDir (#972)", () => {
	it("removes the directory only after the process has exited", async () => {
		const proc = lingeringProcess(null, 30);
		let exitedAtRemoval: boolean | null = null;
		await stopChromeAndRemoveDir(proc as unknown as Proc, "/unused", {
			rm: () => {
				exitedAtRemoval = proc.exited;
			},
		});
		expect(exitedAtRemoval).toBe(true);
	});

	it("leaves no profile behind when the browser writes after the kill", async () => {
		const dir = tempDir();
		const proc = lingeringProcess(dir, 30);
		await stopChromeAndRemoveDir(proc as unknown as Proc, dir);
		// Let any write still scheduled after an early removal land first.
		await new Promise((r) => setTimeout(r, 60));
		expect(proc.exited).toBe(true);
		expect(existsSync(dir)).toBe(false);
	});

	it("does not wait forever for a process that never reports its exit", async () => {
		const proc = lingeringProcess(null, 60_000);
		let removed = false;
		const started = Date.now();
		await stopChromeAndRemoveDir(proc as unknown as Proc, "/unused", {
			rm: () => {
				removed = true;
			},
			exitWaitMs: 50,
		});
		expect(removed).toBe(true);
		expect(Date.now() - started).toBeLessThan(2_000);
		proc.removeAllListeners();
	});

	it("never fails the caller when the removal throws", async () => {
		const proc = lingeringProcess(null, 0);
		await expect(
			stopChromeAndRemoveDir(proc as unknown as Proc, "/unused", {
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
		await stopChromeAndRemoveDir(proc as unknown as Proc, "/unused", {
			rm: () => {
				removed = true;
			},
			exitWaitMs: 60_000,
		});
		expect(removed).toBe(true);
		proc.removeAllListeners();
	});

	it("kills the whole group of a detached child, grandchildren included", async () => {
		const dir = tempDir();
		const marker = join(dir, "grandchild-alive");
		// A detached parent whose own child keeps writing — Chrome's shape.
		const child = spawn(
			process.execPath,
			[
				"-e",
				`const { spawn } = require("node:child_process");
				spawn(process.execPath, ["-e", ${JSON.stringify(
					`const fs = require("node:fs");
					setInterval(() => {
						fs.mkdirSync(${JSON.stringify(dir)}, { recursive: true });
						fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now()));
					}, 10);
						// Never outlive the test, even when a mutation leaves it running.
						setTimeout(() => process.exit(0), 3000);`,
				)}], { stdio: "ignore" });
				setInterval(() => {}, 1000);`,
			],
			{ detached: true, stdio: "ignore" },
		);
		// Wait until the grandchild is demonstrably writing.
		for (let i = 0; i < 200 && !existsSync(marker); i++) {
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(existsSync(marker)).toBe(true);

		const started = Date.now();
		await stopChromeAndRemoveDir(child, dir);
		await new Promise((r) => setTimeout(r, 100));
		expect(child.signalCode).toBe("SIGKILL");
		// A surviving grandchild would have recreated the marker (and the dir).
		expect(existsSync(dir)).toBe(false);
		// ...or, since teardown waits for the group to empty, held it until the
		// grandchild's own 3s exit. Killed with the group, it is gone at once.
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it("after the leader exits, waits for the rest of its group before removing", async () => {
		const child = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			{
				detached: true,
				stdio: "ignore",
			},
		);
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

	it("gives up on a group that never empties, at the cap", async () => {
		const child = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			{
				detached: true,
				stdio: "ignore",
			},
		);
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
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	// The pipe harness is the one Chrome this repo kills mid-run rather than
	// letting it finish, so it is the one that must tear down through here.
	// Behaviour of the teardown is pinned above; this pins that the harness
	// USES it — the kill-then-rmSync it replaced is otherwise one edit away.
	it("is what the square-flyer PNG harness tears Chrome down with", () => {
		const harness = readSource(
			resolve(__dirname, "../components/agenda/flyer-square-png.test.tsx"),
		);
		expect(harness).toContain("await stopChromeAndRemoveDir(proc, dir)");
		// Without its own process group there is no group to kill.
		expect(harness).toMatch(/detached:\s*true/);
		expect(harness).not.toMatch(/\brmSync\s*\(/);
		expect(harness).not.toMatch(/\.kill\s*\(/);
	});
});
