// Trademark guard for the MARKETING surfaces (#865; wording from #256 /
// ADR-0024): every anonymous, non-club page must show the Toastmasters
// International non-affiliation disclaimer.
//
// `src/routes/public-disclaimer.guard.test.ts` covers the public `club.*`
// routes and enrols only those. Before this file, `/` and `/resources/*` carried
// the disclaimer by convention alone, and a new marketing route would not have
// been enrolled anywhere. The rule here is structural: a route renders
// <MarketingShell> or <ResourcesShell> — both of which are pinned below to
// render the canonical constant — or it is named in EXEMPT with a reason.
//
// Source greps rather than render tests for the same reason as the club guard:
// what is protected is coverage of a route SET, including routes that do not
// exist yet. Every read is comment-blind (`#/test/guard-source`), so a comment
// that mentions `<MarketingShell` cannot stand in for the element.
import { readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ROUTES = resolve(ROOT, "src/routes");
const MARKETING_SHELL = "src/components/marketing/marketing-shell.tsx";
const RESOURCES_SHELL = "src/components/resources/resources-shell.tsx";

const read = (rel: string) => readSource(resolve(ROOT, rel));
const readRoute = (file: string) => readSource(resolve(ROUTES, file));

/**
 * Route files that legitimately render neither shell, each with the reason.
 * Adding an entry is a claim that the page does not need the marketing chrome;
 * make it only for a surface that is not a marketing page.
 */
const EXEMPT: Record<string, string> = {
	"__root.tsx": "the app shell (providers, <head>), not a page",
	"_authed.tsx": "the signed-in layout; <AppShell> carries the disclaimer",
	"signin.tsx": "conversion surface with its own chrome; out of scope for #865",
	"claim.tsx": "conversion surface with its own chrome; out of scope for #865",
	"oauth.consent.tsx":
		"transactional surface with its own chrome; out of scope for #865",
	"unsubscribe.tsx":
		"transactional surface with its own chrome; out of scope for #865",
	"[.]well-known.$.ts": "a server handler for discovery documents, not a page",
};

/**
 * Enrol by CONTENT: a file is a route iff it declares `export const Route =` at
 * the start of a line (what the TanStack generator keys on). Anchored so a test
 * file that merely contains the phrase inside a regex literal — this one, or
 * `public-disclaimer.guard.test.ts` — does not enrol.
 */
const exportsRoute = (file: string) =>
	/^export const Route\s*=/m.test(readRoute(file));

/**
 * Files DIRECTLY in `src/routes/` only: `_authed/` and `api/` are directories
 * and so drop out here, which is intended (signed-in pages and API handlers).
 */
const routeFiles = readdirSync(ROUTES)
	.filter((f) => statSync(resolve(ROUTES, f)).isFile())
	.filter((f) => /\.tsx?$/.test(f) && exportsRoute(f))
	.sort();

const enrolled = routeFiles.filter(
	(f) => !f.startsWith("club.") && !(f in EXEMPT),
);

describe("marketing surfaces carry the TI non-affiliation disclaimer (#865)", () => {
	it("MarketingShell renders the canonical constant, not inlined wording", () => {
		const src = read(MARKETING_SHELL);
		expect(src).toMatch(
			/import\s*\{[^}]*\bTOASTMASTERS_DISCLAIMER\b[^}]*\}\s*from\s*"#\/lib\/brand"/,
		);
		expect(src).toMatch(/\{TOASTMASTERS_DISCLAIMER\}/);
	});

	it("ResourcesShell renders the disclaimer on its anonymous branch", () => {
		const src = read(RESOURCES_SHELL);
		const close = src.indexOf("</AppShell>");
		expect(
			close,
			"ResourcesShell no longer has an <AppShell> branch to slice after",
		).toBeGreaterThan(-1);
		// The anonymous branch is the code AFTER the signed-in early return; the
		// signed-in branch gets the disclaimer from <AppShell> itself.
		expect(src.slice(close)).toMatch(/\{TOASTMASTERS_DISCLAIMER\}/);
	});

	it("finds the marketing routes (so a rename can't make this vacuous)", () => {
		expect(enrolled).toContain("index.tsx");
		expect(enrolled.some((f) => f.startsWith("resources."))).toBe(true);
	});

	it("every EXEMPT entry is a real route file (no stale exemptions)", () => {
		for (const file of Object.keys(EXEMPT)) {
			expect(routeFiles, `${file} is in EXEMPT but is not a route`).toContain(
				file,
			);
		}
	});

	for (const file of enrolled) {
		it(`${file} renders <MarketingShell> or <ResourcesShell>`, () => {
			expect(
				readRoute(file),
				`${file} is an anonymous, non-club route, so it must render ` +
					"<MarketingShell> (which carries the TI disclaimer) — or, if it " +
					"is genuinely not a marketing page, be added to EXEMPT with a reason.",
			).toMatch(/<(MarketingShell|ResourcesShell)\b/);
		});
	}

	// AC2 of #865: the marketing header/footer live in ONE file. A marketing
	// route that renders the shell and ALSO hand-rolls a <header>/<footer> is
	// the drift this extraction exists to end.
	for (const file of enrolled) {
		it(`${file} does not hand-roll its own <header>/<footer>`, () => {
			expect(readRoute(file)).not.toMatch(/<(header|footer)\b/);
		});
	}
});
