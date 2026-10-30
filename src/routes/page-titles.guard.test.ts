import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NAV_DESTINATIONS, type NavDestination } from "#/lib/nav-destinations";
import { stripComments } from "#/test/guard-source";

/**
 * Every route names its tab (#1422).
 *
 * Source reads, comment-blind (a comment saying "head: title" is not a title).
 * Lexical, not a parser: it proves the `head` block of each route file contains a
 * `title`, and that a registered destination's route builds it from `navPageTitle`.
 * It does not prove the string a title renders as; the component test does that
 * for one route.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Layout routes: they render `<Outlet />` or a shell and the leaf below names
 * the page. `club.$clubId.tsx` is the public club shell, whose children set
 * their own `shareMeta` titles.
 */
const LAYOUT_ROUTES = new Set([
	"__root.tsx",
	"_authed.tsx",
	"_authed/superadmin.tsx",
	"club.$clubId.tsx",
	// Not a layout: a leaf whose `head` sets only robots noindex, with no title
	// (found while writing this guard; #1422 did not list it). Naming a title
	// there is a follow-up to the issue, so the gap is held here, visibly.
	"club.$clubId_.meeting.$meetingId.present.tsx",
]);

function routeFiles(): string[] {
	const walk = (dir: string): string[] =>
		readdirSync(dir).flatMap((entry) => {
			const full = join(dir, entry);
			return statSync(full).isDirectory() ? walk(full) : [full];
		});
	return walk(HERE)
		.map((full) => relative(HERE, full).replace(/\\/g, "/"))
		.filter((rel) => rel.endsWith(".tsx") && !/\.test\.tsx?$/.test(rel))
		.sort();
}

/** The source from `head:` to the end of the file, comments removed, or null. */
function headSource(rel: string): string | null {
	const source = stripComments(readFileSync(join(HERE, rel), "utf8"));
	const at = source.search(/^\t+head:/m);
	return at === -1 ? null : source.slice(at);
}

/** `_authed/admin/dues.tsx` -> `/admin/dues`; `index` collapses to its folder. */
function authedPath(rel: string): string {
	return `/${rel
		.replace(/^_authed\//, "")
		.replace(/\.tsx$/, "")
		.replace(/\./g, "/")}`.replace(/\/index$/, "");
}

describe("route page titles", () => {
	// protects=no route ships a tab that reads "GavelUp" alone: a new route without a head title fails here by name (#1422)
	// fails_when=a non-layout route file has no `head:` carrying `title`, or the exempt list grows without a reason
	// no_claim=does not prove the title is the right words, or that the layout exemptions stay layouts
	it("every route outside the layout list defines head with a title", () => {
		const files = routeFiles();
		for (const exempt of LAYOUT_ROUTES) {
			expect(files, `exempt ${exempt} no longer exists`).toContain(exempt);
		}
		const missing = files.filter((rel) => {
			if (LAYOUT_ROUTES.has(rel)) return false;
			const head = headSource(rel);
			return head === null || !/\btitle\b/.test(head);
		});
		expect(missing, `routes with no head title: ${missing.join(", ")}`).toEqual(
			[],
		);
	});

	// protects=a registered destination's page title reads its label from the registry, so the sidebar and the tab cannot drift apart
	// fails_when=an `_authed` route whose path (or alsoActiveOn sibling) is registered retypes the label or omits navPageTitle(<path>) from its head
	// no_claim=does not cover routes outside the registry, and does not run the head
	it("registered routes build their title from the registry", () => {
		const files = new Set(routeFiles());
		const registry = NAV_DESTINATIONS as readonly NavDestination[];
		const registered = registry.flatMap((d) => [
			d.to,
			...(d.alsoActiveOn ?? []),
		]);
		const covered: string[] = [];
		const wrong: string[] = [];
		for (const rel of files) {
			if (!rel.startsWith("_authed/") || LAYOUT_ROUTES.has(rel)) continue;
			const path = authedPath(rel);
			if (!registered.includes(path)) continue;
			covered.push(path);
			const head = headSource(rel);
			if (!head?.includes(`navPageTitle("${path}"`)) wrong.push(rel);
		}
		expect(wrong, `routes not using navPageTitle: ${wrong.join(", ")}`).toEqual(
			[],
		);
		// A registered path with no route file would pass vacuously above.
		const withoutRoute = registered.filter(
			(p) => !covered.includes(p) && files.has(`_authed${p}.tsx`),
		);
		expect(withoutRoute).toEqual([]);
		expect(covered.length).toBeGreaterThan(20);
	});
});
