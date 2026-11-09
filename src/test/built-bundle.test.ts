// The built client bundle gate (#1557).
//
// #1550 (3cbeed8f) put a module-scope object built from `#/db/schema` columns
// in a `src/server/` module that client code imports. `vite dev` serves
// modules unbundled and tree-shakes nothing, so the dev-server hydration gate
// stayed green; in the production build the whole Drizzle schema and its
// Node-only dependencies landed in a client chunk that threw
// `ReferenceError: Buffer is not defined` while LOADING, and every page that
// imported it showed the route error page. Nothing loaded the built bundle.
//
// This does: it serves the real `.output` with `node .output/server/index.mjs`,
// loads `/` in headless Chrome, then `import()`s EVERY client chunk under
// `.output/public/assets/`. A chunk that throws on evaluation rejects its
// import; any uncaught page error or failed script request fails the gate too.
// Importing all of them, not the ones a swept route happens to load, is what
// covers every route chunk without fixture data per route.
//
// Needs `bun run build` first, a test database and Chrome. In CI the dedicated
// `Built bundle gate` step sets BUILT_BUNDLE_GATE=1, which makes any of the
// three missing a FAILURE; without it the file skips when `.output` is absent
// (the `check` job's plain test step runs before the build), and the workflow
// step counts what ran so a skip cannot read as a pass.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasTestDb } from "#/test/db";
import { findChrome } from "#/test/print-page-count";
import {
	DEFAULT_CLIENT,
	HydrationBrowser,
	REPO_ROOT,
	startBuiltServer,
	type TestServer,
} from "#/test/route-hydration";

const required = process.env.BUILT_BUNDLE_GATE === "1";
const ASSETS = join(REPO_ROOT, ".output/public/assets");
const built = existsSync(join(REPO_ROOT, ".output/server/index.mjs"));
const chrome = findChrome();
const ready = built && hasTestDb && Boolean(chrome);

/** Client chunks of the production build, as served paths. */
function clientChunks(dir = ASSETS): string[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith(".js"))
		.map((f) => `/assets/${f}`)
		.sort();
}

describe("built client bundle", () => {
	it("is runnable here: build, test database and Chrome all present", () => {
		if (!required) return;
		expect(built, "run `bun run build` first: .output/server is missing").toBe(
			true,
		);
		expect(hasTestDb, "no TEST_DATABASE_URL").toBe(true);
		expect(chrome, "no Chrome on PATH (CHROME_PATH)").toBeTruthy();
	});

	describe.skipIf(!ready)("in Chrome", () => {
		let server: TestServer;
		let browser: HydrationBrowser;

		beforeAll(async () => {
			server = await startBuiltServer({
				databaseUrl: process.env.TEST_DATABASE_URL as string,
			});
			browser = await HydrationBrowser.launch(DEFAULT_CLIENT, 0);
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
			await server?.stop();
		});

		it("loads every client chunk without a module-evaluation error", async () => {
			const chunks = clientChunks();
			// A build that emitted no chunks would pass by having nothing to load.
			expect(chunks.length).toBeGreaterThan(20);

			const res = await browser.sweep(server.base, "/");
			const problems: string[] = [
				...browser.pageErrors().map((e) => `/ raised: ${e}`),
				// Only the app's own requests: web fonts are blocked in the browser.
				...browser
					.failedRequests()
					.filter((r) => r.startsWith(server.base))
					.map((r) => `/ request: ${r}`),
			];

			const list = JSON.stringify(chunks);
			await browser.evaluate(`(() => {
				window.__chunkProbe = null;
				Promise.allSettled(${list}.map((u) => import(u))).then((rs) => {
					window.__chunkProbe = rs.flatMap((r, i) =>
						r.status === "rejected"
							? [${list}[i] + ": " + String(r.reason && (r.reason.stack || r.reason))]
							: [],
					);
				});
				return true;
			})()`);
			let failures: string[] | null = null;
			for (let i = 0; i < 300 && failures === null; i++) {
				failures = await browser.evaluate<string[] | null>(
					"window.__chunkProbe",
				);
				if (failures === null) await new Promise((r) => setTimeout(r, 200));
			}
			expect(failures, "the chunk probe never finished").not.toBeNull();
			problems.push(...(failures ?? []));
			problems.push(
				...browser
					.pageErrors()
					.filter((e) => !problems.some((p) => p.endsWith(e)))
					.map((e) => `uncaught while importing: ${e}`),
			);

			expect(res.hydrated, `/ never hydrated: ${res.text.slice(0, 200)}`).toBe(
				true,
			);
			expect(problems, problems.join("\n")).toEqual([]);
		}, 300_000);
	});
});
