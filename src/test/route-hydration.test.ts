// The route hydration harness's teardown (#1000).
//
// The gate failed in CI once with every assertion green:
// `ENOTEMPTY: directory not empty, rmdir '/tmp/route-hydration-chrome-…/Default'`.
// Chrome's renderers were still writing the profile when it was removed, and
// the error escaped `afterAll`. These pin both halves of the fix: Chrome and
// its whole group are gone before the directory goes, and a removal that fails
// anyway is swallowed, because a cleanup hiccup must never fail the gate.

import type { ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findChrome } from "#/test/print-page-count";
import { DEFAULT_CLIENT, HydrationBrowser } from "#/test/route-hydration";

const hasChrome = findChrome() !== null;

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
		30_000,
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
		30_000,
	);
});
