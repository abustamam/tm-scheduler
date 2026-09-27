/**
 * Stop a Chrome the test spawned and remove its profile directory, without
 * racing the browser (#972).
 *
 * `proc.kill()` only SENDS the signal. Chrome and its child processes (the
 * renderer, the GPU and network services) can still be writing into the
 * profile directory — `Default/` especially — while `rmSync` walks it, so the
 * final `rmdir` sees a new entry and throws `ENOTEMPTY`. That turned CI red on
 * docs-only commits, 3 of 4 `check` runs, with every assertion passing.
 *
 * So, in order:
 *   1. kill the whole process GROUP when the child leads one (spawned with
 *      `detached: true`), so the children stop writing too, not just the
 *      parent — falling back to the parent alone;
 *   2. WAIT for the parent to exit, and then for every member of the group to
 *      be gone: the parent's `exit` arrives while its children are still being
 *      torn down. Waiting on the parent alone still left the directory behind
 *      on full-suite runs here (6 of 6 exports), holding only a network
 *      service temp file and a cache index, i.e. written after the removal. Both
 *      waits are capped — a process that never reports is not a reason to
 *      hang the suite;
 *   3. remove the directory with retries, for anything that still slips in;
 *   4. and swallow whatever is left: a temp dir the OS will reap anyway must
 *      never fail a test whose result was fine.
 */
import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";

/** How long to wait for a killed Chrome (and its group) to be gone. */
export const CHROME_EXIT_WAIT_MS = 5_000;

type Teardown = {
	/** Replaceable so a test can observe WHEN the removal happens. */
	rm?: (dir: string) => void;
	/** Replaceable so a test can hold a group member alive. */
	groupAlive?: (pgid: number) => boolean;
	exitWaitMs?: number;
};

const removeDir = (dir: string) =>
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

/** Signal 0 checks existence: it succeeds while ANY member of the group lives. */
const anyMemberAlive = (pgid: number) => {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
};

export async function stopChromeAndRemoveDir(
	proc: ChildProcess,
	dir: string,
	{
		rm = removeDir,
		groupAlive = anyMemberAlive,
		exitWaitMs = CHROME_EXIT_WAIT_MS,
	}: Teardown = {},
): Promise<void> {
	const deadline = Date.now() + exitWaitMs;
	const exited = waitForExit(proc, exitWaitMs);
	const pgid = killGroup(proc);
	await exited;
	if (pgid !== null) {
		while (groupAlive(pgid) && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 10));
		}
	}
	try {
		rm(dir);
	} catch {
		// Best-effort: see step 4 above.
	}
}

function waitForExit(proc: ChildProcess, capMs: number): Promise<void> {
	if (proc.exitCode !== null || proc.signalCode !== null) {
		return Promise.resolve();
	}
	return new Promise((done) => {
		const timer = setTimeout(done, capMs);
		proc.once("exit", () => {
			clearTimeout(timer);
			done();
		});
	});
}

/** The group killed, or null when only the parent could be signalled. */
function killGroup(proc: ChildProcess): number | null {
	if (proc.pid !== undefined) {
		try {
			// A negative pid signals the process group the child leads.
			process.kill(-proc.pid, "SIGKILL");
			return proc.pid;
		} catch {
			// Not a group leader (spawned without `detached`), or already gone.
		}
	}
	proc.kill("SIGKILL");
	return null;
}
