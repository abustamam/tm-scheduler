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

import type { ChildProcess } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CHROME_EXIT_WAIT_MS } from "#/test/chrome-teardown";
import { findChrome } from "#/test/print-page-count";
import {
	CHROME_LAUNCH_TIMEOUT_MS,
	DEFAULT_CLIENT,
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

/** The two private fields a teardown test needs to look at. */
function internals(b: HydrationBrowser) {
	return b as unknown as { chrome: ChildProcess; dir: string };
}

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

	/** A shell script standing in for Chrome, recording the args it got. */
	function fakeChrome(name: string, body: string) {
		const bin = join(scratch, name);
		const args = join(scratch, `${name}.args`);
		writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${args}'\n${body}\n`);
		chmodSync(bin, 0o755);
		return {
			bin,
			profile: () =>
				readFileSync(args, "utf8")
					.split("\n")
					.find((a) => a.startsWith("--user-data-dir="))
					?.slice("--user-data-dir=".length),
		};
	}

	it("fails at once, quoting stderr, when Chrome exits while starting", async () => {
		const fake = fakeChrome(
			"dies",
			"echo 'cannot open shared object file: libnss3.so' >&2\nexit 127",
		);
		const started = Date.now();
		const launch = HydrationBrowser.launch(DEFAULT_CLIENT, 0, {
			bin: fake.bin,
		});
		await expect(launch).rejects.toThrow(/exited while starting \(code 127/);
		await expect(launch).rejects.toThrow(/libnss3\.so/);
		// The budget is a minute; a dead browser must not be waited out.
		expect(Date.now() - started).toBeLessThan(5_000);
		const profile = fake.profile();
		expect(profile).toBeTruthy();
		expect(existsSync(profile as string)).toBe(false);
	});

	it("gives up at its budget when Chrome never answers, and stops it", async () => {
		const fake = fakeChrome("silent", "exec sleep 60");
		const started = Date.now();
		await expect(
			HydrationBrowser.launch(DEFAULT_CLIENT, 0, {
				bin: fake.bin,
				launchTimeoutMs: 300,
			}),
		).rejects.toThrow(
			/announced no DevTools endpoint after \d+ms \(budget 300ms\)\. It printed nothing\./,
		);
		expect(Date.now() - started).toBeLessThan(300 + CHROME_EXIT_WAIT_MS);
		const profile = fake.profile();
		expect(profile).toBeTruthy();
		expect(existsSync(profile as string)).toBe(false);
	});
});
