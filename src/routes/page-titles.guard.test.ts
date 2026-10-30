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
 * their own `shareMeta` titles. Layouts only: a leaf never belongs here.
 */
const LAYOUT_ROUTES = new Set([
	"__root.tsx",
	"_authed.tsx",
	"_authed/superadmin.tsx",
	"club.$clubId.tsx",
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

/**
 * The text of the `head` property's own expression, comments removed, or null.
 * Balanced over () [] {} (string literals skipped), ending at the `,` that closes
 * the property or at the bracket that closes the route options. A later JSX
 * `title=` prop in the same file is outside it.
 */
function headExpression(source: string): string | null {
	const clean = stripComments(source);
	const at = clean.search(/^\t+head:/m);
	if (at === -1) return null;
	const start = clean.indexOf("head:", at) + "head:".length;
	let depth = 0;
	for (let i = start; i < clean.length; i++) {
		const ch = clean[i];
		if (ch === '"' || ch === "'" || ch === "`") {
			i++;
			while (i < clean.length && clean[i] !== ch)
				i += clean[i] === "\\" ? 2 : 1;
		} else if ("([{".includes(ch)) {
			depth++;
		} else if (")]}".includes(ch)) {
			depth--;
			if (depth < 0) return clean.slice(start, i);
		} else if (ch === "," && depth === 0) {
			return clean.slice(start, i);
		}
	}
	return clean.slice(start);
}

/** True when the head expression sets a `title:` key (or the `title,` shorthand). */
function headHasTitle(head: string | null): boolean {
	return head !== null && /\btitle\s*:|[{,]\s*title\s*[,}]/.test(head);
}

/** Registered paths no `_authed` route file serves. */
function unroutedPaths(
	registered: readonly string[],
	routePaths: ReadonlySet<string>,
): string[] {
	return registered.filter((p) => !routePaths.has(p));
}

function headSource(rel: string): string | null {
	return headExpression(readFileSync(join(HERE, rel), "utf8"));
}

/** `_authed/admin/dues.tsx` -> `/admin/dues` (a top-level file keeps its path); `index` collapses to its folder. */
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
			return !headHasTitle(head);
		});
		expect(missing, `routes with no head title: ${missing.join(", ")}`).toEqual(
			[],
		);
	});

	// protects=a registered destination's page title reads its label from the registry, so the sidebar and the tab cannot drift apart
	// fails_when=the `_authed` route at a destination's own `to` retypes the label or omits navPageTitle(<to>) from its head expression; or a registered path has no route file
	// no_claim=does not cover alsoActiveOn siblings (they name themselves from their own heading), and does not run the head
	it("registered routes build their title from the registry", () => {
		const files = routeFiles();
		const relByPath = new Map(
			files
				.filter((rel) => !LAYOUT_ROUTES.has(rel))
				.map((rel) => [authedPath(rel), rel] as const),
		);
		const routePaths = new Set(relByPath.keys());
		const registry = NAV_DESTINATIONS as readonly NavDestination[];
		const registered = registry.flatMap((d) => [
			d.to,
			...(d.alsoActiveOn ?? []),
		]);
		expect(
			unroutedPaths(registered, routePaths),
			"registered paths with no route file",
		).toEqual([]);
		const wrong = registry
			.map((d) => d.to as string)
			.filter((to) => {
				const rel = relByPath.get(to);
				// A public destination (`/resources`) is not an `_authed` page.
				if (!rel?.startsWith("_authed/")) return false;
				return !(rel && headSource(rel)?.includes(`navPageTitle("${to}"`));
			});
		expect(wrong, `routes not using navPageTitle: ${wrong.join(", ")}`).toEqual(
			[],
		);
	});

	// protects=the two checks above can fail: a robots-only head has no title, a JSX `title=` prop is not the head's, an unrouted registry path is flagged
	// fails_when=headExpression runs past the head property, or unroutedPaths stops flagging a missing route
	// no_claim=says nothing about real route files
	it("the guard's own helpers can fail", () => {
		const robotsOnly = `export const Route = createFileRoute("/x")({
	head: () => ({
		meta: [{ name: "robots", content: "noindex" }],
	}),
	component: () => <Card title="Roster" />,
});`;
		expect(headHasTitle(headExpression(robotsOnly))).toBe(false);
		const titled = robotsOnly.replace(
			'{ name: "robots"',
			'{ title: "T" }, { name: "robots"',
		);
		expect(headHasTitle(headExpression(titled))).toBe(true);
		expect(unroutedPaths(["/a", "/b"], new Set(["/a"]))).toEqual(["/b"]);
	});
});
