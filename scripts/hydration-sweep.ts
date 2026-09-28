/**
 * Ad-hoc inventory: load routes of an ALREADY RUNNING dev server in headless
 * Chrome under a runtime that differs from the server's, and print every React
 * hydration mismatch with the source line React names (#1000).
 *
 *   TZ=UTC ENABLE_DEV_LOGIN=1 BETTER_AUTH_URL=http://localhost:3100 \
 *     bunx vite dev --port 3100 --strictPort
 *   bun scripts/hydration-sweep.ts --base http://localhost:3100 \
 *     --email jordan@example.com /admin/vpe-dashboard /activity …
 *
 * `--email none` sweeps signed out. `--tz` / `--locale` pick the browser's
 * runtime (default America/Los_Angeles + es-ES); run it again with a zone on
 * the far side of UTC (Asia/Tokyo), because a date crosses a day boundary in
 * one direction only. The browser's clock is NOT moved here (the gate's server
 * clock is, and this script does not own the server).
 *
 * The CI gate is `src/routes/route-hydration.test.ts`, which starts its own
 * server over its own fixture; this drives the same harness
 * (`src/test/route-hydration.ts`) against whatever data you point it at.
 *
 * A route that REDIRECTS is reported as not swept, never as clean: the page
 * that answered is not the page asked for. And React stops at the first text
 * node that disagrees, so one finding per route is a floor, not a count.
 */
import {
	describeMismatch,
	HydrationBrowser,
} from "../src/test/route-hydration";

function flag(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = flag("base", "http://localhost:3000");
const EMAIL = flag("email", "jordan@example.com");
const client = {
	timeZone: flag("tz", "America/Los_Angeles"),
	locale: flag("locale", "es-ES"),
};
const routes = process.argv
	.slice(2)
	.filter((a, i, all) => a.startsWith("/") && !all[i - 1]?.startsWith("--"));

if (routes.length === 0) {
	console.error(
		"usage: bun scripts/hydration-sweep.ts [--base URL] [--email E|none] [--tz Z] [--locale L] /route …",
	);
	process.exit(2);
}

let mismatched = 0;
let unswept = 0;
const browser = await HydrationBrowser.launch(client, 0);
try {
	if (EMAIL !== "none") {
		await browser.load(
			`${BASE}/api/dev-login?email=${encodeURIComponent(EMAIL)}&redirect=/about`,
		);
	}
	const rt = await browser.runtime();
	console.log(`browser runtime: ${rt.timeZone} ${rt.locale}`);

	for (const route of routes) {
		const r = await browser.sweep(BASE, route);
		if (r.landed !== route) {
			unswept++;
			console.log(`NOT SWEPT ${route} (redirected to ${r.landed})`);
			continue;
		}
		if (!r.hydrated) {
			unswept++;
			console.log(`NOT SWEPT ${route} (React never hydrated)`);
			continue;
		}
		if (r.mismatches.length) mismatched++;
		console.log(`${r.mismatches.length ? "MISMATCH " : "clean    "} ${route}`);
		for (const m of r.mismatches) {
			console.log(`  ${describeMismatch(route, m)}`);
		}
	}
} finally {
	await browser.close();
}

console.log(
	`\n${mismatched} mismatched, ${unswept} not swept, of ${routes.length} routes`,
);
process.exit(mismatched || unswept ? 1 : 0);
