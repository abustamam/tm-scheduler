import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NAV_DESTINATIONS, type NavDestination } from "./nav-destinations";

/**
 * The registry is the only place a destination's label is written (#911).
 *
 * Before it, the sidebar, the page crumb, global search and the Officer home
 * each wrote their own string for the same page, and they drifted ("New
 * meeting" / "Schedule a meeting", "Activity" / "Activity log"). This file makes
 * that drift fail loudly: the consumers may not spell a registered label as a
 * literal, the Officer home task tables may not carry a `label` at all, and
 * every registered route must exist.
 *
 * The literal scan reads the RAW source, comments included. It is an
 * "offender list must be empty" guard, and for those a comment can only cause a
 * false failure, never a false pass — stripping comments would loosen it (see
 * `src/test/guard-source.ts`).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");
const REGISTRY = NAV_DESTINATIONS as readonly NavDestination[];

const CONSUMERS = [
	"components/app-shell.tsx",
	"components/club/global-search.tsx",
	"lib/officer-tasks.ts",
] as const;

function read(rel: string): string {
	return readFileSync(join(SRC, rel), "utf8");
}

/** Every route the registry names: each `to` and each `alsoActiveOn`. */
const REGISTERED_ROUTES = REGISTRY.flatMap((d) => [
	d.to,
	...(d.alsoActiveOn ?? []),
]);

/** The `to` paths the generated route tree declares. */
function routeTreePaths(): Set<string> {
	const tree = read("routeTree.gen.ts");
	const block = /export interface FileRoutesByTo \{([\s\S]*?)\n\}/.exec(tree);
	expect(block, "FileRoutesByTo not found in routeTree.gen.ts").not.toBeNull();
	return new Set(
		[...(block?.[1] ?? "").matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]),
	);
}

/**
 * The string contents a file writes: quoted literals, the static chunks of
 * template literals, and JSX text. Lexical, not a parser — good enough to find a
 * label spelled out, which is all this is for.
 */
function writtenStrings(source: string): string[] {
	const out: string[] = [];
	for (const m of source.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) out.push(m[1]);
	for (const m of source.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) out.push(m[1]);
	for (const m of source.matchAll(/`((?:[^`\\]|\\.)*)`/g)) {
		out.push(...m[1].split(/\$\{[^}]*\}/));
	}
	for (const m of source.matchAll(/>([^<>{}]+)</g)) out.push(m[1]);
	return out.map((s) => s.trim()).filter(Boolean);
}

describe("nav destination registry (#911)", () => {
	it("registers destinations to check (control)", () => {
		expect(REGISTRY.length).toBeGreaterThan(10);
	});

	it("resolves every to and alsoActiveOn to a route in routeTree.gen.ts", () => {
		const routes = routeTreePaths();
		// Control: a broken parse would report every route missing.
		expect(routes.has("/roster")).toBe(true);
		const missing = REGISTERED_ROUTES.filter((to) => !routes.has(to));
		expect(missing).toEqual([]);
	});

	it("has unique keys, routes and labels", () => {
		const dupes = (xs: readonly string[]) =>
			xs.filter((x, i) => xs.indexOf(x) !== i);
		expect(dupes(REGISTRY.map((d) => d.key))).toEqual([]);
		// Across `to` AND `alsoActiveOn`: one route belonging to two entries
		// would make which one highlights depend on declaration order.
		expect(dupes(REGISTERED_ROUTES)).toEqual([]);
		expect(dupes(REGISTRY.map((d) => d.label))).toEqual([]);
	});

	it("links every static _authed route from the nav", () => {
		// The #268 discoverability invariant, restated against the registry now
		// that the sidebar has no `to="…"` literals to grep. A page reached only
		// through a tab row is covered by being its entry's `alsoActiveOn`.
		const authedDir = join(SRC, "routes", "_authed");
		const walk = (dir: string): string[] =>
			readdirSync(dir).flatMap((entry) => {
				const full = join(dir, entry);
				return statSync(full).isDirectory() ? walk(full) : [full];
			});
		const paths = walk(authedDir)
			.map((file) => relative(authedDir, file).replace(/\\/g, "/"))
			.filter((rel) => rel.endsWith(".tsx") && !rel.includes(".test."))
			.map((rel) =>
				`/${rel.replace(/\.tsx$/, "").replace(/\./g, "/")}`.replace(
					/\/index$/,
					"",
				),
			)
			.filter((path) => !path.includes("$"))
			// `superadmin.tsx` is the layout over `superadmin/index.tsx`.
			.filter((path, i, all) => all.indexOf(path) === i);
		expect(paths.length).toBeGreaterThan(0);
		const orphans = paths.filter((p) => !REGISTERED_ROUTES.includes(p));
		expect(orphans).toEqual([]);
	});
});

describe("consumers do not spell a registered label (#911)", () => {
	const labels = new Set(REGISTRY.map((d) => d.label));

	it("finds the strings each consumer writes (control)", () => {
		// A scanner that silently returned nothing would pass the check below.
		expect(writtenStrings(read("components/app-shell.tsx"))).toContain(
			"Sign out",
		);
		expect(writtenStrings(read("lib/officer-tasks.ts"))).toContain(
			"Every recent change.",
		);
		expect(writtenStrings('x = "Roster";')).toEqual(["Roster"]);
		expect(writtenStrings("<b>Roster</b>")).toContain("Roster");
	});

	for (const rel of CONSUMERS) {
		it(`${rel} writes no registered label`, () => {
			const hits = writtenStrings(read(rel)).filter((s) => labels.has(s));
			expect(hits).toEqual([]);
		});
	}

	it("officer-tasks.ts task tables carry no label of their own", () => {
		// Any `label`, not only a registered string: a card that names its page
		// in its own words is the drift this registry exists to end, whatever
		// the words are. Scoped to the two tables, because `OfficerHomeSection`
		// below them legitimately carries the OFFICE's label ("President").
		const source = read("lib/officer-tasks.ts");
		const start = source.indexOf("export const COMMON_TASKS");
		const end = source.indexOf("export interface OfficerHomeSection");
		expect(start, "COMMON_TASKS not found").toBeGreaterThan(-1);
		expect(end, "OfficerHomeSection not found").toBeGreaterThan(start);
		expect(source.slice(start, end)).not.toMatch(/\blabel\s*:/);
	});
});
