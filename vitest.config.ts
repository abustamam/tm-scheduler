import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const officerImportSuite =
	"src/server/import-officer-term-reopen.integration.test.ts";

export default defineConfig({
	resolve: {
		alias: { "#": resolve(__dirname, "src") },
	},
	test: {
		environment: "node",
		setupFiles: ["src/test/setup-env.ts"],
		// Approval tests exercise database-wide locks. Run them after the other
		// suites so unrelated fixture writes cannot force a roster-only fallback.
		projects: [
			{
				extends: true,
				test: {
					name: "default",
					include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.{ts,tsx}"],
					exclude: [officerImportSuite],
					sequence: { groupOrder: 0 },
				},
			},
			{
				extends: true,
				test: {
					name: "officer-import",
					include: [officerImportSuite],
					sequence: { groupOrder: 1 },
				},
			},
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
