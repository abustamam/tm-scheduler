import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as navTabs from "#/components/nav-tabs";
import { stripComments } from "#/test/guard-source";
import { NAV_DESTINATIONS, type NavDestination } from "./nav-destinations";

/**
 * The registry is the only place a destination's label is written (#911).
 *
 * Before it, the sidebar, the page crumb, global search and the Officer home
 * each wrote their own string for the same page, and they drifted ("New
 * meeting" / "Schedule a meeting", "Activity" / "Activity log"). What this file
 * checks, and nothing more:
 *
 * - every registered `to` and `alsoActiveOn` path is a real route, keys, routes
 *   and labels are unique, and every static `_authed` route is registered;
 * - every file that imports the registry (derived, not listed) writes no
 *   registered label as a WHOLE WORD anywhere in its string content: a quoted
 *   literal, a template-literal chunk, or a run of JSX text, so a label inside a
 *   composed string ("Manage · Roster", `${x} · Dues`, `Roster {count}`) counts;
 * - the Officer home task tables carry no `label` key at all;
 * - every `alsoActiveOn` page is reachable: it is in a `*_TABS` set, and every
 *   page of that set renders `<NavTabs>` with it.
 *
 * It is lexical, not a parser, so a label assembled from pieces
 * (`"Ros" + "ter"`) or read from somewhere other than the registry passes. The
 * scan reads comment-stripped source: a label in prose cannot render, and the
 * registry's consumers name the pages they serve in their comments.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");
const REGISTRY = NAV_DESTINATIONS as readonly NavDestination[];

function read(rel: string): string {
	return readFileSync(join(SRC, rel), "utf8");
}

/** Every non-test `_authed` route file, with the static path it serves. */
function authedRouteFiles(): { file: string; path: string }[] {
	const authedDir = join(SRC, "routes", "_authed");
	const walk = (dir: string): string[] =>
		readdirSync(dir).flatMap((entry) => {
			const full = join(dir, entry);
			return statSync(full).isDirectory() ? walk(full) : [full];
		});
	return walk(authedDir)
		.map((full) => ({
			file: relative(SRC, full),
			rel: relative(authedDir, full).replace(/\\/g, "/"),
		}))
		.filter(({ rel }) => rel.endsWith(".tsx") && !rel.includes(".test."))
		.map(({ file, rel }) => ({
			file,
			path: `/${rel.replace(/\.tsx$/, "").replace(/\./g, "/")}`.replace(
				/\/index$/,
				"",
			),
		}))
		.filter(({ path }) => !path.includes("$"));
}

/** Every non-test source file that imports the registry. */
function registryConsumers(): string[] {
	const walk = (dir: string): string[] =>
		readdirSync(dir).flatMap((entry) => {
			const full = join(dir, entry);
			return statSync(full).isDirectory() ? walk(full) : [full];
		});
	return walk(SRC)
		.map((full) => relative(SRC, full))
		.filter((rel) => /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel))
		.filter((rel) => rel !== "lib/nav-destinations.ts")
		.filter((rel) => /from "[^"]*nav-destinations"/.test(read(rel)))
		.sort();
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
function writtenStrings(rawSource: string): string[] {
	const source = stripComments(rawSource);
	const out: string[] = [];
	for (const m of source.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) out.push(m[1]);
	for (const m of source.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) out.push(m[1]);
	for (const m of source.matchAll(/`((?:[^`\\]|\\.)*)`/g)) {
		out.push(...m[1].split(/\$\{[^}]*\}/));
	}
	// JSX text: a run between a tag or expression boundary on either side, so
	// `<b>Roster {n}</b>` yields "Roster " as well as `{n}</b>`'s neighbours.
	for (const m of source.matchAll(/[>}]([^<>{}]+)(?=[<{])/g)) out.push(m[1]);
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
		// `superadmin.tsx` is the layout over `superadmin/index.tsx`.
		const paths = [...new Set(authedRouteFiles().map((r) => r.path))];
		expect(paths.length).toBeGreaterThan(0);
		const orphans = paths.filter((p) => !REGISTERED_ROUTES.includes(p));
		expect(orphans).toEqual([]);
	});
});

/** Whether `text` contains `label` as a whole phrase, not inside a longer word. */
function containsLabel(text: string, label: string): boolean {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(text);
}

/**
 * Page-body copy that names a destination in a sentence, on pages #911 was told
 * not to rewrite ("No page body changes"). Exact strings, so any other use of a
 * label in these files still fails. These are prose, not titles: none of them is
 * the page's crumb, nav entry, search result or card.
 */
const PAGE_BODY_PROSE: Record<string, readonly string[]> = {
	"routes/_authed/admin/sync-tokens.tsx": [
		"Tokens authenticate a Pathways sync client pushing",
		"Manual Pathways sync",
	],
};

describe("consumers do not spell a registered label (#911)", () => {
	const labels = REGISTRY.map((d) => d.label);
	const consumers = registryConsumers();

	it("derives the consumers and scans their strings (control)", () => {
		// The derivation must find at least the four surfaces #911 names plus
		// the Officer home route and the tab row, or the loop below is vacuous.
		expect(consumers).toEqual(
			expect.arrayContaining([
				"components/app-shell.tsx",
				"components/club/global-search.tsx",
				"components/nav-tabs.tsx",
				"lib/officer-tasks.ts",
				"routes/_authed/officers.tsx",
			]),
		);
		expect(writtenStrings(read("components/app-shell.tsx"))).toContain(
			"Sign out",
		);
		// Composed strings are caught, not only exact literals.
		const composed = [
			'x = "Manage · Roster";',
			// Built with "$" + "{" so the fixture is not itself a template.
			`x = \`${"$"}{group} · Dues\`;`,
			"<b>Roster {count}</b>",
			"<b>{count} Roster</b>",
		];
		for (const src of composed) {
			expect(
				writtenStrings(src).some((t) =>
					labels.some((l) => containsLabel(t, l)),
				),
				src,
			).toBe(true);
		}
		// Whole words only: "Member profile" does not contain the label "Me".
		expect(containsLabel("Member profile", "Me")).toBe(false);
		expect(containsLabel("Grow the roster.", "Roster")).toBe(false);
	});

	for (const rel of consumers) {
		it(`${rel} writes no registered label`, () => {
			const allowed = PAGE_BODY_PROSE[rel] ?? [];
			const hits = writtenStrings(read(rel)).filter(
				(t) => !allowed.includes(t) && labels.some((l) => containsLabel(t, l)),
			);
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

describe("every alsoActiveOn page is linked by a tab row (#911, #268)", () => {
	// `alsoActiveOn` only HIGHLIGHTS an entry; it links nothing. The sidebar
	// links an entry's `to`, and its siblings are reached only through the
	// `<NavTabs>` row on the pair's pages. Delete that row and the sibling is
	// URL-only again, with the route-coverage check above still green.
	const tabSets = Object.entries(navTabs).filter(
		(entry): entry is [string, readonly navTabs.NavTab[]] =>
			entry[0].endsWith("_TABS"),
	);
	const routeFiles = authedRouteFiles();

	it("finds the tab sets (control)", () => {
		expect(tabSets.map(([name]) => name).sort()).toEqual([
			"NEW_MEETINGS_TABS",
			"PATHWAYS_SYNC_TABS",
		]);
	});

	it("puts every alsoActiveOn route in some *_TABS set", () => {
		const tabbed = new Set<string>(
			tabSets.flatMap(([, tabs]) => tabs.map((t) => t.to)),
		);
		const siblings = REGISTRY.flatMap((d) => d.alsoActiveOn ?? []);
		expect(siblings.length).toBeGreaterThan(0);
		expect(siblings.filter((to) => !tabbed.has(to))).toEqual([]);
	});

	for (const [name, tabs] of tabSets) {
		for (const tab of tabs) {
			it(`${tab.to} renders <NavTabs tabs={${name}}>`, () => {
				const route = routeFiles.find((r) => r.path === tab.to);
				expect(route, `no _authed route file serves ${tab.to}`).toBeDefined();
				const source = stripComments(read(route?.file ?? ""));
				expect(source).toMatch(
					new RegExp(`<NavTabs\\b[^>]*\\btabs=\\{${name}\\}`),
				);
			});
		}
	}
});
