import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * The route hydration gate (#1000) and its harness's teardown test. They start
 * a vite dev server and sweep every route in Chrome, ~5 minutes in CI, so CI
 * runs them in their own `hydration` job in parallel with `check` (#1022) and
 * `check`'s Test step sets `EXCLUDE_ROUTE_HYDRATION_GATE=1` to leave them out.
 * A plain local `bun run test` sets nothing and still runs them.
 * `bun run test:hydration` runs exactly these; `hydration-gate-ci.guard.test.ts`
 * holds the list, the script and the workflow to each other.
 */
export const HYDRATION_GATE_FILES = [
	"src/routes/route-hydration.test.ts",
	"src/test/route-hydration.test.ts",
];

export default defineConfig({
	resolve: {
		alias: { "#": resolve(__dirname, "src") },
	},
	test: {
		environment: "node",
		setupFiles: ["src/test/setup-env.ts"],
		include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.{ts,tsx}"],
		exclude: [
			...configDefaults.exclude,
			...(process.env.EXCLUDE_ROUTE_HYDRATION_GATE ? HYDRATION_GATE_FILES : []),
		],
		// Vitest's 5s/10s defaults are sized for pure unit tests. ~50 of our suites
		// are DB-backed and run in parallel against ONE Postgres, so a test that
		// takes ~1.5s alone can exceed 5s purely from connection + CPU contention
		// (#290). These ceilings are a guard against a hung test, not a latency
		// budget — a suite that needs them is a suite worth looking at.
		testTimeout: 15_000,
		// beforeEach/afterEach do the seeding and cleanup, so they contend too.
		hookTimeout: 15_000,
	},
});
