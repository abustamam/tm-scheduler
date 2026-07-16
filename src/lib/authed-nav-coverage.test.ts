import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Discoverability guard (#268): every user-facing `_authed` route must have at
 * least one in-app nav link in the sidebar (`src/routes/_authed.tsx`), so live
 * routes can't quietly become URL-only/orphaned again (as `/admin/pathways-sync`,
 * `/admin/meetings/batch`, `/admin/dcp`, and `/me` all had).
 *
 * Dynamic routes (`$param`, e.g. `/meetings/$id`, `/members/$id`) are reached
 * contextually rather than from a static nav, so they're exempt. If you add a
 * new static `_authed` route, add a `NavItem` for it (respecting role gating) —
 * or, for a deliberately contextual-only route, this list's exemption rule.
 */
const routesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "routes");
const authedDir = join(routesDir, "_authed");
const authedSource = readFileSync(join(routesDir, "_authed.tsx"), "utf8");

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		return statSync(full).isDirectory() ? walk(full) : [full];
	});
}

/** A file under `_authed/` → its static route path, or null if not navigable. */
function routePathFor(file: string): string | null {
	const rel = relative(authedDir, file).replace(/\\/g, "/");
	if (!rel.endsWith(".tsx") || rel.includes(".test.")) return null;
	// Flat-route convention: `.` separates path segments; `index` = parent path.
	const path = `/${rel.replace(/\.tsx$/, "").replace(/\./g, "/")}`.replace(
		/\/index$/,
		"",
	);
	// Dynamic routes (`$id`, `$clubId`) aren't reachable from a static nav.
	if (path.includes("$")) return null;
	return path || "/";
}

describe("every user-facing _authed route is linked in the sidebar (#268)", () => {
	const routePaths = [
		...new Set(
			walk(authedDir)
				.map(routePathFor)
				.filter((p): p is string => p !== null),
		),
	];

	it("discovers routes to check", () => {
		expect(routePaths.length).toBeGreaterThan(0);
	});

	it('has a `to="…"` sidebar entry for each', () => {
		const orphans = routePaths.filter(
			(path) => !authedSource.includes(`to="${path}"`),
		);
		expect(orphans).toEqual([]);
	});
});
